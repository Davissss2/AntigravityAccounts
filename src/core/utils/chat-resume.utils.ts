/**
 * Chat Resume Utilities
 *
 * Enables seamless AI workflow continuity when an account runs out of quota.
 * Detects whether the AI was actively working when depleted, persists a resume marker,
 * and automatically restores the chat session upon window relaunch, sending "continua"
 * ONLY if generation was interrupted by quota exhaustion.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as vscode from 'vscode';
import { Logger } from './logger';
import { ExtensionConfig } from '../config/extension.config';

export interface PendingResumeData {
  reason: 'depleted' | 'manual';
  wasWorking: boolean;
  prompt: string;
  targetEmail: string;
  timestamp: number;
  conversationId?: string;
}

export interface RecentChatActivityResult {
  wasWorking: boolean;
  isQuotaError: boolean;
  elapsedSec: number;
  conversationId?: string;
}

const RESUME_FILENAME = '.pending-chat-resume.json';

/**
 * Root folders where Antigravity keeps its agent data.
 *
 * Since 1.107 the agent hub stores everything under `~/.gemini/antigravity`
 * (`brain/` and `conversations/`). The `antigravity-ide` folder belongs to older
 * builds, where the editor drove the agent itself. Reading only the old path made
 * the resume pick a days-old conversation from a different workspace, and the
 * editor then reopened that chat instead of the one being written.
 */
function dataRoots(): string[] {
  const home = os.homedir();
  return ['antigravity', 'antigravity-ide']
    .map(name => path.join(home, '.gemini', name))
    .filter(dir => {
      try {
        return fs.statSync(dir).isDirectory();
      } catch {
        return false;
      }
    });
}

