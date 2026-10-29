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

export class ChatResumeUtils {
  /**
   * Scans Antigravity's local brain directory to determine if the AI agent
   * was actively responding or interrupted by quota exhaustion.
   */
  static detectRecentChatActivity(timeoutSec: number = 90): RecentChatActivityResult {
    try {
      const homeDir = os.homedir();
      const brainDir = path.join(homeDir, '.gemini', 'antigravity-ide', 'brain');
      if (!fs.existsSync(brainDir)) {
        return { wasWorking: false, isQuotaError: false, elapsedSec: Infinity };
      }

      const entries = fs.readdirSync(brainDir, { withFileTypes: true });
      let latestMtime = 0;
      let latestConversationId: string | undefined = undefined;
      let latestTranscriptPath: string | undefined = undefined;

      for (const entry of entries) {
        if (entry.isDirectory() && entry.name !== 'tempmediaStorage') {
          const transcriptPath = path.join(brainDir, entry.name, '.system_generated', 'logs', 'transcript.jsonl');
          if (fs.existsSync(transcriptPath)) {
            try {
              const stat = fs.statSync(transcriptPath);
              if (stat.mtimeMs > latestMtime) {
                latestMtime = stat.mtimeMs;
                latestConversationId = entry.name;
                latestTranscriptPath = transcriptPath;
              }
            } catch {
              // ignore access error
            }
          }
        }
      }

      if (latestMtime === 0 || !latestTranscriptPath) {
        return { wasWorking: false, isQuotaError: false, elapsedSec: Infinity };
      }

      const now = Date.now();
      const elapsedSec = Math.max(0, Math.round((now - latestMtime) / 1000));

      // Inspect the tail of transcript.jsonl to determine if generation stopped due to quota exhaustion
      let isQuotaError = false;
      try {
        const stat = fs.statSync(latestTranscriptPath);
        const bufferSize = Math.min(stat.size, 32768); // read last 32KB
        const fd = fs.openSync(latestTranscriptPath, 'r');
        const buffer = Buffer.alloc(bufferSize);
        fs.readSync(fd, buffer, 0, bufferSize, Math.max(0, stat.size - bufferSize));
        fs.closeSync(fd);

        const chunk = buffer.toString('utf-8');
        const lines = chunk.trim().split('\n').filter(Boolean);
        const tailLines = lines.slice(-20);

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

        for (let i = tailLines.length - 1; i >= 0; i--) {
          try {
            const entry = JSON.parse(tailLines[i]);
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
          } catch {
            // ignore partial JSON parse error
          }
        }
      } catch (err: any) {
        Logger.getInstance().debug('[ChatResume] Error reading transcript tail', err);
      }

      // wasWorking: true only if quota interruption occurred or AI was actively executing within threshold
      const wasWorking = isQuotaError || (elapsedSec <= timeoutSec && elapsedSec <= 45);

      Logger.getInstance().info(
        `[ChatResume] Detected AI chat activity: conversation=${latestConversationId}, elapsed=${elapsedSec}s, isQuotaError=${isQuotaError}, wasWorking=${wasWorking}`
      );

      return { wasWorking, isQuotaError, elapsedSec, conversationId: latestConversationId };
    } catch (err: any) {
      Logger.getInstance().debug('[ChatResume] Error detecting chat activity', err);
      return { wasWorking: false, isQuotaError: false, elapsedSec: Infinity };
    }
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
   * Returns the most recently modified conversation id found in Antigravity's brain
   * directory. Used as a fallback when the persisted layout index is empty.
   */
  static latestConversationId(): string | undefined {
    try {
      const brainDir = path.join(os.homedir(), '.gemini', 'antigravity-ide', 'brain');
      if (!fs.existsSync(brainDir)) return undefined;

      let latest = 0;
      let latestId: string | undefined;
      for (const entry of fs.readdirSync(brainDir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const dir = path.join(brainDir, entry.name);
        try {
          const mtime = fs.statSync(dir).mtimeMs;
          if (mtime > latest) {
            latest = mtime;
            latestId = entry.name;
          }
        } catch {
          // ignore unreadable entries
        }
      }
      return latestId;
    } catch {
      return undefined;
    }
  }

  /** True when Antigravity still has data for that conversation. */
  static conversationExists(id?: string): boolean {
    if (!id || id === '_new') return false;
    try {
      const base = path.join(os.homedir(), '.gemini', 'antigravity-ide');
      return fs.existsSync(path.join(base, 'brain', id))
        || fs.existsSync(path.join(base, 'conversations', `${id}.db`));
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
      await wait(3000);

      if (data.conversationId) {
        try {
          await vscode.commands.executeCommand('antigravity.openConversation', data.conversationId);
          Logger.getInstance().info(`[ChatResume] Reopened conversation ${data.conversationId}.`);
        } catch (openErr) {
          Logger.getInstance().warn('[ChatResume] antigravity.openConversation failed', openErr);
        }
        await wait(1500);
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
        await wait(1500);
        try {
          await vscode.commands.executeCommand('antigravity.triggerSend');
          Logger.getInstance().info(`[ChatResume] Sent "${data.prompt}" to resume the interrupted agent.`);
        } catch (sendErr) {
          Logger.getInstance().warn('[ChatResume] antigravity.triggerSend failed', sendErr);
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
