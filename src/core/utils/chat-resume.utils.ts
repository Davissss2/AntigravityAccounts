/**
 * Chat Resume Utilities
 *
 * Enables seamless AI workflow continuity when an account runs out of quota.
 * Restores chat sessions upon window relaunch and sends "continua" if interrupted by quota exhaustion.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { Logger } from './logger';
import { ExtensionConfig } from '../config/extension.config';
import {
  getDataRoots,
  normalizeWorkspacePath,
  getCurrentWorkspacePath,
  conversationBelongsToWorkspace,
  checkConversationExists
} from './chat-wal.utils';
import { inspectTranscriptTail, isRunStillOpen } from './chat-transcript.utils';
import {
  ChatPeerUtils,
  PendingResumeData
} from './chat-peer.utils';

export { PendingResumeData } from './chat-peer.utils';

export interface RecentChatActivityResult {
  wasWorking: boolean;
  isQuotaError: boolean;
  elapsedSec: number;
  conversationId?: string;
}

export class ChatResumeUtils {
  static isRunStillOpen = isRunStillOpen;
  static windowTarget = ChatPeerUtils.windowTarget.bind(ChatPeerUtils);
  static registerWindowPeer = ChatPeerUtils.registerWindowPeer.bind(ChatPeerUtils);
  static collectWindowTargets = ChatPeerUtils.collectWindowTargets.bind(ChatPeerUtils);
  static savePendingSessions = ChatPeerUtils.savePendingSessions.bind(ChatPeerUtils);
  static claimPendingResumeForWorkspace = ChatPeerUtils.claimPendingResumeForWorkspace.bind(ChatPeerUtils);

  static savePendingResume(storageDir: string, data: PendingResumeData): void {
    ChatPeerUtils.savePendingSessions(storageDir, [data]);
  }

  static getPendingResume(storageDir: string): PendingResumeData | null {
    const sessions = ChatPeerUtils.readPendingSessions(storageDir);
    return sessions.length > 0 ? sessions[0] : null;
  }

  static readAndClearPendingResume(storageDir: string): PendingResumeData | null {
    const session = ChatPeerUtils.claimPendingResumeForWorkspace(storageDir);
    if (!session) {
      Logger.getInstance().info('[ChatResume] No pending resume marker for this window.');
    }
    return session;
  }

  static detectRecentChatActivity(timeoutSec: number = 90, workspaceOverride?: string | null): RecentChatActivityResult {
    const empty: RecentChatActivityResult = { wasWorking: false, isQuotaError: false, elapsedSec: Infinity };
    try {
      const candidates: Array<{ mtime: number; id: string; transcript: string }> = [];

      for (const root of getDataRoots()) {
        const brainDir = path.join(root, 'brain');
        let entries: fs.Dirent[];
        try {
          entries = fs.readdirSync(brainDir, { withFileTypes: true });
        } catch {
          continue;
        }
        for (const entry of entries) {
          if (!entry.isDirectory() || entry.name === 'tempmediaStorage') continue;
          const transcriptPath = path.join(brainDir, entry.name, '.system_generated', 'logs', 'transcript.jsonl');
          try {
            const stat = fs.statSync(transcriptPath);
            candidates.push({ mtime: stat.mtimeMs, id: entry.name, transcript: transcriptPath });
          } catch {}
        }
      }

      if (candidates.length === 0) return empty;
      candidates.sort((a, b) => b.mtime - a.mtime);

      const explicit = workspaceOverride !== undefined && workspaceOverride !== null;
      const workspace = explicit ? normalizeWorkspacePath(workspaceOverride as string) : getCurrentWorkspacePath();
      const fresh = candidates.filter(c => Date.now() - c.mtime <= 45 * 60_000);
      const pool = fresh.length > 0 ? fresh : candidates;
      const chosen = (workspace && pool.find(c => conversationBelongsToWorkspace(c.id, workspace))) || pool[0];

      const latestMtime = chosen.mtime;
      const belongs = workspace ? conversationBelongsToWorkspace(chosen.id, workspace) : true;
      const latestConversationId: string | undefined = belongs ? chosen.id : undefined;

      if (!belongs) {
        Logger.getInstance().info(`[ChatResume] Newest conversation ${chosen.id} belongs to another workspace.`);
        if (explicit) return empty;
      }

      const now = Date.now();
      const elapsedSec = Math.max(0, Math.round((now - latestMtime) / 1000));
      const { isQuotaError, runStillOpen } = inspectTranscriptTail(chosen.transcript);

      const recentlyActive = now - latestMtime <= Math.max(10 * 60_000, timeoutSec * 1000);
      const wasWorking = isQuotaError || (runStillOpen && recentlyActive);

      Logger.getInstance().info(
        `[ChatResume] Detected AI chat activity: conversation=${latestConversationId}, elapsed=${elapsedSec}s, isQuotaError=${isQuotaError}, runStillOpen=${runStillOpen}, wasWorking=${wasWorking}`
      );

      return { wasWorking, isQuotaError, elapsedSec, conversationId: latestConversationId };
    } catch (err: any) {
      Logger.getInstance().debug('[ChatResume] Error detecting chat activity', err);
      return empty;
    }
  }

  static buildSessionsForOpenWindows(
    storageDir: string,
    options: { prompt: string; targetEmail: string; reason: 'depleted' | 'manual'; timeoutSec?: number }
  ): PendingResumeData[] {
    const targets = ChatPeerUtils.collectWindowTargets(storageDir);
    const now = Date.now();
    return targets.map(target => {
      const workspaceForChats = target.toLowerCase().endsWith('.code-workspace') ? path.dirname(target) : target;
      const activity = this.detectRecentChatActivity(options.timeoutSec ?? 90, workspaceForChats);
      const wasWorking = options.reason === 'depleted' && (activity.wasWorking || activity.isQuotaError);
      return {
        reason: options.reason,
        wasWorking,
        prompt: options.prompt,
        targetEmail: options.targetEmail,
        timestamp: now,
        conversationId: activity.conversationId,
        workspace: target
      };
    });
  }

  static activeConversationId(maxAgeMs: number = 45 * 60_000): string | undefined {
    try {
      const workspace = getCurrentWorkspacePath();
      const now = Date.now();
      const candidates: Array<{ id: string; live: number }> = [];

      for (const root of getDataRoots()) {
        const convDir = path.join(root, 'conversations');
        let entries: fs.Dirent[];
        try {
          entries = fs.readdirSync(convDir, { withFileTypes: true });
        } catch {
          continue;
        }
        for (const entry of entries) {
          if (!entry.isFile() || !entry.name.endsWith('.db')) continue;
          const id = entry.name.slice(0, -'.db'.length);
          if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) continue;

          let live = 0;
          for (const file of [path.join(convDir, entry.name), path.join(convDir, `${entry.name}-wal`)]) {
            try {
              live = Math.max(live, fs.statSync(file).mtimeMs);
            } catch {}
          }
          if (live > 0 && now - live <= maxAgeMs) {
            candidates.push({ id, live });
          }
        }
      }

      candidates.sort((a, b) => b.live - a.live);
      for (const candidate of candidates) {
        if (conversationBelongsToWorkspace(candidate.id, workspace ?? '')) {
          return candidate.id;
        }
      }
      return undefined;
    } catch {
      return undefined;
    }
  }

  static conversationExists(id?: string): boolean {
    return checkConversationExists(id);
  }

  private static async commandExists(id: string): Promise<boolean> {
    try {
      const commands = await vscode.commands.getCommands(true);
      return Array.isArray(commands) && commands.includes(id);
    } catch {
      return false;
    }
  }

  private static async runIfAvailable(id: string, ...args: unknown[]): Promise<boolean> {
    if (!(await this.commandExists(id))) {
      Logger.getInstance().warn(`[ChatResume] Command "${id}" is not registered in this Antigravity build; skipped.`);
      return false;
    }
    await vscode.commands.executeCommand(id, ...args);
    return true;
  }

  static async executePendingResume(data: PendingResumeData): Promise<void> {
    const config = ExtensionConfig.getInstance();
    if (!config.isAutoResumeChatEnabled()) {
      Logger.getInstance().info('[ChatResume] Auto-resume disabled by configuration; nothing to do.');
      return;
    }

    const wait = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

    try {
      const agy = vscode.extensions.getExtension('google.antigravity');
      if (agy && !agy.isActive) {
        await Promise.race([agy.activate(), wait(20000)]).catch(() => undefined);
      }
      await wait(4000);

      if (data.conversationId && this.conversationExists(data.conversationId)) {
        try {
          const opened = await this.runIfAvailable('antigravity.openConversation', data.conversationId);
          if (opened) {
            Logger.getInstance().info(`[ChatResume] Reopened conversation ${data.conversationId}.`);
          }
        } catch (openErr) {
          Logger.getInstance().warn('[ChatResume] antigravity.openConversation failed', openErr);
        }
        await wait(1500);
      } else {
        Logger.getInstance().info('[ChatResume] No verified conversation to reopen; keeping the panel as is.');
      }

      try {
        if (await this.runIfAvailable('antigravity.panel.focus')) {
          Logger.getInstance().info('[ChatResume] Agent panel focused.');
        }
      } catch (focusErr) {
        Logger.getInstance().debug('[ChatResume] antigravity.panel.focus failed', focusErr);
      }

      if (data.reason === 'depleted' && data.wasWorking && data.prompt) {
        await wait(1200);
        try {
          const wrote = await this.runIfAvailable('antigravity.addContext', data.prompt);
          await wait(800);
          const sent = wrote ? await this.runIfAvailable('antigravity.triggerSend') : false;
          if (sent) {
            Logger.getInstance().info(`[ChatResume] Wrote "${data.prompt}" and sent it to the interrupted agent.`);
          } else {
            Logger.getInstance().warn('[ChatResume] Could not resume the interrupted agent: chat commands unavailable.');
          }
        } catch (sendErr) {
          Logger.getInstance().warn('[ChatResume] Could not resume the interrupted agent', sendErr);
        }
      } else {
        Logger.getInstance().info(
          `[ChatResume] Conversation reopened without sending (reason=${data.reason}, wasWorking=${data.wasWorking}).`
        );
      }
    } catch (err: any) {
      Logger.getInstance().error('[ChatResume] Error executing pending chat resume', err);
    }
  }
}
