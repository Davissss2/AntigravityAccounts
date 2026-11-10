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
  /**
   * Folder (or `.code-workspace` file) of the window this session belongs to.
   *
   * Antigravity keeps several windows open at once, and every switch restarts all of
   * them. Without this field the marker was a single record, so only one window could
   * claim it and the other ones came back empty.
   */
  workspace?: string;
}

export interface RecentChatActivityResult {
  wasWorking: boolean;
  isQuotaError: boolean;
  elapsedSec: number;
  conversationId?: string;
}

const RESUME_FILENAME = '.pending-chat-resume.json';
const PEERS_FILENAME = '.window-peers.json';
const RESUME_TTL_MS = 300_000;
/** A window refreshes its record every 30s; two missed beats and it is gone. */
const PEER_TTL_MS = 90_000;

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
   *
   * `workspaceOverride` restricts the search to that folder instead of the one this
   * window has open. That is what lets a switch capture the state of every open
   * window, not just the one that happened to trigger it.
   */
  static detectRecentChatActivity(timeoutSec: number = 90, workspaceOverride?: string | null): RecentChatActivityResult {
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
      const explicit = workspaceOverride !== undefined && workspaceOverride !== null;
      const workspace = explicit ? normalizePath(workspaceOverride as string) : this.currentWorkspacePath();
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
        // An explicit workspace with no chat of its own means this window had nothing
        // in flight: reporting someone else's activity would send "continua" into the
        // wrong chat once the window comes back.
        if (explicit) {
          return empty;
        }
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
    this.savePendingSessions(storageDir, [data]);
  }

  /**
   * Persists one session per open window.
   *
   * Every window restarts with the switch, so the marker has to describe all of them;
   * a single record could only ever be claimed once, which is why the other windows
   * came back without their chat.
   */
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
        `[ChatResume] Saved ${clean.length} pending resume session(s): `
        + clean.map(s => `${path.basename(s.workspace || '?')}(wasWorking=${s.wasWorking}, conv=${s.conversationId || '-'})`).join(', ')
      );
    } catch (err: any) {
      Logger.getInstance().error('[ChatResume] Failed to save pending resume markers', err);
    }
  }

  /** Reads the marker file, accepting both the multi-window and the old single record. */
  private static readPendingSessions(storageDir: string): PendingResumeData[] {
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

  /**
   * Takes the session that belongs to this window and leaves the rest on disk for the
   * other windows starting up next to it. Claiming is destructive on purpose: a window
   * must never resume a chat that another window is already driving.
   */
  static claimPendingResumeForWorkspace(storageDir: string): PendingResumeData | null {
    const sessions = this.readPendingSessions(storageDir);
    if (sessions.length === 0) {
      try { fs.unlinkSync(path.join(storageDir, RESUME_FILENAME)); } catch {}
      return null;
    }

    const target = this.windowTarget();
    const normalizedTarget = target ? normalizePath(target) : null;
    let index = normalizedTarget
      ? sessions.findIndex(s => !!s.workspace && normalizePath(s.workspace) === normalizedTarget)
      : -1;

    if (index < 0 && sessions.length === 1 && !sessions[0].workspace) {
      // Legacy marker written by an older build: it describes the window that
      // triggered the switch, and that is the only one that can claim it.
      index = 0;
    }

    this.savePendingSessions(storageDir, sessions.filter((_, i) => i !== index));
    if (index < 0) {
      Logger.getInstance().info(
        `[ChatResume] No pending session for ${target || 'this window'}; leaving it to the editor.`
      );
      return null;
    }
    Logger.getInstance().info(
      `[ChatResume] Claimed pending session for ${target} (conv=${sessions[index].conversationId || '-'}).`
    );
    return sessions[index];
  }

  /**
   * Retrieves the pending resume marker without deleting it.
   */
  static getPendingResume(storageDir: string): PendingResumeData | null {
    const sessions = this.readPendingSessions(storageDir);
    return sessions.length > 0 ? sessions[0] : null;
  }

  /**
   * Reads and clears the pending resume marker from disk.
   */
  static readAndClearPendingResume(storageDir: string): PendingResumeData | null {
    const session = this.claimPendingResumeForWorkspace(storageDir);
    if (!session) {
      Logger.getInstance().info('[ChatResume] No pending resume marker for this window.');
    }
    return session;
  }

  // ─── Open window registry ──────────────────────────────────────────────────
  //
  // Closing only the window that started the switch left the others running, so the
  // worker force-killed them and could not know what to reopen: Antigravity came back
  // as a single window. Each window now records the folder it has open, and the
  // worker replays that list with `--new-window`.

  /** Folder (or `.code-workspace` file) of this window, i.e. what to pass as an argument. */
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

  /** Records (or refreshes) this window so a switch can bring it back. */
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
      Logger.getInstance().debug('[ChatResume] Could not register this window', err);
    }
  }

  private static readWindowPeers(storageDir: string): Array<{ target: string; pid: number; updatedAt: number }> {
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(storageDir, PEERS_FILENAME), 'utf-8'));
      const list = Array.isArray(raw?.peers) ? raw.peers : [];
      const now = Date.now();
      return list.filter((p: any) =>
        p && typeof p.target === 'string' && p.target
        && Number.isFinite(Number(p.updatedAt)) && now - Number(p.updatedAt) <= PEER_TTL_MS);
    } catch {
      return [];
    }
  }

  /**
   * Folders that must come back after the restart, current window first.
   *
   * Live peers are the primary source. If this build has none (first switch after an
   * update), the window layout Antigravity persisted in `storage.json`
   * (`windowsState.openedWindows` / `backupWorkspaces`) is used instead.
   */
  static collectWindowTargets(storageDir: string): string[] {
    const targets: string[] = [];
    const push = (value?: string | null) => {
      if (!value) return;
      try {
        if (!fs.existsSync(value)) return;
      } catch {
        return;
      }
      const normalized = normalizePath(value);
      if (targets.some(t => normalizePath(t) === normalized)) return;
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
      const asPath = uriToPath(raw);
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
    } catch {
      // no usable layout on disk
    }
    return out;
  }

  /**
   * Builds the resume marker for every open window.
   *
   * Only a `depleted` switch may send a prompt, and only into a window whose chat was
   * actually interrupted: the other windows are reopened, they are not put back to work.
   */
  static buildSessionsForOpenWindows(
    storageDir: string,
    options: { prompt: string; targetEmail: string; reason: 'depleted' | 'manual'; timeoutSec?: number }
  ): PendingResumeData[] {
    const targets = this.collectWindowTargets(storageDir);
    const now = Date.now();
    return targets.map(target => {
      // A multi-root `.code-workspace` file never appears inside a conversation, so the
      // folder that contains it is what identifies the chats of that window.
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
   * True when the IDE actually exposes that command.
   *
   * A command declared in `contributes.commands` is not necessarily registered at
   * runtime: `antigravity.panel.focus` is declared by the bundled `agy` extension but
   * no file in the installed build registers it, so executing it only throws. Checking
   * first turns a silent no-op into a single clear log line.
   */
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

  /**
   * Executes the chat restore and resume logic after the window reloads.
   *
   * Commands verified against the installed 1.107 build (`extensions/agy/vscode/extension.js`):
   *   - `antigravity.openConversation(cascadeId, path)` → registered as
   *     `${naming.prefix}.openConversation`, focuses the chat and calls
   *     `api.openConversation({ cascadeId })`
   *   - `antigravity.addContext(...items)`            → registered; accepts plain strings
   *   - `antigravity.triggerSend()`                   → registered; sends the composer content
   *   - `antigravity.panel.focus`                     → declared but NOT registered
   *
   * `ensureMainInstance()` resolves to `this.mainViews[0]`, i.e. the chat view of ***this***
   * window's extension host, which is what allows several windows to each resume their
   * own conversation.
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
          const opened = await this.runIfAvailable('antigravity.openConversation', data.conversationId);
          if (opened) {
            Logger.getInstance().info(`[ChatResume] Reopened conversation ${data.conversationId}.`);
          }
        } catch (openErr) {
          Logger.getInstance().warn('[ChatResume] antigravity.openConversation failed', openErr);
        }
        await wait(1500);
      } else {
        // No verified conversation: leave whatever the editor restored by itself.
        Logger.getInstance().info('[ChatResume] No verified conversation to reopen; keeping the panel as is.');
      }

      // `openConversation` already focuses the chat view, so this is only a fallback for
      // builds that register the command (this one does not).
      try {
        if (await this.runIfAvailable('antigravity.panel.focus')) {
          Logger.getInstance().info('[ChatResume] Agent panel focused.');
        }
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