/** Lower-cased, slash-normalised path used to compare workspaces. */
function normalizePath(value: string): string {
  return value.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

/** `file:///c%3A/Users/...` -> `c:/users/...` */
function uriToPath(uri: string): string | null {
  const match = /^file:\/\/\/(.*)$/i.exec(uri);
  if (!match) return null;
  let decoded = match[1];
  try {
    decoded = decodeURIComponent(decoded);
  } catch {
    // keep the raw value
  }
  decoded = decoded.replace(/\\/g, '/').replace(/\/+$/, '');
  if (!decoded.includes(':')) decoded = `/${decoded}`; // unix absolute path
  return decoded.toLowerCase();
}

export class ChatResumeUtils {
  /**
   * Scans Antigravity's local brain directory to determine if the AI agent
   * was actively responding or interrupted by quota exhaustion.
   */
  static detectRecentChatActivity(timeoutSec: number = 90): RecentChatActivityResult {
    const empty: RecentChatActivityResult = { wasWorking: false, isQuotaError: false, elapsedSec: Infinity };
    try {
      const candidates: Array<{ mtime: number; id: string; transcript: string }> = [];

      for (const root of dataRoots()) {
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
          } catch {
            // conversation without transcript
          }
        }
      }

      if (candidates.length === 0) {
        return empty;
      }

      candidates.sort((a, b) => b.mtime - a.mtime);

      // Prefer the conversation of the workspace this window has open: the newest
      // transcript may belong to another window, and reopening that chat is what
      // made the switch jump into a conversation the user was not looking at.
      const workspace = this.currentWorkspacePath();
      const fresh = candidates.filter(c => Date.now() - c.mtime <= 45 * 60_000);
      const pool = fresh.length > 0 ? fresh : candidates;
      const chosen = (workspace && pool.find(c => this.belongsToWorkspace(c.id, workspace))) || pool[0];

      const latestMtime = chosen.mtime;
      const latestTranscriptPath: string = chosen.transcript;
      // Only carry the id when it really belongs to the folder this window has open.
      // Otherwise the resume would reopen a chat from another workspace, which looks
      // exactly like "it switched me into a conversation I was not in".
      const belongs = workspace ? this.belongsToWorkspace(chosen.id, workspace) : true;
      const latestConversationId: string | undefined = belongs ? chosen.id : undefined;
      if (!belongs) {
        Logger.getInstance().info(
          `[ChatResume] Newest conversation ${chosen.id} belongs to another workspace; it will not be reopened.`
        );
      }

      const now = Date.now();
      const elapsedSec = Math.max(0, Math.round((now - latestMtime) / 1000));

      // Inspect the tail of transcript.jsonl: was the run cut off, or had the agent
      // already finished? Recency cannot tell them apart (a chat that ended 20 seconds
      // ago looks identical to one interrupted 20 seconds ago), so the decision is made
      // from the shape of the last recorded step.
      let isQuotaError = false;
      let runStillOpen = false;
      try {
        const stat = fs.statSync(latestTranscriptPath);
        const bufferSize = Math.min(stat.size, 65536); // read last 64KB
        const fd = fs.openSync(latestTranscriptPath, 'r');
        const buffer = Buffer.alloc(bufferSize);
        fs.readSync(fd, buffer, 0, bufferSize, Math.max(0, stat.size - bufferSize));
        fs.closeSync(fd);

        const chunk = buffer.toString('utf-8');
        const lines = chunk.trim().split('\n').filter(Boolean);
        const tailLines = lines.slice(-20);

        const entries: any[] = [];
        for (const line of tailLines) {
          try {
            entries.push(JSON.parse(line));
          } catch {
            // A partially written last line is normal and must be ignored.
          }
        }

        const quotaKeywords = [
          '503',
          'unavailable',
          'resource_exhausted',
          'capacity',
          'quota',
          'rate limit',
          'rate_limit',
          'no capacity available'
        ];

        for (let i = entries.length - 1; i >= 0; i--) {
          const entry = entries[i];
          const content = String(entry.content || '').toLowerCase();
          const status = String(entry.status || '').toLowerCase();
          const type = String(entry.type || '').toUpperCase();

          if (type === 'ERROR_MESSAGE' || status === 'ERROR') {
            for (const kw of quotaKeywords) {
              if (content.includes(kw)) {
                isQuotaError = true;
                break;
              }
            }
          }
          if (!isQuotaError) {
            for (const kw of quotaKeywords) {
              if (
                content.includes(kw) &&
                (content.includes('error') ||
                  content.includes('code 503') ||
                  content.includes('capacity') ||
                  content.includes('exhausted') ||
                  content.includes('quota'))
              ) {
                isQuotaError = true;
                break;
              }
            }
          }
          if (isQuotaError) break;
        }

        runStillOpen = ChatResumeUtils.isRunStillOpen(entries);
      } catch (err: any) {
        Logger.getInstance().debug('[ChatResume] Error reading transcript tail', err);
      }

      // An open run only counts as an interruption when the transcript was touched
      // moments ago: an abandoned run from hours ago must never be resumed.
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

  /**
   * True when the last recorded step shows the agent had NOT finished.
   *
   * A completed turn always ends with the model's own answer: a PLANNER_RESPONSE that
   * carries text and has no pending tool call. Anything else means the turn was still
   * in flight when it was cut: a request with no answer yet, a tool result the model
   * never reacted to, or a planner step whose tools had not returned.
   *
   * This is what keeps an account switch from typing "continua" into a chat that had
   * already finished its work.
   */
  static isRunStillOpen(entries: any[]): boolean {
    if (!entries || entries.length === 0) return false;

    let last: any = null;
    for (let i = entries.length - 1; i >= 0; i--) {
      if (entries[i] && typeof entries[i] === 'object') {
        last = entries[i];
        break;
      }
    }
    if (!last) return false;

    const type = String(last.type || '').toUpperCase();
    const status = String(last.status || '').toUpperCase();
    const hasToolCalls = Array.isArray(last.tool_calls) && last.tool_calls.length > 0;
    const hasContent = String(last.content || '').trim().length > 0;

    if (['RUNNING', 'IN_PROGRESS', 'PENDING', 'QUEUED'].includes(status)) return true;
    if (type === 'ERROR_MESSAGE') return false; // an error is handled as an interruption
    if (type === 'USER_INPUT') return true;     // request accepted, the answer never started
    if (type === 'GENERIC' || type === 'TOOL_RESPONSE' || type === 'TOOL_CALL') return true;
    if (type === 'PLANNER_RESPONSE') return hasToolCalls;
    if (hasToolCalls) return true;
    return !hasContent;
  }

  /** Absolute path of the folder this window has open, if it is a real directory. */
  private static currentWorkspacePath(): string | null {
    try {
      const folders = vscode.workspace.workspaceFolders;
      if (!folders || folders.length === 0) return null;
      if (folders[0].uri.scheme !== 'file') return null;
      return normalizePath(folders[0].uri.fsPath);
    } catch {
      return null;
    }
  }

  /**
   * Workspace paths recorded inside a conversation, read straight from its SQLite
   * file (and its WAL, where the newest pages live). The hub keeps this metadata in
   * the conversation itself, so no extra process or library is needed.
   */
  private static conversationWorkspaces(conversationId: string): string[] {
    const found = new Set<string>();
    for (const root of dataRoots()) {
      const dbPath = path.join(root, 'conversations', `${conversationId}.db`);
      if (!fs.existsSync(dbPath)) continue;

      for (const file of [dbPath, `${dbPath}-wal`]) {
        try {
          const size = fs.statSync(file).size;
          if (size === 0) continue;
          const length = Math.min(size, 2 * 1024 * 1024);
          const buffer = Buffer.alloc(length);
          const fd = fs.openSync(file, 'r');
          fs.readSync(fd, buffer, 0, length, 0);
          fs.closeSync(fd);

          for (const match of buffer.toString('latin1').matchAll(/file:\/\/\/[A-Za-z0-9%._:\/\-]{3,200}/g)) {
            const parsed = uriToPath(match[0]);
            if (parsed) found.add(parsed);
          }
        } catch {
          // unreadable page: try the next file
        }
      }
    }
    return [...found];
  }

  /** True when the conversation was created in (or under) the given workspace. */
  private static belongsToWorkspace(conversationId: string, workspace: string): boolean {
    if (!workspace) return true;
    const paths = this.conversationWorkspaces(conversationId);
    if (paths.length === 0) return false; // unknown: do not force-open it
    return paths.some(p => p === workspace || p.startsWith(`${workspace}/`));
  }

  /**
   * Synchronously persists the pending resume state to disk so it survives window restarts.
   */
  static savePendingResume(storageDir: string, data: PendingResumeData): void {
    try {
      if (!fs.existsSync(storageDir)) {
        fs.mkdirSync(storageDir, { recursive: true });
      }
      const filePath = path.join(storageDir, RESUME_FILENAME);
      fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
      Logger.getInstance().info(
        `[ChatResume] Saved pending resume marker: reason=${data.reason}, wasWorking=${data.wasWorking}, prompt="${data.prompt}", convId=${data.conversationId}`
      );
    } catch (err: any) {
      Logger.getInstance().error('[ChatResume] Failed to save pending resume marker', err);
    }
  }

  /**
   * Retrieves the pending resume marker without deleting it.
   */
  static getPendingResume(storageDir: string): PendingResumeData | null {
    try {
      const filePath = path.join(storageDir, RESUME_FILENAME);
      if (!fs.existsSync(filePath)) return null;

      const content = fs.readFileSync(filePath, 'utf-8');
      const data = JSON.parse(content) as PendingResumeData;
      if (Date.now() - data.timestamp > 300_000) {
        return null;
      }
      return data;
    } catch {
      return null;
    }
  }

  /**
   * Reads and clears the pending resume marker from disk.
   */
  static readAndClearPendingResume(storageDir: string): PendingResumeData | null {
    try {
      const filePath = path.join(storageDir, RESUME_FILENAME);
      if (!fs.existsSync(filePath)) return null;

      const content = fs.readFileSync(filePath, 'utf-8');
      try {
        fs.unlinkSync(filePath);
      } catch {}

      const data = JSON.parse(content) as PendingResumeData;
      // Expire if older than 5 minutes
      if (Date.now() - data.timestamp > 300_000) {
        Logger.getInstance().info('[ChatResume] Discarding expired pending resume marker.');
        return null;
      }
      return data;
    } catch (err: any) {
      Logger.getInstance().debug('[ChatResume] Failed to read pending resume marker', err);
      return null;
    }
  }

  /**
   * Returns the conversation this window was working on, or undefined when it cannot
   * be established with confidence.
   *
   * Candidates are ranked by how recently the hub wrote them (database or WAL), and
   * only conversations touched in `maxAgeMs` and belonging to the current workspace
   * qualify. Returning undefined is a valid answer: the editor then restores its own
   * conversation instead of being pushed into someone else's chat.
   */
  static activeConversationId(maxAgeMs: number = 45 * 60_000): string | undefined {
    try {
      const workspace = this.currentWorkspacePath();
      const now = Date.now();
      const candidates: Array<{ id: string; live: number }> = [];

      for (const root of dataRoots()) {
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
            } catch {
              // file removed meanwhile
            }
          }
          if (live > 0 && now - live <= maxAgeMs) {
            candidates.push({ id, live });
          }
        }
      }

      candidates.sort((a, b) => b.live - a.live);
      for (const candidate of candidates) {
        if (this.belongsToWorkspace(candidate.id, workspace ?? '')) {
          return candidate.id;
        }
      }
      return undefined;
    } catch {
      return undefined;
    }
  }

  /** True when Antigravity still has data for that conversation. */
  static conversationExists(id?: string): boolean {
    if (!id || id === '_new') return false;
    try {
      return dataRoots().some(base =>
        fs.existsSync(path.join(base, 'brain', id))
        || fs.existsSync(path.join(base, 'conversations', `${id}.db`)));
    } catch {
      return false;
    }
  }

  /**
   * Executes the chat restore and resume logic after the window reloads.
   *
   * Antigravity 1.107 exposes real commands for this (verified in the installed
   * `agy` extension), unlike the ones used before:
   *   - `antigravity.openConversation(cascadeId)` → reopens that exact chat
   *   - `antigravity.panel.focus`                → brings the agent panel forward
   *   - `antigravity.triggerSend`                → sends whatever is in the input box
   */
  static async executePendingResume(data: PendingResumeData): Promise<void> {
    const config = ExtensionConfig.getInstance();
    if (!config.isAutoResumeChatEnabled()) {
      Logger.getInstance().info('[ChatResume] Auto-resume disabled by configuration; nothing to do.');
      return;
    }

    const wait = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

    try {
      // The agent panel lives in the bundled `google.antigravity` extension: wait for it.
      const agy = vscode.extensions.getExtension('google.antigravity');
      if (agy && !agy.isActive) {
        await Promise.race([agy.activate(), wait(20000)]).catch(() => undefined);
      }

      // Give the panel and language server time to mount before driving them.
      await wait(4000);

      if (data.conversationId && this.conversationExists(data.conversationId)) {
        try {
          await vscode.commands.executeCommand('antigravity.openConversation', data.conversationId);
          Logger.getInstance().info(`[ChatResume] Reopened conversation ${data.conversationId}.`);
        } catch (openErr) {
          Logger.getInstance().warn('[ChatResume] antigravity.openConversation failed', openErr);
        }
        await wait(1500);
      } else {
        // No verified conversation: leave whatever the editor restored by itself.
        Logger.getInstance().info('[ChatResume] No verified conversation to reopen; keeping the panel as is.');
      }

      try {
        await vscode.commands.executeCommand('antigravity.panel.focus');
        Logger.getInstance().info('[ChatResume] Agent panel focused.');
      } catch (focusErr) {
        Logger.getInstance().debug('[ChatResume] antigravity.panel.focus failed', focusErr);
      }

      // Only push the agent forward when it was actually interrupted mid-work by the
      // quota running out; a manual switch must never send anything on its own.
      if (data.reason === 'depleted' && data.wasWorking && data.prompt) {
        await wait(1200);
        try {
          // `antigravity.triggerSend` sends whatever sits in the composer, which is empty
          // after a restart, so pressing it alone did nothing. `antigravity.addContext`
          // is the command the agent itself uses to put text there: write it first.
          await vscode.commands.executeCommand('antigravity.addContext', data.prompt);
          await wait(800);
          await vscode.commands.executeCommand('antigravity.triggerSend');
          Logger.getInstance().info(`[ChatResume] Wrote "${data.prompt}" and sent it to the interrupted agent.`);
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
