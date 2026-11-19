/**
 * Chat Window Peer & Multi-Window Resume Utilities
 * Tracks open window targets and persists multi-window pending resume markers.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { Logger } from './logger';
import { normalizeWorkspacePath, uriToFsPath } from './chat-wal.utils';

export interface PendingResumeData {
  reason: 'depleted' | 'manual';
  wasWorking: boolean;
  prompt: string;
  targetEmail: string;
  timestamp: number;
  conversationId?: string;
  workspace?: string;
}

export const RESUME_FILENAME = '.pending-chat-resume.json';
export const PEERS_FILENAME = '.window-peers.json';
export const RESUME_TTL_MS = 300_000;
export const PEER_TTL_MS = 90_000;

export class ChatPeerUtils {
  static windowTarget(): string | null {
    try {
      const workspaceFile = vscode.workspace.workspaceFile;
      if (workspaceFile && workspaceFile.scheme === 'file') return workspaceFile.fsPath;
      const folders = vscode.workspace.workspaceFolders;
      if (!folders || folders.length === 0) return null;
      if (folders[0].uri.scheme !== 'file') return null;
      return folders[0].uri.fsPath;
    } catch {
      return null;
    }
  }

  static registerWindowPeer(storageDir: string): void {
    const target = this.windowTarget();
    if (!target) return;
    try {
      if (!fs.existsSync(storageDir)) fs.mkdirSync(storageDir, { recursive: true });
      const peers = this.readWindowPeers(storageDir).filter(p => p.pid !== process.pid);
      peers.push({ target, pid: process.pid, updatedAt: Date.now() });
      fs.writeFileSync(
        path.join(storageDir, PEERS_FILENAME),
        JSON.stringify({ version: 1, peers }, null, 2),
        'utf-8'
      );
    } catch (err: any) {
      Logger.getInstance().debug('[ChatPeer] Could not register this window', err);
    }
  }

  static readWindowPeers(storageDir: string): Array<{ target: string; pid: number; updatedAt: number }> {
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(storageDir, PEERS_FILENAME), 'utf-8'));
      const list = Array.isArray(raw?.peers) ? raw.peers : [];
      const now = Date.now();
      return list.filter((p: any) =>
        p && typeof p.target === 'string' && p.target &&
        Number.isFinite(Number(p.updatedAt)) && now - Number(p.updatedAt) <= PEER_TTL_MS
      );
    } catch {
      return [];
    }
  }

  static collectWindowTargets(storageDir: string): string[] {
    const targets: string[] = [];
    const push = (value?: string | null) => {
      if (!value) return;
      try {
        if (!fs.existsSync(value)) return;
      } catch {
        return;
      }
      const normalized = normalizeWorkspacePath(value);
      if (targets.some(t => normalizeWorkspacePath(t) === normalized)) return;
      targets.push(value);
    };

    push(this.windowTarget());
    for (const peer of this.readWindowPeers(storageDir)) push(peer.target);

    if (targets.length <= 1) {
      for (const fallback of this.targetsFromStorageJson(storageDir)) push(fallback);
    }
    return targets;
  }

  private static targetsFromStorageJson(storageDir: string): string[] {
    const out: string[] = [];
    const addUri = (raw?: string) => {
      if (!raw) return;
      const asPath = uriToFsPath(raw);
      if (asPath) out.push(asPath);
      else if (/^[a-zA-Z]:[\\/]/.test(raw) || raw.startsWith('/')) out.push(raw);
    };
    try {
      const storagePath = path.join(storageDir, 'storage.json');
      if (!fs.existsSync(storagePath)) return out;
      const state = JSON.parse(fs.readFileSync(storagePath, 'utf-8'));
      for (const window of state?.windowsState?.openedWindows ?? []) {
        if (window?.folder) addUri(window.folder);
        else if (window?.workspace?.configURIPath) addUri(window.workspace.configURIPath);
      }
      for (const folder of state?.backupWorkspaces?.folders ?? []) addUri(folder?.folderUri);
      for (const workspace of state?.backupWorkspaces?.workspaces ?? []) addUri(workspace?.configURIPath);
    } catch {}
    return out;
  }

  static savePendingSessions(storageDir: string, sessions: PendingResumeData[]): void {
    try {
      const filePath = path.join(storageDir, RESUME_FILENAME);
      const clean = sessions.filter(s => s && typeof s === 'object');
      if (clean.length === 0) {
        try { fs.unlinkSync(filePath); } catch {}
        return;
      }
      if (!fs.existsSync(storageDir)) {
        fs.mkdirSync(storageDir, { recursive: true });
      }
      const tmpPath = `${filePath}.tmp`;
      fs.writeFileSync(tmpPath, JSON.stringify({ version: 2, sessions: clean }, null, 2), 'utf-8');
      fs.renameSync(tmpPath, filePath);
      Logger.getInstance().info(
        `[ChatPeer] Saved ${clean.length} pending resume session(s): ` +
        clean.map(s => `${path.basename(s.workspace || '?')}(wasWorking=${s.wasWorking}, conv=${s.conversationId || '-'})`).join(', ')
      );
    } catch (err: any) {
      Logger.getInstance().error('[ChatPeer] Failed to save pending resume markers', err);
    }
  }

  static readPendingSessions(storageDir: string): PendingResumeData[] {
    const filePath = path.join(storageDir, RESUME_FILENAME);
    try {
      if (!fs.existsSync(filePath)) return [];
      const parsed = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      const list: PendingResumeData[] = Array.isArray(parsed?.sessions)
        ? parsed.sessions
        : (parsed && typeof parsed === 'object' && 'reason' in parsed ? [parsed as PendingResumeData] : []);
      const now = Date.now();
      return list.filter(s => s && typeof s === 'object' && now - Number(s.timestamp || 0) <= RESUME_TTL_MS);
    } catch {
      return [];
    }
  }

  static claimPendingResumeForWorkspace(storageDir: string): PendingResumeData | null {
    const sessions = this.readPendingSessions(storageDir);
    if (sessions.length === 0) {
      try { fs.unlinkSync(path.join(storageDir, RESUME_FILENAME)); } catch {}
      return null;
    }

    const target = this.windowTarget();
    const normalizedTarget = target ? normalizeWorkspacePath(target) : null;
    let index = normalizedTarget
      ? sessions.findIndex(s => !!s.workspace && normalizeWorkspacePath(s.workspace) === normalizedTarget)
      : -1;

    if (index < 0 && sessions.length === 1 && !sessions[0].workspace) {
      index = 0;
    }

    this.savePendingSessions(storageDir, sessions.filter((_, i) => i !== index));
    if (index < 0) {
      Logger.getInstance().info(`[ChatPeer] No pending session for ${target || 'this window'}.`);
      return null;
    }
    Logger.getInstance().info(`[ChatPeer] Claimed pending session for ${target} (conv=${sessions[index].conversationId || '-'}).`);
    return sessions[index];
  }
}
