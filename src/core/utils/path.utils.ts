/**
 * Path Utilities
 * 
 * Provides cross-platform path resolution for Antigravity's internal directories.
 * Ensures the extension works identically on Windows, macOS, and Linux.
 */

import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import * as vscode from 'vscode';

export class PathUtils {
  /**
   * Gets the root data directory for Antigravity based on the OS.
   * - Windows: %APPDATA%\Antigravity IDE or %APPDATA%\Antigravity
   * - macOS: ~/Library/Application Support/Antigravity IDE or Antigravity
   * - Linux: ~/.config/Antigravity IDE or Antigravity
   */
  static getAntigravityDataPath(context?: vscode.ExtensionContext): string {
    if (context && context.globalStorageUri) {
      // context.globalStorageUri.fsPath is like AppData/Roaming/Antigravity IDE/User/globalStorage/publisher.extension
      // We want AppData/Roaming/Antigravity IDE
      // Let's go up 3 levels
      return path.dirname(path.dirname(path.dirname(context.globalStorageUri.fsPath)));
    }

    const platform = os.platform();
    const homeDir = os.homedir();

    switch (platform) {
      case 'win32': {
        const appData = process.env.APPDATA || path.join(homeDir, 'AppData', 'Roaming');
        const idePath = path.join(appData, 'Antigravity IDE');
        if (fs.existsSync(idePath)) {
          return idePath;
        }
        return path.join(appData, 'Antigravity');
      }
      
      case 'darwin': {
        const idePath = path.join(homeDir, 'Library', 'Application Support', 'Antigravity IDE');
        if (fs.existsSync(idePath)) {
          return idePath;
        }
        return path.join(homeDir, 'Library', 'Application Support', 'Antigravity');
      }
      
      case 'linux': {
        const configHome = process.env.XDG_CONFIG_HOME || path.join(homeDir, '.config');
        const idePath = path.join(configHome, 'Antigravity IDE');
        if (fs.existsSync(idePath)) {
          return idePath;
        }
        return path.join(configHome, 'Antigravity');
      }
        
      default:
        throw new Error(`Unsupported operating system: ${platform}`);
    }
  }

  /**
   * Gets the path to the SQLite state database where Antigravity stores OAuth tokens.
   */
  static getVscdbPath(context?: vscode.ExtensionContext): string {
    return path.join(this.getAntigravityDataPath(context), 'User', 'globalStorage', 'state.vscdb');
  }

  /**
   * Gets the path to the standalone OAuth token file used by `agy --hub` when running over SSH or headless.
   */
  static getStandaloneTokenPath(): string {
    return path.join(os.homedir(), '.gemini', 'jetski-standalone-oauth-token');
  }

  /**
   * Gets the path to the directory where CLI accounts are stored.
   */
  static getCliAccountsDir(): string {
    return path.join(os.homedir(), '.gemini', 'antigravity-cli', 'accounts');
  }

  /**
   * Gets the path to the active CLI oauth token file.
   */
  static getCliOAuthTokenPath(): string {
    return path.join(os.homedir(), '.gemini', 'antigravity-cli', 'antigravity-oauth-token');
  }

  /**
   * Checks whether the current environment is running in headless / remote standalone mode
   * (e.g. Remote SSH session without a local Electron state.vscdb SQLite database).
   */
  static isRemoteStandaloneMode(context?: vscode.ExtensionContext): boolean {
    const vscdb = this.getVscdbPath(context);
    if (fs.existsSync(vscdb)) {
      return false;
    }
    if (vscode.env.remoteName) {
      return true;
    }
    const standalone = this.getStandaloneTokenPath();
    const cliDir = this.getCliAccountsDir();
    return fs.existsSync(standalone) || fs.existsSync(cliDir);
  }

  /**
   * Checks if a path is absolute, if not resolves it against the extension root.
   */
  static resolveExtensionPath(extensionPath: string, relativePath: string): string {
    if (path.isAbsolute(relativePath)) {
      return relativePath;
    }
    return path.join(extensionPath, relativePath);
  }

  /**
   * Gets the path to storage.json where Antigravity stores telemetry fingerprints.
   * This file sits alongside state.vscdb in the globalStorage directory.
   */
  static getStorageJsonPath(context?: vscode.ExtensionContext): string {
    return path.join(this.getAntigravityDataPath(context), 'storage.json');
  }

  /**
   * Gets the path to the Chromium Service Worker cache directory in Antigravity's profile.
   */
  static getServiceWorkerPath(context?: vscode.ExtensionContext): string {
    return path.join(this.getAntigravityDataPath(context), 'Service Worker');
  }

  /**
   * Self-healing utility: clears stale LevelDB lock files left behind by unclean terminations
   * to prevent InvalidStateError: Failed to register a ServiceWorker.
   */
  static repairServiceWorkerIfCorrupted(context?: vscode.ExtensionContext): void {
    try {
      const swPath = this.getServiceWorkerPath(context);
      const dbPath = path.join(swPath, 'Database');
      const lockPath = path.join(dbPath, 'LOCK');

      if (fs.existsSync(lockPath)) {
        try {
          const fd = fs.openSync(lockPath, 'r+');
          fs.closeSync(fd);
          fs.unlinkSync(lockPath);
        } catch {}
      }

      // Check for corrupted zero-byte LevelDB LOG file caused by abrupt terminations
      const logFilePath = path.join(dbPath, 'LOG');
      if (fs.existsSync(logFilePath)) {
        try {
          const stats = fs.statSync(logFilePath);
          if (stats.size === 0) {
            // LevelDB is corrupted with zero-byte LOG. Remove corrupted log files so Chromium heals itself cleanly.
            fs.unlinkSync(logFilePath);
            const oldLog = path.join(dbPath, 'LOG.old');
            if (fs.existsSync(oldLog)) fs.unlinkSync(oldLog);
          }
        } catch {}
      }
    } catch {
      // Best-effort silent check
    }
  }
}

