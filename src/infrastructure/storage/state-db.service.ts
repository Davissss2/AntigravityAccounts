/**
 * State Database Service
 * 
 * Injects Protobuf-encoded OAuth tokens into the Antigravity state.vscdb
 * SQLite database to perform seamless account switching.
 * 
 * KEY DESIGN: Antigravity caches state.vscdb in memory and overwrites
 * the file on shutdown. Direct file writes while Antigravity is running
 * are always lost. Therefore we:
 *   1. Spawn a detached "inject-worker" process
 *   2. Close the Antigravity window (which triggers its flush)
 *   3. The worker waits for the file to stabilize, then overwrites it
 *   4. Antigravity relaunches and reads the new data
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { spawn, execSync } from 'child_process';
import { Logger } from '../../core/utils/logger';
import { I18nService } from '../../i18n/i18n.service';
import { ExtensionConfig } from '../../core/config/extension.config';
import { PathUtils } from '../../core/utils/path.utils';
import { ProtobufUtils } from '../../core/utils/protobuf.utils';
import { Account, AccountTokens } from '../../core/domain/models/account.model';
import { DeviceProfile } from '../../core/domain/models/device-profile.model';
import { STATE_DB_KEYS, STORAGE_JSON_KEYS, PERSONAL_EMAIL_DOMAINS } from '../../core/constants/app.constants';
import { getAntigravityVersion, isVersionSupported, MIN_SUPPORTED_VERSION } from '../../core/utils/version.utils';
import { ChatResumeUtils } from '../../core/utils/chat-resume.utils';

export class StateDbService {
  private static sqlJsPromise: Promise<any> | null = null;

  private async getSqlJs(): Promise<any> {
    if (!StateDbService.sqlJsPromise) {
      let initSqlJs: any;
      try {
        initSqlJs = require('sql.js');
      } catch (e1) {
        try {
          const localDistJs = path.join(__dirname, 'sql-wasm.js');
          if (fs.existsSync(localDistJs)) {
            initSqlJs = require(localDistJs);
          } else {
            const rootDistJs = path.join(__dirname, '..', 'dist', 'sql-wasm.js');
            initSqlJs = require(rootDistJs);
          }
        } catch {
          throw e1;
        }
      }

      const wasmCandidates = [
        path.join(__dirname, 'sql-wasm.wasm'),
        path.join(__dirname, '..', 'dist', 'sql-wasm.wasm'),
        path.join(path.dirname(__dirname), 'dist', 'sql-wasm.wasm'),
      ];
      const foundWasm = wasmCandidates.find(p => fs.existsSync(p));

      if (foundWasm) {
        StateDbService.sqlJsPromise = initSqlJs({
          locateFile: () => foundWasm
        });
      } else {
        StateDbService.sqlJsPromise = initSqlJs();
      }
    }
    return StateDbService.sqlJsPromise;
  }

  public preload(): void {
    this.getSqlJs().catch(() => {});
  }

  constructor(private readonly context?: vscode.ExtensionContext) { }

  // ─── Main Injection Orchestrator ─────────────────────────────────────────────

  async injectAccountState(
    account: Account,
    tokens: AccountTokens,
    deviceProfile?: DeviceProfile | null,
    skipPrompt: boolean = false,
    reason: 'depleted' | 'manual' = 'manual'
  ): Promise<'success' | 'cancelled' | 'error'> {
    const versionCheckResult = this.checkAntigravityVersion();
    if (versionCheckResult === 'unsupported') {
      const i18n = I18nService.getInstance();
      vscode.window.showErrorMessage(
        i18n.t('stateDb.outdatedAntigravity', { minVersion: MIN_SUPPORTED_VERSION }),
        { modal: true }
      );
      return 'error';
    }

    const dbPath = PathUtils.getVscdbPath(this.context);
    if (!fs.existsSync(dbPath)) {
      const i18n = I18nService.getInstance();
      Logger.getInstance().error(`State database not found at ${dbPath}`);
      vscode.window.showErrorMessage(
        i18n.t('stateDb.dbNotFound')
      );
      return 'error';
    }

    try {
      // ── Step 1: Rolling Backup ──
      this.performRollingBackup(dbPath);

      // ── Step 2: Write device profile to storage.json ──
      if (deviceProfile) {
        this.writeDeviceProfileToStorageJson(deviceProfile);
      }

      // ── Step 3: Build payloads ──
      const isGcpTos = this.shouldEnableGcpTos(account.email);

      const oauthToken = ProtobufUtils.createUnifiedOAuthToken(
        tokens.accessToken, tokens.refreshToken, tokens.expiresAt,
        isGcpTos, undefined, account.email
      );

      const userStatusPayload = ProtobufUtils.createMinimalUserStatusPayload(account.email);
      const userStatus = ProtobufUtils.createUnifiedStateEntry('userStatusSentinelKey', userStatusPayload);

      const enterpriseEntry = account.projectId
        ? ProtobufUtils.createUnifiedStateEntry(
          'enterpriseGcpProjectId',
          ProtobufUtils.createStringValuePayload(account.projectId))
        : undefined;

      // Build the row list for the worker
      const rows: Array<{ key: string; value: string | null }> = [
        { key: STATE_DB_KEYS.OAUTH_TOKEN, value: oauthToken },
        { key: STATE_DB_KEYS.USER_STATUS, value: userStatus },
        { key: STATE_DB_KEYS.ONBOARDING, value: 'true' },
        { key: STATE_DB_KEYS.LEGACY, value: null }, // delete
      ];
      if (enterpriseEntry) {
        rows.push({ key: STATE_DB_KEYS.ENTERPRISE_PREFS, value: enterpriseEntry });
      }

      // Keep Antigravity's own state aligned with the account being injected: the
      // Settings label and the conversation the agent panel reopens on startup.
      // With several windows open the layout index is shared state, so it must be left
      // untouched: each window reopens its own chat through `openConversation` instead.
      const openTargetCount = ChatResumeUtils.collectWindowTargets(
        PathUtils.getAntigravityDataPath(this.context)
      ).length;
      const agyStateRow = await this.buildAgyGlobalStateRow(account.email, isGcpTos, openTargetCount <= 1);
      if (agyStateRow) {
        rows.push(agyStateRow);
      }
      // Since Antigravity 1.107 the agent (agy.exe --hub) authenticates with the
      // Windows generic credential "gemini:antigravity" (a plain-JSON token blob in
      // the OS vault). state.vscdb no longer drives the chat session, so writing only
      // the database left the panel on the new account while the agent kept consuming
      // the previous one. This payload is handed to the worker, which persists it.
      const credentialPayload = {
        token: {
          access_token: tokens.accessToken,
          token_type: 'Bearer',
          refresh_token: tokens.refreshToken,
          expiry: this.formatCredentialExpiry(tokens.expiresAt),
          expires_in: 3599
        },
        auth_method: 'consumer',
        id_token_email: account.email
      };

      if (deviceProfile) {
        // Inject ALL telemetry fingerprint keys to prevent cross-account correlation.
        // Without this, shared values (e.g. firstSessionDate, storage.serviceMachineId)
        // allow Google to link multiple accounts to the same physical device.
        rows.push({ key: STATE_DB_KEYS.TELEMETRY_SERVICE_MACHINE_ID, value: deviceProfile.macMachineId });
        rows.push({ key: STATE_DB_KEYS.STORAGE_SERVICE_MACHINE_ID, value: deviceProfile.devDeviceId });
        rows.push({ key: STATE_DB_KEYS.TELEMETRY_FIRST_SESSION_DATE, value: deviceProfile.firstSessionDate });
        // Reset current/last session dates to "now" so each switch looks like a fresh session
        const nowUtc = new Date().toUTCString();
        rows.push({ key: STATE_DB_KEYS.TELEMETRY_CURRENT_SESSION_DATE, value: nowUtc });
        rows.push({ key: STATE_DB_KEYS.TELEMETRY_LAST_SESSION_DATE, value: nowUtc });
      }

      // ── Step 4: Spawn background worker + close window ──
      const triggered = await this.triggerWorkerAndClose(account.email, dbPath, rows, deviceProfile, skipPrompt, credentialPayload, reason);
      return triggered ? 'success' : 'cancelled';

    } catch (error: any) {
      const i18n = I18nService.getInstance();
      Logger.getInstance().error('Failed to inject state into state.vscdb', error);
      vscode.window.showErrorMessage(
        i18n.t('stateDb.injectionFailed', { error: error.message })
      );
      return 'error';
    }
  }

  /**
   * Builds the row that patches the bundled `agy` extension's globalState.
   *
   * Two things live there and both must follow a switch:
   *  1. `agy.onboarding.lastLoginUsername` — the label Antigravity Settings prints as
   *     the account email. Leaving it untouched made a good switch look like a no-op.
   *  2. `antigravity-multi-conversation-layout-v3-index` — the list of conversation
   *     groups the agent panel reopens on startup. It is empty after a switch, which is
   *     why the chat you were writing in disappeared. Pointing it back at that cascade
   *     reopens the same conversation (and its persisted draft).
   *
   * The blob is read, patched and written back as a whole JSON string, so the worker
   * stays dumb and only writes rows.
   */
  private async buildAgyGlobalStateRow(
    email: string,
    isGcpTos: boolean,
    allowLayoutIndex: boolean = true
  ): Promise<{ key: string; value: string | null } | null> {
    const storageKey = STATE_DB_KEYS.AGY_GLOBAL_STATE;

    const raw = await this.readConsistentSnapshot<string | null>((db) => {
      const stmt = db.prepare('SELECT value FROM ItemTable WHERE key = $key');
      try {
        stmt.bind({ $key: storageKey });
        if (!stmt.step()) return null;
        return (stmt.get()[0] as string) ?? null;
      } finally {
        stmt.free();
      }
    }, (value) => !!value);

    if (!raw) return null;

    try {
      const outer = JSON.parse(raw) as Record<string, any>;
      const storageRaw = outer['antigravity-storage'];
      const storage = typeof storageRaw === 'string' ? JSON.parse(storageRaw) : storageRaw;
      if (!storage || typeof storage !== 'object') return null;

      storage['agy.onboarding.lastLoginUsername'] = email;
      storage['agy.onboarding.lastLoginIsGcpTos'] = String(isGcpTos);

      // ── Reopen the conversation that was active before the switch ──
      const indexKey = 'antigravity-multi-conversation-layout-v3-index';
      const layoutPrefix = 'antigravity-multi-conversation-layout-v3-';
      let conversationId: string | undefined;

      if (!allowLayoutIndex) {
        // Several windows share this index, so pointing it at one conversation would
        // make every window open that same chat. Each of them reopens its own through
        // `antigravity.openConversation` once it is up.
        Logger.getInstance().info(
          '[ChatResume] Multiple windows open: leaving the shared layout index untouched.'
        );
        outer['antigravity-storage'] = typeof storageRaw === 'string' ? JSON.stringify(storage) : storage;
        return { key: storageKey, value: JSON.stringify(outer) };
      }

      try {
        const parsedIndex = JSON.parse(String(storage[indexKey] ?? '[]'));
        if (Array.isArray(parsedIndex) && parsedIndex.length > 0) {
          const group = parsedIndex[parsedIndex.length - 1];
          if (Array.isArray(group) && group.length > 0) {
            conversationId = String(group[group.length - 1]);
          }
        }
      } catch { /* fall back to the newest conversation below */ }

      if (!ChatResumeUtils.conversationExists(conversationId)) {
        // The panel's own index is empty, so fall back to the conversation this window
        // was working on. It is restricted to the current workspace and returns
        // undefined when that cannot be established, in which case we leave the index
        // alone and let the editor restore its own conversation.
        conversationId = ChatResumeUtils.activeConversationId();
      }

      if (ChatResumeUtils.conversationExists(conversationId)) {
        const layoutKey = `${layoutPrefix}${conversationId}`;
        if (!storage[layoutKey]) {
          storage[layoutKey] = JSON.stringify({
            rootNode: { type: 'pane', id: 'pane-1', cascadeId: conversationId },
            focusedPaneId: 'pane-1'
          });
        }
        storage[indexKey] = JSON.stringify([[conversationId]]);
        Logger.getInstance().info(`[ChatResume] Conversation ${conversationId} will be reopened after the switch.`);
      }

      outer['antigravity-storage'] = typeof storageRaw === 'string' ? JSON.stringify(storage) : storage;

      Logger.getInstance().info(`Synced Antigravity login label to ${email}.`);
      return { key: storageKey, value: JSON.stringify(outer) };
    } catch (error) {
      Logger.getInstance().warn('Could not patch the Antigravity global state', error);
      return null;
    }
  }

  /**
   * Formats an expiry exactly the way the agent stores it: ISO-8601 with seven
   * fractional digits and a numeric offset (e.g. `2026-10-28T14:15:22.3827820+01:00`).
   * A different shape makes the hub treat the credential as unusable.
   */
  private formatCredentialExpiry(expiresAtSeconds?: number): string {
    const date = new Date(((expiresAtSeconds || Math.floor(Date.now() / 1000) + 3599) * 1000));
    const pad = (n: number, size: number = 2) => String(n).padStart(size, '0');
    const offsetMinutes = -date.getTimezoneOffset();
    const sign = offsetMinutes >= 0 ? '+' : '-';
    const abs = Math.abs(offsetMinutes);
    const millis = date.getMilliseconds();
    const micros = `${pad(millis, 3)}0000`;
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T`
      + `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${micros}`
      + `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
  }

  // ─── Worker-based injection ─────────────────────────────────────────────────

  private async triggerWorkerAndClose(
    email: string,
    dbPath: string,
    rows: Array<{ key: string; value: string | null }>,
    deviceProfile?: DeviceProfile | null,
    skipPrompt: boolean = false,
    credentialPayload?: Record<string, any> | null,
    reason: 'depleted' | 'manual' = 'manual'
  ): Promise<boolean> {
    const config = ExtensionConfig.getInstance();
    const shouldPrompt = !skipPrompt && config.isConfirmOnSwitchEnabled();

    if (shouldPrompt) {
      const i18n = I18nService.getInstance();
      const actionYes = i18n.t('switchPrompt.actionYes');
      const actionNo = i18n.t('switchPrompt.actionNo');

      const choice = await vscode.window.showInformationMessage(
        i18n.t('switchPrompt.title', { email }),
        {
          modal: true,
          detail: i18n.t('stateDb.reloadPrompt'),
        },
        actionYes,
        actionNo
      );

      if (choice !== actionYes) {
        Logger.getInstance().info('User cancelled account switch.');
        return false;
      }
    } else {
      Logger.getInstance().info(`Auto-switching to ${email} (immediate automatic reload)...`);
    }

    // Save open files before closing
    try {
      const filesConfig = vscode.workspace.getConfiguration('files');
      await vscode.workspace.saveAll(filesConfig.get<string>('autoSave') === 'off');
    } catch (e) { /* best effort */ }

    // Antigravity runs several windows at once (one per project). All of them are
    // restarted by the switch, so the resume marker is written per window and the
    // worker relaunches every folder with `--new-window` instead of a single window.
    const storageDir = PathUtils.getAntigravityDataPath(this.context);
    let openTargets: string[] = [];
    try {
      openTargets = ChatResumeUtils.collectWindowTargets(storageDir);
      if (config.isAutoResumeChatEnabled()) {
        ChatResumeUtils.savePendingSessions(
          storageDir,
          ChatResumeUtils.buildSessionsForOpenWindows(storageDir, {
            prompt: config.getAutoResumePrompt(),
            targetEmail: email,
            reason,
            timeoutSec: config.getAutoResumeTimeoutSeconds()
          })
        );
      }
      Logger.getInstance().info(
        `[Auto-Switch] Windows to restore (${openTargets.length}): ${openTargets.join(' | ')}`
      );
    } catch (resumeErr: any) {
      Logger.getInstance().warn('[Auto-Switch] Could not prepare the multi-window resume', resumeErr);
    }

    const antigravityExe = this.findAntigravityExe();
    // process.execPath inside Antigravity IS the Antigravity binary itself
    const currentExePath = process.execPath;
    const workDir = __dirname;
    const payloadPath = path.join(workDir, '.inject-payload.json');
    const workerPath = path.join(workDir, '.inject-worker.js');

    // Collect all candidate exe paths for relaunch (deduplicated).
    //
    // The running binary must win. With two side-by-side installs (a portable copy under
    // ~/Descargas plus the distro package in /usr/share) the fallback list can point at
    // the other one, and restarting it leaves the user looking at an app whose process
    // was never asked to reload anything — the switch looks like a no-op.
    const exeCandidates: string[] = [];
    if (currentExePath && fs.existsSync(currentExePath)) exeCandidates.push(currentExePath);
    if (antigravityExe && !exeCandidates.includes(antigravityExe)) exeCandidates.push(antigravityExe);

    const payloadObj = {
      dbPath,
      rows,
      exeCandidates,
      storageJsonPath: PathUtils.getStorageJsonPath(this.context),
      deviceProfile,
      credentialPayload,
      openTargets
    };

    // An extension update can replace this folder while the host is still running,
    // leaving __dirname pointing at a directory that no longer exists (ENOENT).
    try {
      fs.writeFileSync(payloadPath, JSON.stringify(payloadObj, null, 2), 'utf-8');
      fs.writeFileSync(workerPath, this.getWorkerScript(), 'utf-8');
    } catch (writeErr: any) {
      throw new Error(
        `Cannot write the injection payload into ${workDir}. Reload the window so the updated build is loaded and try again. (${writeErr?.code || writeErr?.message})`
      );
    }
    Logger.getInstance().info(`Spawning inject-worker. Payload: ${payloadPath}, candidates: ${exeCandidates.join(', ')}`);

    // CRITICAL: process.execPath inside Antigravity IS the Antigravity.exe (Electron binary).
    // Without ELECTRON_RUN_AS_NODE=1, it will try to open the worker script as a
    // workspace/file instead of executing it as Node.js. This env var tells Electron
    // to behave as a plain Node.js runtime.
    const workerEnv = { ...process.env, ELECTRON_RUN_AS_NODE: '1' };

    // Spawn detached worker — survives after this process closes
    const child = spawn(process.execPath, [workerPath, payloadPath], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      cwd: workDir,
      env: workerEnv,
    });
    child.unref();

    Logger.getInstance().info(`Worker spawned (PID ${child.pid}). Closing every window...`);

    // Close ALL windows, not just this one: the worker cannot inject while another
    // window keeps writing state.vscdb, and a clean quit is what makes Antigravity
    // persist each window's folder so the worker can bring them all back.
    vscode.commands.executeCommand('workbench.action.quit');
    return true;
  }

  /**
   * Returns the worker script that runs AFTER Antigravity has fully exited.
   *
   * Flow:
   *   1. Polls for any running Antigravity.exe processes (excluding own PID)
   *   2. Waits until none remain (meaning the flush completed)
   *   3. Waits a safety margin for OS file lock release
   *   4. Injects new data into state.vscdb
   *   5. Relaunches Antigravity
   */
  private getWorkerScript(): string {
    return `
const fs = require('fs');
const path = require('path');
const { execSync, spawn } = require('child_process');

const LOG_PATH = process.argv[2] + '.worker.log';
function log(msg) {
  const line = new Date().toISOString() + ' ' + msg;
  try { fs.appendFileSync(LOG_PATH, line + '\\n'); } catch {}
}

const payloadPath = process.argv[2];
if (!payloadPath || !fs.existsSync(payloadPath)) {
  log('No payload file found at: ' + process.argv[2]);
  process.exit(1);
}

const payload = JSON.parse(fs.readFileSync(payloadPath, 'utf-8'));
const { dbPath, rows, exeCandidates } = payload;
// One entry per window that was open before the switch. Antigravity only restores the
// session when it is started with no arguments, and that produced a single window, so
// every folder is replayed explicitly: the first one plain, the rest with --new-window
// (verified in this build's out/main.js: getPathsToOpen only restores the last session
// when no uri/--new-window argument is given).
const openTargets = Array.isArray(payload.openTargets) ? payload.openTargets.filter(Boolean) : [];
const ownPid = process.pid;

log('Worker started. Own PID: ' + ownPid);
log('DB Path: ' + dbPath);
log('Exe candidates: ' + JSON.stringify(exeCandidates));
log('ELECTRON_RUN_AS_NODE: ' + process.env.ELECTRON_RUN_AS_NODE);
log('Platform: ' + process.platform + ' ' + process.arch + ' | execPath: ' + process.execPath);
log('Windows to reopen: ' + JSON.stringify(openTargets));

// ── Helper: check if any IDE processes are running (excluding self) ──
function getOtherAntigravityPids() {
  const pids = [];
  try {
    const exeName = path.basename(process.execPath);
    if (process.platform === 'win32') {
      const out = execSync('tasklist /FI "IMAGENAME eq ' + exeName + '" /FO CSV /NH', {
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      for (const line of out.split(String.fromCharCode(10))) {
        const parts = line.split(',');
        if (parts.length > 1) {
          const namePart = parts[0].replace(/"/g, '').trim();
          const pidPart = parts[1].replace(/"/g, '').trim();
          if (namePart.toLowerCase() === exeName.toLowerCase()) {
            const pid = parseInt(pidPart, 10);
            if (pid && pid !== ownPid) pids.push(pid);
          }
        }
      }
    } else {
      // Linux & macOS: standard ps check
      const out = execSync('ps -ax -o pid,comm', {
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      for (const line of out.split(String.fromCharCode(10))) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        const parts = trimmed.split(/\\s+/);
        if (parts.length >= 2) {
          const pid = parseInt(parts[0], 10);
          const comm = parts.slice(1).join(' ').toLowerCase();
          const exeLower = exeName.toLowerCase();
          const isGenericRuntime = (exeLower === 'node' || exeLower === 'sh' || exeLower === 'bash');
          const isAntigravity = comm.includes('antigravity');
          const isExeMatch = !isGenericRuntime && (comm.includes(exeLower) || exeLower.includes(comm));
          if ((isAntigravity || isExeMatch) && pid && pid !== ownPid) {
            pids.push(pid);
          }
        }
      }
    }
  } catch (e) {
    log('Error checking PIDs: ' + String(e));
  }
  return pids;
}

// ── Wait for all Antigravity processes to exit ──
async function waitForAntigravityExit(timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const pids = getOtherAntigravityPids();
    if (pids.length === 0) {
      log('All Antigravity processes have exited.');
      return true;
    }
    log('Waiting... remaining PIDs: ' + pids.join(', '));
    await new Promise(r => setTimeout(r, 500));
  }
  log('Timeout waiting for Antigravity to exit.');
  return false;
}

// ── Force-kill specific PIDs (by PID number, NOT by image name) ──
function forceKillRemainingPids() {
  const pids = getOtherAntigravityPids();
  if (pids.length === 0) return;
  log('Force-killing remaining PIDs: ' + pids.join(', '));
  for (const pid of pids) {
    try {
      if (process.platform === 'win32') {
        execSync('taskkill /F /PID ' + pid, { stdio: 'ignore', windowsHide: true });
      } else {
        execSync('kill -9 ' + pid, { stdio: 'ignore' });
      }
      log('  Killed PID ' + pid);
    } catch (e) {
      log('  Failed to kill PID ' + pid + ': ' + String(e));
    }
  }
  // Verify all gone
  const remaining = getOtherAntigravityPids();
  if (remaining.length > 0) {
    log('WARNING: Some PIDs survived force-kill: ' + remaining.join(', '));
  } else {
    log('All lingering processes killed successfully.');
  }
}

// ── Find best exe path to relaunch ──
function findRelaunchExe() {
  // Try payload candidates first
  if (exeCandidates && Array.isArray(exeCandidates)) {
    for (const candidate of exeCandidates) {
      if (candidate && fs.existsSync(candidate)) {
        log('Found relaunch exe from candidates: ' + candidate);
        return candidate;
      }
    }
  }

  const homeDir = process.env.HOME || process.env.USERPROFILE || '';

  // Fallback: scan common installation paths
  if (process.platform === 'win32') {
    const localAppData = process.env.LOCALAPPDATA || '';
    const programFiles = process.env.PROGRAMFILES || '';
    const fallbacks = [
      path.join(localAppData, 'Programs', 'Antigravity IDE', 'Antigravity IDE.exe'),
      path.join(localAppData, 'Programs', 'Antigravity', 'Antigravity.exe'),
      path.join(programFiles, 'Antigravity IDE', 'Antigravity IDE.exe'),
      path.join(programFiles, 'Antigravity', 'Antigravity.exe'),
    ];
    for (const p of fallbacks) {
      if (p && fs.existsSync(p)) return p;
    }
  } else if (process.platform === 'darwin') {
    const fallbacks = [
      '/Applications/Antigravity IDE.app/Contents/MacOS/Antigravity IDE',
      '/Applications/Antigravity.app/Contents/MacOS/Antigravity',
      path.join(homeDir, 'Applications', 'Antigravity IDE.app', 'Contents', 'MacOS', 'Antigravity IDE'),
      path.join(homeDir, 'Applications', 'Antigravity.app', 'Contents', 'MacOS', 'Antigravity'),
    ];
    for (const p of fallbacks) {
      if (p && fs.existsSync(p)) return p;
    }
  } else {
    // Linux / Ubuntu
    const fallbacks = [
      '/usr/bin/antigravity-ide',
      '/usr/bin/antigravity',
      '/usr/local/bin/antigravity-ide',
      '/usr/local/bin/antigravity',
      '/usr/share/antigravity/antigravity',
      '/opt/Antigravity/antigravity',
      '/opt/antigravity/antigravity',
      '/opt/antigravity-ide/antigravity-ide',
      '/snap/bin/antigravity',
      '/snap/bin/antigravity-ide',
      path.join(homeDir, '.local', 'bin', 'antigravity-ide'),
      path.join(homeDir, '.local', 'bin', 'antigravity'),
    ];
    for (const p of fallbacks) {
      if (p && fs.existsSync(p)) return p;
    }
    try {
      const whichRaw = execSync('which antigravity || which antigravity-ide || command -v antigravity || command -v antigravity-ide', {
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
      const whichOut = whichRaw.split(String.fromCharCode(10))[0].trim();
      if (whichOut && fs.existsSync(whichOut)) {
        log('Found relaunch exe via which: ' + whichOut);
        return whichOut;
      }
    } catch {}
  }

  log('No relaunch exe found in any candidate or fallback path.');
  return null;
}

// ── Agent credential store helpers (Windows / macOS / Linux) ──
// The Antigravity agent hub authenticates with a generic credential named
// "gemini:antigravity" whose secret is the JSON token blob. Each OS keeps it in its
// own vault, so the write has to be platform specific.
const AGENT_CRED_TARGET = 'gemini:antigravity';
const AGENT_CRED_USER = 'antigravity';

function stopAgentHub() {
  try {
    if (process.platform === 'win32') {
      execSync('taskkill /F /IM agy.exe', { stdio: 'ignore', windowsHide: true });
      log('Stopped the agent hub (agy.exe) so it reloads the credential on next launch.');
      return;
    }
    // The hub runs as an unmanaged process advertising --hub. "pkill -x agy" covers
    // builds that drop the flag; killing by exact name cannot hit the IDE or this worker.
    let stopped = false;
    try {
      execSync("pkill -f 'agy.*--hub'", { stdio: 'ignore' });
      stopped = true;
    } catch (hubMiss) {}
    if (!stopped) {
      try {
        execSync('pkill -x agy', { stdio: 'ignore' });
        stopped = true;
      } catch (hubMiss2) {}
    }
    log(stopped
      ? 'Stopped the agent hub so it reloads the credential on next launch.'
      : 'Agent hub was not running, nothing to stop.');
  } catch (hubErr) {
    log('Agent hub was not running (or could not be stopped): ' + String(hubErr).split('\\n')[0]);
  }
}

async function syncAgentCredential(cred, workDir) {
  const json = JSON.stringify(cred);

  // The hub caches the token in memory: stop it before rewriting the vault.
  stopAgentHub();

  try {
    if (process.platform === 'win32') {
      const helper = path.join(workDir, 'write-cred.ps1');
      if (!fs.existsSync(helper)) {
        log('write-cred.ps1 not found next to the worker: ' + helper);
        return;
      }
      const tmp = path.join(require('os').tmpdir(), 'antigravity-cred-' + Date.now() + '.json');
      try {
        fs.writeFileSync(tmp, json, 'utf-8');
        const out = execSync(
          'powershell -NoProfile -ExecutionPolicy Bypass -File "' + helper + '" -PayloadPath "' + tmp + '"',
          { encoding: 'utf-8', windowsHide: true, timeout: 20000 }
        );
        log('Agent credential (Windows Credential Manager): ' + String(out).trim());
        log('Credential account: ' + cred.id_token_email);
      } finally {
        try { fs.unlinkSync(tmp); } catch {}
      }
      return;
    }

    if (process.platform === 'darwin') {
      // -U replaces the existing generic password in place.
      execSync(
        'security add-generic-password -U -s "' + AGENT_CRED_TARGET + '" -a "' + AGENT_CRED_USER + '" -w ' + JSON.stringify(json),
        { stdio: 'ignore', timeout: 20000 }
      );
      log('Agent credential (macOS Keychain): ' + cred.id_token_email);
      return;
    }

    // Linux: libsecret backend (GNOME Keyring, KWallet, KeePassXC...). The secret
    // travels through stdin so it never shows up in the process list.
    //
    // The lookup key is NOT the Windows target: on Ubuntu the agent asks libsecret for
    // service="gemini" + username="antigravity" (two separate attributes), and the
    // "gemini:antigravity" item is a different credential it never reads. Measured on
    // 1.107: writing only the Windows-style target left the panel switched while the
    // chat kept billing the previous account. Write both, hub key first.
    const storeSecret = (service, label) => {
      try {
        execSync(
          'secret-tool clear service "' + service + '" username "' + AGENT_CRED_USER + '"',
          { stdio: 'ignore', timeout: 10000 }
        );
      } catch (clearMiss) {
        // nothing stored yet
      }
      execSync(
        'secret-tool store --label="' + label + '" service "' + service + '" username "' + AGENT_CRED_USER + '"',
        { input: json, stdio: ['pipe', 'ignore', 'pipe'], timeout: 20000 }
      );
    };

    storeSecret('gemini', "Password for 'antigravity' on 'gemini'");
    storeSecret(AGENT_CRED_TARGET, 'Antigravity');

    // Read the hub key back: without this the failure is invisible and the IDE looks
    // switched while the agent keeps using the previous account.
    let readBack = '';
    try {
      readBack = String(execSync(
        'secret-tool lookup service "gemini" username "' + AGENT_CRED_USER + '"',
        { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 10000 }
      ) || '').trim();
    } catch (readErr) {
      readBack = '';
    }
    const owner = /"id_token_email"\s*:\s*"([^"]+)"/.exec(readBack);
    const ownerEmail = owner ? owner[1] : '';
    if (!readBack) {
      log('WARNING: the credential could not be read back from libsecret (empty). ' +
        'Is a keyring unlocked for this session (gnome-keyring / KWallet)?');
      log('Credential written but NOT verified: ' + cred.id_token_email);
    } else if (ownerEmail && ownerEmail.toLowerCase() !== String(cred.id_token_email).toLowerCase()) {
      log('WARNING: libsecret returned a different token owner: ' + ownerEmail +
        ' (expected ' + cred.id_token_email + '). Another entry may still win the lookup.');
    } else {
      log('Agent credential (libsecret, service=gemini): ' + cred.id_token_email + ' [verified]');
    }
  } catch (credErr) {
    log('ERROR writing the agent credential on ' + process.platform + ': ' + String(credErr).split('\\n')[0]);
    log('The account was switched in state.vscdb only. Install ' +
      (process.platform === 'darwin' ? 'Xcode command line tools (security).' : 'libsecret (secret-tool).'));
  }
}

// ── Graphical session environment (Linux / macOS) ──
// The relaunch inherits the extension host environment, which is not always the same as
// the desktop session: a launcher can omit XAUTHORITY or XDG_CURRENT_DESKTOP, and without
// them Electron cannot reach the keyring (VS Code then offers to downgrade the encryption
// of every stored secret) or even segfaults on start. Recover the missing values from the
// running desktop session instead of assuming they are present.
const DESKTOP_ENV_KEYS = [
  'DISPLAY', 'XAUTHORITY', 'XAUTHLOCK', 'WAYLAND_DISPLAY',
  'XDG_RUNTIME_DIR', 'XDG_SESSION_TYPE', 'XDG_CURRENT_DESKTOP', 'XDG_SESSION_DESKTOP',
  'DBUS_SESSION_BUS_ADDRESS', 'LANG', 'LC_ALL'
];

function readProcEnviron(pid) {
  const out = {};
  try {
    const raw = fs.readFileSync('/proc/' + pid + '/environ', 'utf8');
    for (const entry of raw.split(String.fromCharCode(0))) {
      const eq = entry.indexOf('=');
      if (eq > 0) out[entry.slice(0, eq)] = entry.slice(eq + 1);
    }
  } catch (e) {
    // not readable (other user, or the process went away)
  }
  return out;
}

function collectDesktopEnv() {
  const env = {};
  for (const key of DESKTOP_ENV_KEYS) {
    if (process.env[key]) env[key] = process.env[key];
  }
  const complete = () => env.DISPLAY && env.XAUTHORITY && env.XDG_CURRENT_DESKTOP && env.DBUS_SESSION_BUS_ADDRESS;
  if (complete()) return env;

  const owners = ['gnome-shell', 'gnome-session-b', 'gnome-session', 'xfce4-session',
    'mate-session', 'plasmashell', 'xfwm4', 'Xorg', 'Xvnc', 'gnome-keyring-d'];
  let listing = '';
  try {
    listing = execSync('ps -ax -o pid=,comm=', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch (psErr) {
    log('Could not list processes to recover the desktop environment: ' + String(psErr));
    return env;
  }
  for (const line of listing.split(String.fromCharCode(10))) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const space = trimmed.indexOf(' ');
    if (space < 0) continue;
    const pid = trimmed.slice(0, space).trim();
    const comm = trimmed.slice(space + 1).trim();
    if (owners.indexOf(comm) === -1) continue;
    const found = readProcEnviron(pid);
    for (const key of DESKTOP_ENV_KEYS) {
      if (!env[key] && found[key]) env[key] = found[key];
    }
    if (complete()) break;
  }
  return env;
}

async function inject() {
  // Phase 1: Wait up to 12s for Antigravity to flush and gracefully exit
  // (Electron requires several seconds on busy systems to cleanly flush LevelDB and Service Worker caches)
  const exited = await waitForAntigravityExit(12000);

  if (!exited) {
    // Phase 2: Force-kill any lingering processes by their specific PIDs
    // (NOT by image name — that would kill our worker too!)
    // These are typically GPU helper or utility processes that hold the
    // single-instance lock and prevent relaunch.
    log('Graceful exit incomplete after 12s. Force-killing remaining processes...');
    forceKillRemainingPids();
  }

  // Phase 3: Safety margin for OS to release file locks
  await new Promise(r => setTimeout(r, 2000));

  // Phase 3.5: Clean dangling locks from Service Worker and LevelDB to prevent InvalidStateError on relaunch
  try {
    const dataDir = path.dirname(path.dirname(dbPath));
    const swLock = path.join(dataDir, 'Service Worker', 'Database', 'LOCK');
    if (fs.existsSync(swLock)) {
      try {
        fs.unlinkSync(swLock);
        log('Cleaned dangling Service Worker LOCK file before relaunch.');
      } catch (lockCleanErr) {
        log('Could not unlink Service Worker LOCK: ' + String(lockCleanErr));
      }
    }
  } catch (cleanupErr) {
    log('Service worker lock cleanup error: ' + String(cleanupErr));
  }

  // Write device profile to storage.json after IDE has exited to avoid cached configuration overwrites!
  if (payload.storageJsonPath && payload.deviceProfile) {
    try {
      const storagePath = payload.storageJsonPath;
      const profile = payload.deviceProfile;
      let storageData = {};
      if (fs.existsSync(storagePath)) {
        try { storageData = JSON.parse(fs.readFileSync(storagePath, 'utf-8')); }
        catch (e) { storageData = {}; }
      } else {
        const dir = path.dirname(storagePath);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      }
      storageData['telemetry.machineId'] = profile.machineId;
      storageData['telemetry.macMachineId'] = profile.macMachineId;
      storageData['telemetry.devDeviceId'] = profile.devDeviceId;
      storageData['telemetry.sqmId'] = profile.sqmId;
      storageData['storage.serviceMachineId'] = profile.devDeviceId;
      fs.writeFileSync(storagePath, JSON.stringify(storageData, null, 2), 'utf-8');
      log('Device profile successfully written to storage.json in worker.');
    } catch (e) {
      log('Failed to write device profile to storage.json in worker: ' + String(e));
    }
  }

  try {
    log('Loading sql.js...');
    let initSqlJs;
    try {
      initSqlJs = require('sql.js');
    } catch {
      try {
        initSqlJs = require(path.join(__dirname, 'sql-wasm.js'));
      } catch {
        try {
          initSqlJs = require(path.join(__dirname, '..', 'node_modules', 'sql.js'));
        } catch {
          initSqlJs = require(path.join(__dirname, '..', '..', 'node_modules', 'sql.js'));
        }
      }
    }

    log('Opening database: ' + dbPath);
    const wasmCandidates = [
      path.join(__dirname, 'sql-wasm.wasm'),
      path.join(__dirname, '..', 'dist', 'sql-wasm.wasm'),
    ];
    const foundWasm = wasmCandidates.find(p => fs.existsSync(p));
    const SQL = await initSqlJs(foundWasm ? { locateFile: () => foundWasm } : {});
    const buf = fs.readFileSync(dbPath);
    const db = new SQL.Database(buf);

    try {
      for (const { key, value } of rows) {
        if (value === null) {
          db.run('DELETE FROM ItemTable WHERE key = ?', [key]);
          log('  DELETED: ' + key);
        } else {
          db.run('INSERT OR REPLACE INTO ItemTable (key, value) VALUES (?, ?)', [key, value]);
          log('  INJECTED: ' + key + ' (' + value.length + ' chars)');
        }
      }
      const out = db.export();
      fs.writeFileSync(dbPath, Buffer.from(out));
      log('Database saved.');
    } finally {
      db.close();
    }
  } catch (dbErr) {
    log('ERROR during database injection: ' + String(dbErr));
  }

  // ── Sync the agent credential (OS credential store) ──
  // The agent hub reads "gemini:antigravity" from the OS vault and caches it in
  // memory. Without this write the switch only changed state.vscdb, so the chat kept
  // consuming the previous account's quota. Implemented for Windows, macOS and Linux,
  // always best-effort: a failure here never blocks the switch.
  if (payload.credentialPayload) {
    await syncAgentCredential(payload.credentialPayload, path.dirname(payloadPath));
  }

  // Cleanup payload file
  try { fs.unlinkSync(payloadPath); } catch {}

  // ── Relaunch Antigravity ──
  try {
    const relaunchExe = findRelaunchExe();
    if (relaunchExe) {
      log('Relaunching Antigravity: ' + relaunchExe);

      if (process.platform === 'win32') {
        // Windows Relauncher: allow safety margin for database lock release
        await new Promise(r => setTimeout(r, 1200));

        // One PowerShell script opens every window in order. Start-Process gives each
        // Electron instance a clean GUI session, and the pause between them lets the
        // single-instance lock route --new-window to the window that already started
        // instead of racing it.
        const psTargets = openTargets.length > 0 ? openTargets : [null];
        const quotedExe = "'" + String(relaunchExe).replace(/'/g, "''") + "'";
        // Start-Process joins -ArgumentList with spaces without quoting, so every path
        // has to carry its own double quotes or a folder with spaces is split in two.
        const psQuote = (value) => "'" + '"' + String(value).replace(/'/g, "''") + '"' + "'";
        const DQ = String.fromCharCode(34);
        const psLines = ['Remove-Item Env:ELECTRON_RUN_AS_NODE -EA SilentlyContinue'];
        psTargets.forEach((target, index) => {
          if (!target) {
            psLines.push('Start-Process -FilePath ' + quotedExe);
            return;
          }
          const argList = index === 0
            ? psQuote(String(target))
            : "'" + DQ + '--new-window' + DQ + ' ' + DQ + String(target).replace(/'/g, "''") + DQ + "'";
          psLines.push('Start-Process -FilePath ' + quotedExe + ' -ArgumentList ' + argList);
          if (index < psTargets.length - 1) psLines.push('Start-Sleep -Seconds 6');
        });
        log('Relaunch plan (' + psTargets.length + ' window(s)): ' + JSON.stringify(openTargets));

        let relaunchSuccess = false;

        // Method 1: a script executed by Start-Process (creates a clean interactive GUI
        // process with SW_SHOWNORMAL). It is written to disk because the argument list
        // contains double quotes, which cannot survive a -Command "…" round trip.
        try {
          const psPath = path.join(path.dirname(payloadPath), '.relaunch-antigravity.ps1');
          fs.writeFileSync(psPath, psLines.join('\\r\\n') + '\\r\\n', 'utf-8');
          execSync(
            'powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + psPath + '"',
            { stdio: 'ignore', timeout: 60000 }
          );
          try { fs.unlinkSync(psPath); } catch {}
          log('Relaunch via PowerShell Start-Process succeeded.');
          relaunchSuccess = true;
        } catch (psErr) {
          log('PowerShell Start-Process failed: ' + String(psErr));
        }

        // Method 2: Direct spawns with windowsHide: false and a cleaned environment.
        // Every folder is replayed here too, so a PowerShell failure cannot collapse
        // the session back into a single window.
        if (!relaunchSuccess) {
          try {
            const cleanEnv = { ...process.env };
            delete cleanEnv.ELECTRON_RUN_AS_NODE;
            const spawnTargets = openTargets.length > 0 ? openTargets : [null];
            for (let i = 0; i < spawnTargets.length; i++) {
              const target = spawnTargets[i];
              const args = target ? (i === 0 ? [target] : ['--new-window', target]) : [];
              const directChild = spawn(relaunchExe, args, {
                detached: true,
                stdio: 'ignore',
                windowsHide: false,
                env: cleanEnv
              });
              directChild.unref();
              log('Direct Windows relaunch spawned PID ' + directChild.pid + ' for ' + (target || 'default window'));
              if (i < spawnTargets.length - 1) await new Promise(r => setTimeout(r, 6000));
            }
          } catch (spawnErr) {
            log('ALL Windows relaunch methods failed: ' + String(spawnErr));
          }
        }
      } else {
        // Unix (Linux & macOS) Relauncher
        const isRootOrContainer = (typeof process.getuid === 'function' && process.getuid() === 0) || fs.existsSync('/.dockerenv');
        const extraArg = isRootOrContainer ? ' --no-sandbox' : '';
        const spawnArgs = isRootOrContainer ? ['--no-sandbox'] : [];
        const shPath = path.join(path.dirname(payloadPath), '.relaunch-antigravity.sh');
        const shTargets = openTargets.length > 0 ? openTargets : [null];
        const desktopEnv = collectDesktopEnv();
        const envExports = Object.keys(desktopEnv).map(function (key) {
          return 'export ' + key + '=' + JSON.stringify(desktopEnv[key]);
        });
        log('Desktop session env for relaunch: ' + JSON.stringify(Object.keys(desktopEnv)));
        const shLines = [
          '#!/bin/sh',
          'unset ELECTRON_RUN_AS_NODE'
        ].concat(envExports).concat([
          'EXE=' + JSON.stringify(relaunchExe),
          'launch() {',
          '  if command -v nohup >/dev/null 2>&1; then',
          '    nohup "$@" >/dev/null 2>&1 &',
          '  elif command -v setsid >/dev/null 2>&1; then',
          '    setsid "$@" >/dev/null 2>&1 &',
          '  else',
          '    "$@" >/dev/null 2>&1 &',
          '  fi',
          '}',
          'sleep 1'
        ]);
        // Same replay as on Windows: first folder plain, the rest as new windows.
        shTargets.forEach((target, index) => {
          const windowArgs = !target ? '' : (index === 0 ? ' ' + JSON.stringify(target) : ' --new-window ' + JSON.stringify(target));
          shLines.push('launch "$EXE"' + windowArgs + extraArg);
          if (index < shTargets.length - 1) shLines.push('sleep 6');
        });
        shLines.push('sleep 1', 'rm -f "$0"');
        fs.writeFileSync(shPath, shLines.join('\\n') + '\\n', { encoding: 'utf-8', mode: 0o755 });
        log('Wrote relaunch .sh to: ' + shPath);

        try {
          const child = spawn('/bin/sh', [shPath], {
            detached: true,
            stdio: 'ignore',
          });
          child.unref();
          log('Relaunch .sh spawned, PID: ' + child.pid);
        } catch (shErr) {
          log('Relaunch .sh failed: ' + String(shErr) + ', attempting direct spawn fallback...');
          // Direct spawn backup with sanitized environment (plus the desktop session one)
          try {
            const cleanEnv = { ...process.env, ...desktopEnv };
            delete cleanEnv.ELECTRON_RUN_AS_NODE;
            for (let i = 0; i < shTargets.length; i++) {
              const target = shTargets[i];
              const args = [...spawnArgs];
              if (target) {
                if (i > 0) args.push('--new-window');
                args.push(target);
              }
              const directChild = spawn(relaunchExe, args, {
                detached: true,
                stdio: 'ignore',
                env: cleanEnv
              });
              directChild.unref();
              log('Direct Node spawn executed with PID: ' + directChild.pid);
              if (i < shTargets.length - 1) await new Promise(r => setTimeout(r, 6000));
            }
          } catch (spawnErr) {
            log('Direct spawn attempt error: ' + String(spawnErr));
          }
        }
      }
    } else {
      log('ERROR: Antigravity exe not found, cannot relaunch.');
    }
  } catch (relaunchErr) {
    log('FATAL ERROR during relaunch: ' + String(relaunchErr));
  }

  log('Worker finished successfully.');
  await new Promise(r => setTimeout(r, 3000));
}

inject().catch((err) => {
  log('FATAL outer catch: ' + String(err));
  process.exit(1);
});
`;
  }

  private findAntigravityExe(): string | undefined {
    const homeDir = os.homedir();
    if (process.platform === 'win32') {
      const candidates = [
        path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Antigravity IDE', 'Antigravity IDE.exe'),
        path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Antigravity', 'Antigravity.exe'),
        path.join(process.env.PROGRAMFILES || '', 'Antigravity IDE', 'Antigravity IDE.exe'),
        path.join(process.env.PROGRAMFILES || '', 'Antigravity', 'Antigravity.exe'),
      ];
      return candidates.find(c => fs.existsSync(c));
    } else if (process.platform === 'darwin') {
      const candidates = [
        '/Applications/Antigravity IDE.app/Contents/MacOS/Antigravity IDE',
        '/Applications/Antigravity.app/Contents/MacOS/Antigravity',
        path.join(homeDir, 'Applications', 'Antigravity IDE.app', 'Contents', 'MacOS', 'Antigravity IDE'),
        path.join(homeDir, 'Applications', 'Antigravity.app', 'Contents', 'MacOS', 'Antigravity'),
      ];
      return candidates.find(c => fs.existsSync(c));
    } else {
      // Linux
      const candidates = [
        '/usr/bin/antigravity-ide',
        '/usr/bin/antigravity',
        '/usr/local/bin/antigravity-ide',
        '/usr/local/bin/antigravity',
        '/usr/share/antigravity/antigravity',
        '/opt/Antigravity/antigravity',
        '/opt/antigravity/antigravity',
        '/opt/antigravity-ide/antigravity-ide',
        '/snap/bin/antigravity',
        '/snap/bin/antigravity-ide',
        path.join(homeDir, '.local', 'bin', 'antigravity-ide'),
        path.join(homeDir, '.local', 'bin', 'antigravity'),
      ];
      const found = candidates.find(c => fs.existsSync(c));
      if (found) return found;

      try {
        const whichOut = execSync('which antigravity || which antigravity-ide || command -v antigravity || command -v antigravity-ide', {
          encoding: 'utf-8',
          stdio: ['ignore', 'pipe', 'ignore'],
        }).trim().split('\n')[0].trim();
        if (whichOut && fs.existsSync(whichOut)) {
          return whichOut;
        }
      } catch (e) {}
      return undefined;
    }
  }

  // ─── Read Current Active Account from state.vscdb ──────────────────────────

  /**
   * Reads the currently active email from Antigravity's state.vscdb.
   * This allows the extension to detect which account Antigravity is currently
   * using, even if it was switched outside this extension.
   *
   * Returns null if the database doesn't exist or the email can't be extracted.
   */
  async readCurrentEmailFromDb(): Promise<string | null> {
    const dbPath = PathUtils.getVscdbPath(this.context);
    if (!fs.existsSync(dbPath)) {
      Logger.getInstance().info('state.vscdb not found, cannot detect active account.');
      return null;
    }

    const email = await this.readConsistentSnapshot<string | null>((db) => {
      const stmt = db.prepare('SELECT value FROM ItemTable WHERE key = $key');
      try {
        stmt.bind({ $key: STATE_DB_KEYS.USER_STATUS });
        if (!stmt.step()) return null;
        const base64Value = stmt.get()[0] as string;
        return base64Value ? this.extractEmailFromUserStatus(base64Value) : null;
      } finally {
        stmt.free();
      }
    }, (value) => !!value);

    if (email) {
      Logger.getInstance().info(`Detected active Antigravity account: ${email}`);
      return email;
    }

    Logger.getInstance().info('No userStatus entry found in state.vscdb.');
    return null;
  }

  /**
   * Reads `state.vscdb` as a consistent snapshot.
   *
   * The IDE keeps this database in rollback-journal mode and keeps writing to it while
   * the extension is running (trajectories, window state...). A plain `readFileSync` +
   * `new SQL.Database(buffer)` bypasses SQLite locking, so a read can land in the middle
   * of a transaction and yield a truncated row. That produced sporadic "no session" /
   * empty-token reads, which in turn made quota lookups run against the wrong account.
   *
   * The snapshot is validated by the caller's parser and retried while the database is
   * being written.
   */
  private async readConsistentSnapshot<T>(
    reader: (db: any) => T,
    isValid: (value: T) => boolean,
    attempts: number = 4
  ): Promise<T | null> {
    const dbPath = PathUtils.getVscdbPath(this.context);
    if (!fs.existsSync(dbPath)) {
      return null;
    }

    let SQL: any;
    try {
      SQL = await this.getSqlJs();
    } catch (error) {
      Logger.getInstance().error('Failed to initialise sql.js for state.vscdb', error);
      return null;
    }

    for (let attempt = 0; attempt < attempts; attempt++) {
      let db: any = null;
      try {
        const buf = fs.readFileSync(dbPath);
        db = new SQL.Database(buf);
        const value = reader(db);
        if (isValid(value)) {
          return value;
        }
        Logger.getInstance().debug(
          `state.vscdb snapshot ${attempt + 1}/${attempts} was incomplete (database busy); retrying...`
        );
      } catch (error) {
        Logger.getInstance().debug(`state.vscdb snapshot ${attempt + 1}/${attempts} failed`, error);
      } finally {
        try {
          db?.close();
        } catch { /* already closed */ }
      }

      await new Promise<void>(resolve => setTimeout(resolve, 60 + attempt * 120));
    }

    Logger.getInstance().warn('Could not obtain a consistent state.vscdb snapshot.');
    return null;
  }

  /**
   * Reads the active OAuth tokens directly from Antigravity's state.vscdb database.
   * Extracts access token, refresh token, and expiration timestamp.
   */
  async readActiveTokensFromDb(): Promise<{ accessToken: string; refreshToken: string; expiresAt: number } | null> {
    const dbPath = PathUtils.getVscdbPath(this.context);
    if (!fs.existsSync(dbPath)) {
      Logger.getInstance().info('state.vscdb not found, cannot read active tokens.');
      return null;
    }

    const tokens = await this.readConsistentSnapshot<{ accessToken: string; refreshToken: string; expiresAt: number } | null>((db) => {
      const stmt = db.prepare('SELECT value FROM ItemTable WHERE key = $key');
      try {
        stmt.bind({ $key: STATE_DB_KEYS.OAUTH_TOKEN });
        if (!stmt.step()) return null;
        const base64Value = stmt.get()[0] as string;
        return base64Value ? this.parseTokensFromBase64(base64Value) : null;
      } finally {
        stmt.free();
      }
    }, (value) => !!value);

    if (!tokens) {
      Logger.getInstance().info('No usable oauthToken entry found in state.vscdb.');
    }
    return tokens;
  }

  /**
   * Reads both the active email and tokens from state.vscdb in a single database read.
   * This is a significant optimization over reading them separately.
   */
  async readActiveAccountInfoFromDb(): Promise<{ email: string | null; tokens: { accessToken: string; refreshToken: string; expiresAt: number } | null; avatarUrl?: string | null } | null> {
    const dbPath = PathUtils.getVscdbPath(this.context);
    if (!fs.existsSync(dbPath)) {
      Logger.getInstance().info('state.vscdb not found, cannot detect active account/tokens.');
      return null;
    }

    // Both rows are required for a usable answer, so a torn read is retried instead of
    // being reported as "no session".
    return await this.readConsistentSnapshot<{ email: string | null; tokens: { accessToken: string; refreshToken: string; expiresAt: number } | null; avatarUrl?: string | null } | null>((db) => {
      let email: string | null = null;
      let tokens: { accessToken: string; refreshToken: string; expiresAt: number } | null = null;
      let avatarUrl: string | null = null;

      // 1. Read userStatus
      const stmtUser = db.prepare('SELECT value FROM ItemTable WHERE key = $key');
      try {
        stmtUser.bind({ $key: STATE_DB_KEYS.USER_STATUS });
        if (stmtUser.step()) {
          const base64Value = stmtUser.get()[0] as string;
          if (base64Value) {
            email = this.extractEmailFromUserStatus(base64Value);
          }
        }
      } finally {
        stmtUser.free();
      }

      // 2. Read oauthToken
      const stmtToken = db.prepare('SELECT value FROM ItemTable WHERE key = $key');
      try {
        stmtToken.bind({ $key: STATE_DB_KEYS.OAUTH_TOKEN });
        if (stmtToken.step()) {
          const base64Value = stmtToken.get()[0] as string;
          if (base64Value) {
            tokens = this.parseTokensFromBase64(base64Value);
          }
        }
      } finally {
        stmtToken.free();
      }

      // 3. Read profileUrl if present
      try {
        const stmtProfile = db.prepare('SELECT value FROM ItemTable WHERE key = $key');
        try {
          stmtProfile.bind({ $key: STATE_DB_KEYS.PROFILE_URL });
          if (stmtProfile.step()) {
            avatarUrl = (stmtProfile.get()[0] as string) || null;
          }
        } finally {
          stmtProfile.free();
        }
      } catch { /* optional */ }

      return { email, tokens, avatarUrl };
    }, (value) => !!value && !!value.email && !!value.tokens);
  }

  /**
   * Scans state.vscdb for any secret storage keys belonging to this extension,
   * extracting all unique candidate account emails that have stored refresh tokens.
   */
  async findSecretAccountEmails(): Promise<string[]> {
    const dbPath = PathUtils.getVscdbPath(this.context);
    if (!fs.existsSync(dbPath)) return [];

    try {
      const SQL = await this.getSqlJs();
      const buf = fs.readFileSync(dbPath);
      const db = new SQL.Database(buf);

      try {
        const stmt = db.prepare("SELECT key FROM ItemTable WHERE key LIKE '%secret://%davissss2.antigravity-account%refreshToken%'");
        const emails = new Set<string>();
        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

        while (stmt.step()) {
          const key = stmt.get()[0] as string;
          const m = key.match(/antigravityAccount\.secure\.(.*?)\.refreshToken/);
          if (m) {
            let email = m[1].trim();
            if (email.endsWith('.con')) {
              email = email.slice(0, -4) + '.com';
            }
            if (emailRegex.test(email)) {
              emails.add(email);
            }
          }
        }
        stmt.free();
        return Array.from(emails);
      } finally {
        db.close();
      }
    } catch (error) {
      Logger.getInstance().error('Failed to query secret account emails from state.vscdb', error);
      return [];
    }
  }

  /**
   * Parses OAuth tokens from a base64-encoded oauthToken Topic protobuf value.
   */
  private parseTokensFromBase64(base64Value: string): { accessToken: string; refreshToken: string; expiresAt: number } | null {
    try {
      // Decode Topic (base64 → bytes)
      const topicBytes = Buffer.from(base64Value, 'base64');

      // Extract DataEntry (field 1)
      const dataEntryBytes = this.extractField(topicBytes, 1);
      if (!dataEntryBytes) return null;

      // Extract Row (field 2)
      const rowBytes = this.extractField(dataEntryBytes, 2);
      if (!rowBytes) return null;

      // Extract inner base64 string (field 1)
      const innerBase64 = this.extractStringField(rowBytes, 1);
      if (!innerBase64) return null;

      // Decode inner payload (base64 → OAuthInfo protobuf)
      const oauthInfoBytes = Buffer.from(innerBase64, 'base64');

      // Extract access token (field 1)
      const accessToken = this.extractStringField(oauthInfoBytes, 1);
      
      // Extract refresh token (field 3)
      const refreshToken = this.extractStringField(oauthInfoBytes, 3);

      // Extract expiry seconds (field 4)
      const timestampBytes = this.extractField(oauthInfoBytes, 4);
      let expiresAt = 0;
      if (timestampBytes) {
        // Parse Timestamp submessage (Field 1 = seconds, wireType 0)
        let offset = 0;
        let iterations = 0;
        while (offset < timestampBytes.length && iterations < 1000) {
          iterations++;
          const { value: tag, bytesRead: tagLen } = this.readVarint(timestampBytes, offset);
          if (tagLen === 0) break; // Prevent infinite loops
          offset += tagLen;
          const wireType = tag & 0x07;
          const num = tag >> 3;

          if (num === 1 && wireType === 0) {
            const { value: seconds, bytesRead } = this.readVarint(timestampBytes, offset);
            if (bytesRead === 0) break;
            expiresAt = seconds;
            break;
          } else if (wireType === 0) {
            const { bytesRead } = this.readVarint(timestampBytes, offset);
            if (bytesRead === 0) break;
            offset += bytesRead;
          } else if (wireType === 2) {
            const { value: len, bytesRead: lenLen } = this.readVarint(timestampBytes, offset);
            if (lenLen === 0) break;
            offset += lenLen + len;
          } else if (wireType === 1) {
            offset += 8; // 64-bit field
          } else if (wireType === 5) {
            offset += 4; // 32-bit field
          } else {
            break;
          }
        }
      }

      if (accessToken && refreshToken) {
        Logger.getInstance().debug('Successfully extracted active OAuth tokens from state.vscdb');
        return { accessToken, refreshToken, expiresAt };
      }
      return null;
    } catch (e) {
      Logger.getInstance().error('Failed to parse oauthToken protobuf', e);
      return null;
    }
  }


  /**
   * Extracts the email from a base64-encoded userStatus protobuf.
   * The structure is: Topic → DataEntry → Row → UserStatus payload.
   * The email is stored in field 3 and field 7 of the UserStatus payload.
   */
  private extractEmailFromUserStatus(base64Value: string): string | null {
    try {
      // Level 1: Decode outer Topic (base64 → bytes)
      const topicBytes = Buffer.from(base64Value, 'base64');
      
      // Level 2: Parse Topic → extract DataEntry (field 1, wire type 2)
      const dataEntryBytes = this.extractField(topicBytes, 1);
      if (!dataEntryBytes) return null;

      // Level 3: Parse DataEntry → extract Row (field 2, wire type 2)
      const rowBytes = this.extractField(dataEntryBytes, 2);
      if (!rowBytes) return null;

      // Level 4: Parse Row → extract base64 value (field 1, string)
      const innerBase64 = this.extractStringField(rowBytes, 1);
      if (!innerBase64) return null;

      // Level 5: Decode inner payload (base64 → UserStatus protobuf)
      const userStatusBytes = Buffer.from(innerBase64, 'base64');

      // Level 6: Extract email from UserStatus (field 7 is canonical email, field 3 can be name or ID)
      const emailField7 = this.extractStringField(userStatusBytes, 7);
      const emailField3 = this.extractStringField(userStatusBytes, 3);
      
      const isValidEmail = (val: string | null): boolean => {
        if (!val) return false;
        const s = val.trim().toLowerCase();
        return s.includes('@') && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
      };

      if (isValidEmail(emailField7)) return emailField7!.trim().toLowerCase();
      if (isValidEmail(emailField3)) return emailField3!.trim().toLowerCase();

      // Fallback 1: scan inner userStatusBytes for any email address
      const rawUserStatus = userStatusBytes.toString('utf-8');
      const matchInner = rawUserStatus.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/);
      if (matchInner && isValidEmail(matchInner[0])) return matchInner[0].trim().toLowerCase();

      // Fallback 2: scan outer topicBytes for any email address
      const rawTopic = topicBytes.toString('utf-8');
      const matchTopic = rawTopic.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/);
      if (matchTopic && isValidEmail(matchTopic[0])) return matchTopic[0].trim().toLowerCase();

      return null;
    } catch (e) {
      Logger.getInstance().error('Failed to parse userStatus protobuf', e);
      return null;
    }
  }

  /**
   * Extracts a length-delimited field (wire type 2) from protobuf bytes.
   */
  private extractField(data: Buffer, fieldNum: number): Buffer | null {
    let offset = 0;
    let iterations = 0;
    while (offset < data.length && iterations < 1000) {
      iterations++;
      const { value: tag, bytesRead: tagLen } = this.readVarint(data, offset);
      if (tagLen === 0) break; // Prevent infinite loops
      offset += tagLen;
      
      const wireType = tag & 0x07;
      const num = tag >> 3;

      if (wireType === 2) {
        const { value: len, bytesRead: lenLen } = this.readVarint(data, offset);
        if (lenLen === 0) break;
        offset += lenLen;
        if (num === fieldNum) {
          return data.slice(offset, offset + len);
        }
        offset += len;
      } else if (wireType === 0) {
        const { bytesRead } = this.readVarint(data, offset);
        if (bytesRead === 0) break;
        offset += bytesRead;
      } else if (wireType === 1) {
        offset += 8; // 64-bit field
      } else if (wireType === 5) {
        offset += 4; // 32-bit field
      } else {
        break; // Unknown wire type
      }
    }
    return null;
  }

  /**
   * Extracts a string field (wire type 2, interpreted as UTF-8) from protobuf bytes.
   */
  private extractStringField(data: Buffer, fieldNum: number): string | null {
    const fieldData = this.extractField(data, fieldNum);
    if (!fieldData) return null;
    return fieldData.toString('utf-8');
  }

  /**
   * Reads a varint from a buffer at the given offset.
   */
  private readVarint(buf: Buffer, offset: number): { value: number; bytesRead: number } {
    let value = 0;
    let shift = 0;
    let bytesRead = 0;
    while (offset < buf.length && bytesRead < 10) {
      const byte = buf[offset];
      value |= (byte & 0x7F) << shift;
      offset++;
      bytesRead++;
      if ((byte & 0x80) === 0) break;
      shift += 7;
    }
    return { value, bytesRead };
  }

  // ─── Helpers ────────────────────────────────────────────────────────────────

  private checkAntigravityVersion(): 'supported' | 'unsupported' | 'unknown' {
    const version = getAntigravityVersion();
    if (!version) {
      Logger.getInstance().warn('Could not detect Antigravity version.');
      return 'unknown';
    }
    Logger.getInstance().info(`Detected Antigravity version: ${version.short}`);
    return isVersionSupported(version) ? 'supported' : 'unsupported';
  }

  private writeDeviceProfileToStorageJson(profile: DeviceProfile): void {
    const storagePath = PathUtils.getStorageJsonPath(this.context);
    try {
      let storageData: Record<string, any> = {};
      if (fs.existsSync(storagePath)) {
        try { storageData = JSON.parse(fs.readFileSync(storagePath, 'utf-8')); }
        catch { storageData = {}; }
      } else {
        const dir = path.dirname(storagePath);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      }
      storageData[STORAGE_JSON_KEYS.MACHINE_ID] = profile.machineId;
      storageData[STORAGE_JSON_KEYS.MAC_MACHINE_ID] = profile.macMachineId;
      storageData[STORAGE_JSON_KEYS.DEV_DEVICE_ID] = profile.devDeviceId;
      storageData[STORAGE_JSON_KEYS.SQM_ID] = profile.sqmId;
      storageData[STORAGE_JSON_KEYS.SERVICE_MACHINE_ID] = profile.devDeviceId;
      fs.writeFileSync(storagePath, JSON.stringify(storageData, null, 2), 'utf-8');
      Logger.getInstance().info('Device profile written to storage.json');
    } catch (e: any) {
      Logger.getInstance().error(`Failed to write device profile: ${e.message}`, e);
    }
  }

  private shouldEnableGcpTos(email: string): boolean {
    const lowerEmail = email.toLowerCase();
    return !PERSONAL_EMAIL_DOMAINS.some((d: string) => lowerEmail.endsWith(d));
  }

  private performRollingBackup(dbPath: string): void {
    const maxBackups = 5;
    try {
      for (let i = maxBackups - 1; i >= 1; i--) {
        const curr = `${dbPath}.backup.${i}`;
        const next = `${dbPath}.backup.${i + 1}`;
        if (fs.existsSync(curr)) fs.renameSync(curr, next);
      }
      fs.copyFileSync(dbPath, `${dbPath}.backup.1`);
    } catch (e) {
      Logger.getInstance().error('Failed to create backup', e);
    }
  }
}
