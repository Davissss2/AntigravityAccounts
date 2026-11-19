/**
 * Token CLI Storage Helper
 * Discovers accounts and synchronizes OAuth tokens with CLI directory.
 */

import * as fs from 'fs';
import * as path from 'path';
import { Account, AccountTokens } from '../../core/domain/models/account.model';
import { PathUtils } from '../../core/utils/path.utils';
import { Logger } from '../../core/utils/logger';

export class TokenCliStorage {
  static syncTokensToCli(email: string, tokens: AccountTokens): void {
    try {
      const cliDir = PathUtils.getCliAccountsDir();
      const accountDir = path.join(cliDir, email);
      if (!fs.existsSync(accountDir)) {
        fs.mkdirSync(accountDir, { recursive: true, mode: 0o700 });
      }
      const tokenFile = path.join(accountDir, 'antigravity-oauth-token');
      let idToken = '';
      let existingRefreshToken = '';
      if (fs.existsSync(tokenFile)) {
        try {
          const existing = JSON.parse(fs.readFileSync(tokenFile, 'utf-8'));
          idToken = existing?.id_token || '';
          existingRefreshToken = existing?.token?.refresh_token || '';
        } catch {}
      }
      const finalRefreshToken = tokens.refreshToken?.trim() || existingRefreshToken;
      const payload = {
        token: {
          access_token: tokens.accessToken,
          token_type: 'Bearer',
          refresh_token: finalRefreshToken,
          expiry: new Date(tokens.expiresAt * 1000).toISOString()
        },
        auth_method: 'consumer',
        id_token: idToken
      };
      fs.writeFileSync(tokenFile, JSON.stringify(payload, null, 2), { encoding: 'utf-8', mode: 0o600 });
      try {
        fs.chmodSync(tokenFile, 0o600);
      } catch {}
    } catch (err) {
      Logger.getInstance().debug('[TokenCliStorage] Failed to sync token to CLI accounts directory:', err);
    }
  }

  static readTokensFromCli(email: string): AccountTokens | null {
    try {
      const cliAccountTokenPath = path.join(PathUtils.getCliAccountsDir(), email, 'antigravity-oauth-token');
      if (!fs.existsSync(cliAccountTokenPath)) return null;

      const raw = fs.readFileSync(cliAccountTokenPath, 'utf-8');
      const data = JSON.parse(raw);
      const t = data?.token;
      if (t?.access_token && t?.refresh_token) {
        let expiresAt = Math.floor(Date.now() / 1000) + 3600;
        if (t.expiry) {
          const parsed = Math.floor(new Date(t.expiry).getTime() / 1000);
          if (!isNaN(parsed) && parsed > 0) expiresAt = parsed;
        }
        return {
          accessToken: t.access_token,
          refreshToken: t.refresh_token,
          expiresAt
        };
      }
    } catch (e) {
      Logger.getInstance().debug(`[TokenCliStorage] Failed to parse CLI token for ${email}`, e);
    }
    return null;
  }

  static discoverCliAccounts(
    existingAccounts: Account[],
    isValidEmail: (email: any) => boolean
  ): { updated: boolean; accounts: Account[] } {
    const cliAccountsDir = PathUtils.getCliAccountsDir();
    if (!fs.existsSync(cliAccountsDir)) {
      return { updated: false, accounts: existingAccounts };
    }

    try {
      const entries = fs.readdirSync(cliAccountsDir, { withFileTypes: true });
      let updated = false;
      const accounts = [...existingAccounts];

      for (const ent of entries) {
        if (ent.isDirectory() && isValidEmail(ent.name)) {
          const cliEmail = ent.name.trim().toLowerCase();
          if (!accounts.some(a => a.email.toLowerCase() === cliEmail)) {
            const namePart = cliEmail.split('@')[0];
            const displayName = namePart.charAt(0).toUpperCase() + namePart.slice(1);
            accounts.push({
              email: cliEmail,
              name: displayName,
              plan: 'unknown' as any,
              status: 'active' as any,
              balances: {},
              addedAt: new Date().toISOString(),
              isActive: false,
              hasDeviceProfile: false
            });
            updated = true;
          }
        }
      }
      return { updated, accounts };
    } catch (e) {
      Logger.getInstance().warn('[TokenCliStorage] Failed to auto-discover CLI accounts', e);
      return { updated: false, accounts: existingAccounts };
    }
  }
}
