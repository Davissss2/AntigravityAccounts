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

export interface PendingResumeData {
  reason: 'depleted' | 'manual';
  wasWorking: boolean;
  prompt: string;
  targetEmail: string;
  timestamp: number;
  conversationId?: string;
}

const RESUME_FILENAME = '.pending-chat-resume.json';

export class ChatResumeUtils {
  /**
   * Scans Antigravity's local brain directory to determine if the AI agent
   * was actively responding or interacting in a chat within the last `timeoutSec` seconds.
   */
  static detectRecentChatActivity(timeoutSec: number = 90): { wasWorking: boolean; elapsedSec: number; conversationId?: string } {
    try {
      const homeDir = os.homedir();
      const brainDir = path.join(homeDir, '.gemini', 'antigravity-ide', 'brain');
      if (!fs.existsSync(brainDir)) {
        return { wasWorking: false, elapsedSec: Infinity };
      }

      const entries = fs.readdirSync(brainDir, { withFileTypes: true });
      let latestMtime = 0;
      let latestConversationId: string | undefined = undefined;

      for (const entry of entries) {
        if (entry.isDirectory() && entry.name !== 'tempmediaStorage') {
          const transcriptPath = path.join(brainDir, entry.name, '.system_generated', 'logs', 'transcript.jsonl');
          if (fs.existsSync(transcriptPath)) {
            try {
              const stat = fs.statSync(transcriptPath);
              if (stat.mtimeMs > latestMtime) {
                latestMtime = stat.mtimeMs;
                latestConversationId = entry.name;
              }
            } catch {
              // ignore access error
            }
          }
        }
      }

      if (latestMtime === 0) {
        return { wasWorking: false, elapsedSec: Infinity };
      }

      const now = Date.now();
      const elapsedSec = Math.max(0, Math.round((now - latestMtime) / 1000));
      const wasWorking = elapsedSec <= timeoutSec;

      Logger.getInstance().info(
        `[ChatResume] Detected AI chat activity: conversation=${latestConversationId}, elapsed=${elapsedSec}s, wasWorking=${wasWorking} (threshold=${timeoutSec}s)`
      );

      return { wasWorking, elapsedSec, conversationId: latestConversationId };
    } catch (err: any) {
      Logger.getInstance().debug('[ChatResume] Error detecting chat activity', err);
      return { wasWorking: false, elapsedSec: Infinity };
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
      Logger.getInstance().info(`[ChatResume] Saved pending resume marker: wasWorking=${data.wasWorking}, prompt="${data.prompt}"`);
    } catch (err: any) {
      Logger.getInstance().error('[ChatResume] Failed to save pending resume marker', err);
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
      try { fs.unlinkSync(filePath); } catch {}

      const data = JSON.parse(content) as PendingResumeData;
      // Expire if older than 3 minutes
      if (Date.now() - data.timestamp > 180_000) {
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
   * Executes the chat restore and resume logic after window reload.
   */
  static async executePendingResume(data: PendingResumeData): Promise<void> {
    try {
      Logger.getInstance().info(`[ChatResume] Restoring chat session: wasWorking=${data.wasWorking}, prompt="${data.prompt}"`);

      // 1. Give Antigravity workbench time to fully initialize
      await new Promise(r => setTimeout(r, 1800));

      // 2. Open / focus the chat panel
      // Try Antigravity specific chat command first, fallback to standard VS Code chat open
      try {
        await vscode.commands.executeCommand('antigravity.prioritized.chat.open');
      } catch {
        try {
          await vscode.commands.executeCommand('workbench.action.chat.open');
        } catch {
          // ignore
        }
      }

      // 3. If the AI was actively working and stopped due to quota, send the resume prompt
      if (data.wasWorking && data.prompt) {
        await new Promise(r => setTimeout(r, 1200));

        // Attempt direct submission via workbench.action.chat.open with query
        try {
          await vscode.commands.executeCommand('workbench.action.chat.open', {
            query: data.prompt
          });
          Logger.getInstance().info(`[ChatResume] Sent resume query "${data.prompt}" to chat successfully.`);
        } catch (openErr) {
          Logger.getInstance().warn('[ChatResume] Could not pass query to chat directly', openErr);
        }
      } else {
        Logger.getInstance().info('[ChatResume] Chat opened without sending prompt (AI was idle before switch).');
      }
    } catch (err: any) {
      Logger.getInstance().error('[ChatResume] Error executing pending chat resume', err);
    }
  }
}
