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
}
