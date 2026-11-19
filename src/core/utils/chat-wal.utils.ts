/**
 * Chat WAL & SQLite Utilities
 * Scans conversation SQLite databases and WAL files for workspace associations and candidate sessions.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as vscode from 'vscode';

export function getDataRoots(): string[] {
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

export function normalizeWorkspacePath(value: string): string {
  return value.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

export function uriToFsPath(uri: string): string | null {
  const match = /^file:\/\/\/(.*)$/i.exec(uri);
  if (!match) return null;
  let decoded = match[1];
  try {
    decoded = decodeURIComponent(decoded);
  } catch {}
  decoded = decoded.replace(/\\/g, '/').replace(/\/+$/, '');
  if (!decoded.includes(':')) decoded = `/${decoded}`;
  return decoded.toLowerCase();
}

export function getCurrentWorkspacePath(): string | null {
  try {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length === 0) return null;
    if (folders[0].uri.scheme !== 'file') return null;
    return normalizeWorkspacePath(folders[0].uri.fsPath);
  } catch {
    return null;
  }
}

export function getConversationWorkspaces(conversationId: string): string[] {
  const found = new Set<string>();
  for (const root of getDataRoots()) {
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
          const parsed = uriToFsPath(match[0]);
          if (parsed) found.add(parsed);
        }
      } catch {}
    }
  }
  return [...found];
}

export function conversationBelongsToWorkspace(conversationId: string, workspace: string): boolean {
  if (!workspace) return true;
  const paths = getConversationWorkspaces(conversationId);
  if (paths.length === 0) return false;
  return paths.some(p => p === workspace || p.startsWith(`${workspace}/`));
}

export function checkConversationExists(id?: string): boolean {
  if (!id || id === '_new') return false;
  try {
    return getDataRoots().some(base =>
      fs.existsSync(path.join(base, 'brain', id)) ||
      fs.existsSync(path.join(base, 'conversations', `${id}.db`))
    );
  } catch {
    return false;
  }
}
