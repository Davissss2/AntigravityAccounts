/**
 * Agent Vault Reader
 *
 * Reads the live OAuth credential used by the Antigravity agent hub (`agy --hub`)
 * from the OS credential store ("gemini:antigravity" on Windows/macOS,
 * service="gemini" + username="antigravity" on Linux libsecret).
 *
 * Since Antigravity 1.107 / 2.x, interactive logins through Antigravity Settings
 * update the OS vault and `google.google-antigravity` without always updating
 * `antigravityUnifiedStateSync.userStatus`. Reading the vault (with TTL cache)
 * guarantees the extension tracks the exact account and quota the agent uses.
 */

import * as fs from 'fs';
import * as path from 'path';
import { execFile } from 'child_process';
import { Logger } from '../../core/utils/logger';

export interface AgentVaultCredential {
  email: string;
  writerId?: string;
  tokens: {
    accessToken: string;
    refreshToken: string;
    expiresAt: number;
  } | null;
}

const AGENT_CRED_TARGET = 'gemini:antigravity';
const AGENT_CRED_USER = 'antigravity';
const CACHE_TTL_MS = 25_000;

export class AgentVaultReader {
  private static cache: { value: AgentVaultCredential | null; at: number } | null = null;
  private static inflight: Promise<AgentVaultCredential | null> | null = null;

  static clearCache(): void {
    this.cache = null;
  }

  static async readActiveCredential(force: boolean = false): Promise<AgentVaultCredential | null> {
    const now = Date.now();
    if (!force && this.cache && now - this.cache.at < CACHE_TTL_MS) {
      return this.cache.value;
    }
    if (this.inflight) {
      return this.inflight;
    }

    this.inflight = this.readFromOsVault()
      .then((value) => {
        this.cache = { value, at: Date.now() };
        return value;
      })
      .catch((err) => {
        Logger.getInstance().debug('[AgentVaultReader] Failed to read OS vault credential', err);
        this.cache = { value: null, at: Date.now() };
        return null;
      })
      .finally(() => {
        this.inflight = null;
      });

    return this.inflight;
  }

  private static async readFromOsVault(): Promise<AgentVaultCredential | null> {
    let raw: string | null = null;

    if (process.platform === 'win32') {
      const helperCandidates = [
        path.join(__dirname, 'read-cred.ps1'),
        path.join(__dirname, '..', 'dist', 'read-cred.ps1'),
      ];
      const helper = helperCandidates.find(p => fs.existsSync(p));
      if (!helper) return null;
      raw = await this.execAsync('powershell.exe', [
        '-NoProfile',
        '-ExecutionPolicy', 'Bypass',
        '-File', helper,
        '-Target', AGENT_CRED_TARGET
      ], 6000);
    } else if (process.platform === 'darwin') {
      raw = await this.execAsync('security', [
        'find-generic-password',
        '-s', AGENT_CRED_TARGET,
        '-a', AGENT_CRED_USER,
        '-w'
      ], 4000);
    } else {
      raw = await this.execAsync('secret-tool', [
        'lookup', 'service', 'gemini', 'username', AGENT_CRED_USER
      ], 4000);
      if (!raw) {
        raw = await this.execAsync('secret-tool', [
          'lookup', 'service', AGENT_CRED_TARGET, 'username', AGENT_CRED_USER
        ], 4000);
      }
    }

    if (!raw || !raw.trim()) return null;
    return this.parseCredentialJson(raw.trim());
  }

  private static parseCredentialJson(raw: string): AgentVaultCredential | null {
    try {
      const data = JSON.parse(raw);
      const email = typeof data?.id_token_email === 'string'
        ? data.id_token_email.trim().toLowerCase()
        : '';
      if (!email || !email.includes('@')) return null;

      const tokenObj = data?.token;
      let tokens: AgentVaultCredential['tokens'] = null;
      if (tokenObj?.access_token) {
        let expiresAt = Math.floor(Date.now() / 1000) + 3600;
        if (tokenObj.expiry) {
          const parsed = Math.floor(new Date(tokenObj.expiry).getTime() / 1000);
          if (!isNaN(parsed) && parsed > 0) expiresAt = parsed;
        }
        tokens = {
          accessToken: String(tokenObj.access_token),
          refreshToken: typeof tokenObj.refresh_token === 'string' ? tokenObj.refresh_token : '',
          expiresAt
        };
      }

      const writerId = typeof data?.writer_id === 'string' && data.writer_id.trim()
        ? data.writer_id.trim()
        : undefined;

      return { email, writerId, tokens };
    } catch {
      return null;
    }
  }

  private static execAsync(command: string, args: string[], timeoutMs: number): Promise<string | null> {
    return new Promise((resolve) => {
      execFile(
        command,
        args,
        { encoding: 'utf8', timeout: timeoutMs, windowsHide: true, maxBuffer: 256 * 1024 },
        (err, stdout) => {
          if (err || !stdout) {
            resolve(null);
            return;
          }
          resolve(stdout);
        }
      );
    });
  }
}
