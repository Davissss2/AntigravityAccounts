/**
 * Account Repository Implementation
 *
 * Concrete implementation of IAccountRepository.
 * Uses VS Code `globalState` for non-sensitive data,
 * and `SecretStorage` for OAuth tokens.
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { IAccountRepository } from '../../core/domain/repositories/account.repository';
import { Account, AccountCreationData, AccountTokens, AccountSummary } from '../../core/domain/models/account.model';
import { DeviceProfile } from '../../core/domain/models/device-profile.model';
import { Workflow } from '../../core/domain/models/workflow.model';
import { STORAGE_KEYS, SECRET_KEYS } from '../../core/constants/app.constants';
import { Logger } from '../../core/utils/logger';
import { PathUtils } from '../../core/utils/path.utils';

export class AccountRepositoryImpl implements IAccountRepository {
  constructor(private context: vscode.ExtensionContext) {}

  async getAllAccounts(): Promise<Account[]> {
    const raw = this.context.globalState.get<Account[]>(STORAGE_KEYS.ACCOUNTS_LIST, []);
    const isValidEmail = (email: any): boolean =>
      typeof email === 'string' && email.includes('@') && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());

    const valid = raw.filter(a => a && isValidEmail(a.email));
    if (valid.length !== raw.length) {
      const removedCount = raw.length - valid.length;
      Logger.getInstance().warn(`[AccountRepo] Purged ${removedCount} malformed/non-email account(s) from globalState.`);
      await this.context.globalState.update(STORAGE_KEYS.ACCOUNTS_LIST, valid);

      // Clean up orphaned secrets for invalid accounts
      for (const invalidAcc of raw) {
        if (!isValidEmail(invalidAcc?.email) && invalidAcc?.email) {
          try {
            await this.context.secrets.delete(SECRET_KEYS.REFRESH_TOKEN(invalidAcc.email));
            await this.context.secrets.delete(SECRET_KEYS.ACCESS_TOKEN(invalidAcc.email));
            await this.context.secrets.delete(SECRET_KEYS.METADATA(invalidAcc.email));
          } catch {}
        }
      }
    }

    if (PathUtils.isRemoteStandaloneMode(this.context)) {
      const cliAccountsDir = PathUtils.getCliAccountsDir();
      if (fs.existsSync(cliAccountsDir)) {
        try {
          const entries = fs.readdirSync(cliAccountsDir, { withFileTypes: true });
          let updated = false;
          for (const ent of entries) {
            if (ent.isDirectory() && isValidEmail(ent.name)) {
              const cliEmail = ent.name.trim().toLowerCase();
              if (!valid.some(a => a.email.toLowerCase() === cliEmail)) {
                const namePart = cliEmail.split('@')[0];
                const displayName = namePart.charAt(0).toUpperCase() + namePart.slice(1);
                valid.push({
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
          if (updated) {
            await this.context.globalState.update(STORAGE_KEYS.ACCOUNTS_LIST, valid);
          }
        } catch (e) {
          Logger.getInstance().warn('[AccountRepo] Failed to auto-discover CLI accounts', e);
        }
      }
    }

    return valid;
  }

  async getAccount(email: string): Promise<Account | null> {
    if (!email || !email.includes('@')) return null;
    const accounts = await this.getAllAccounts();
    return accounts.find(a => a.email.toLowerCase() === email.toLowerCase()) || null;
  }

  async saveAccount(data: AccountCreationData): Promise<Account> {
    if (!data.email || !data.email.includes('@') || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(data.email.trim())) {
      throw new Error(`[AccountRepo] Cannot save account with invalid email: '${data.email}'`);
    }
    const accounts = await this.getAllAccounts();
    
    // Check if exists
    const existingIndex = accounts.findIndex(a => a.email === data.email);
    
    // Map Creation Data to Domain Model
    const newAccount: Account = {
      email: data.email,
      name: data.name,
      avatarUrl: data.avatarUrl,
      projectId: data.projectId,
      plan: 'unknown' as any, // Will be updated later by API
      status: 'active' as any,
      balances: {},
      addedAt: new Date().toISOString(),
      isActive: false,
      hasDeviceProfile: false,
      workflow: data.workflow,
    };

    if (existingIndex >= 0) {
      // Keep existing data (like alias), update core info
      accounts[existingIndex] = {
        ...accounts[existingIndex],
        ...newAccount,
        workflow: data.workflow !== undefined ? data.workflow : accounts[existingIndex].workflow,
        addedAt: accounts[existingIndex].addedAt
      };
    } else {
      accounts.push(newAccount);
    }

    await this.context.globalState.update(STORAGE_KEYS.ACCOUNTS_LIST, accounts);

    // Save tokens securely
    await this.storeTokens(data.email, {
      accessToken: data.accessToken,
      refreshToken: data.refreshToken,
      expiresAt: data.expiresAt
    });

    Logger.getInstance().info(`Account saved/updated: ${data.email}`);
    return newAccount;
  }

  async removeAccount(email: string): Promise<void> {
    const accounts = await this.getAllAccounts();
    const filtered = accounts.filter(a => a.email !== email);
    await this.context.globalState.update(STORAGE_KEYS.ACCOUNTS_LIST, filtered);

    // Remove tokens securely
    await this.context.secrets.delete(SECRET_KEYS.REFRESH_TOKEN(email));
    await this.context.secrets.delete(SECRET_KEYS.ACCESS_TOKEN(email));
    await this.context.secrets.delete(SECRET_KEYS.METADATA(email));
    
    Logger.getInstance().info(`Account removed: ${email}`);
  }

  async updateAccount(email: string, updates: Partial<Account>): Promise<void> {
    const accounts = await this.getAllAccounts();
    const index = accounts.findIndex(a => a.email === email);
    
    if (index >= 0) {
      accounts[index] = { ...accounts[index], ...updates };
      await this.context.globalState.update(STORAGE_KEYS.ACCOUNTS_LIST, accounts);
    }
  }

  async getActiveAccountEmail(): Promise<string | null> {
    return this.context.globalState.get<string | null>(STORAGE_KEYS.ACTIVE_ACCOUNT, null);
  }

  async setActiveAccount(email: string | null): Promise<void> {
    const accounts = await this.getAllAccounts();
    
    // Deactivate all, activate the target
    const updatedAccounts = accounts.map(a => ({
      ...a,
      isActive: email !== null && a.email.toLowerCase() === email.toLowerCase()
    }));

    await this.context.globalState.update(STORAGE_KEYS.ACCOUNTS_LIST, updatedAccounts);
    await this.context.globalState.update(STORAGE_KEYS.ACTIVE_ACCOUNT, email || undefined);
    
    Logger.getInstance().info(`Active account set to: ${email}`);
  }

  async setActiveAccountEmail(email: string | null): Promise<void> {
    return this.setActiveAccount(email);
  }

  async storeTokens(email: string, tokens: AccountTokens): Promise<void> {
    try {
      // Never overwrite a valid refresh token with an empty or whitespace string
      if (tokens.refreshToken && tokens.refreshToken.trim()) {
        await this.context.secrets.store(SECRET_KEYS.REFRESH_TOKEN(email), tokens.refreshToken.trim());
      }
      if (tokens.accessToken && tokens.accessToken.trim()) {
        await this.context.secrets.store(SECRET_KEYS.ACCESS_TOKEN(email), tokens.accessToken.trim());
      }
      // Expiration and granted-scope metadata. Scopes are preserved when a caller
      // stores a token set that does not carry them (e.g. an adopted IDE session),
      // so a refresh learned once is not forgotten on the next write.
      if (tokens.expiresAt || tokens.scopes?.length) {
        let scopes = tokens.scopes?.length ? tokens.scopes : undefined;
        if (!scopes) {
          try {
            const previous = await this.context.secrets.get(SECRET_KEYS.METADATA(email));
            const parsed = previous ? JSON.parse(previous) : null;
            if (Array.isArray(parsed?.scopes) && parsed.scopes.length > 0) {
              scopes = parsed.scopes;
            }
          } catch { /* keep scopes unknown */ }
        }
        const metadata: { expiresAt?: number; scopes?: string[] } = { expiresAt: tokens.expiresAt };
        if (scopes?.length) metadata.scopes = scopes;
        await this.context.secrets.store(SECRET_KEYS.METADATA(email), JSON.stringify(metadata));
      }
    } catch (err) {
      Logger.getInstance().debug(`[AccountRepo] SecretStorage store failed for ${email} (headless environment):`, err);
    }

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
      Logger.getInstance().debug(`[AccountRepo] Failed to sync token to CLI accounts directory:`, err);
    }
  }

  async getTokens(email: string): Promise<AccountTokens | null> {
    try {
      let refreshToken: string | undefined;
      let accessToken: string | undefined;
      let metaStr: string | undefined;

      try {
        refreshToken = await this.context.secrets.get(SECRET_KEYS.REFRESH_TOKEN(email));
        accessToken = await this.context.secrets.get(SECRET_KEYS.ACCESS_TOKEN(email));
        metaStr = await this.context.secrets.get(SECRET_KEYS.METADATA(email));

        if (!refreshToken || !accessToken) {
          const lower = email.toLowerCase();
          if (lower !== email) {
            refreshToken = await this.context.secrets.get(SECRET_KEYS.REFRESH_TOKEN(lower));
            accessToken = await this.context.secrets.get(SECRET_KEYS.ACCESS_TOKEN(lower));
            metaStr = await this.context.secrets.get(SECRET_KEYS.METADATA(lower));
          }
        }
      } catch (secErr) {
        Logger.getInstance().debug(`[AccountRepo] SecretStorage read failed for ${email}`, secErr);
      }

      if (refreshToken && accessToken) {
        const meta = metaStr ? JSON.parse(metaStr) : { expiresAt: 0 };
        return {
          refreshToken,
          accessToken,
          expiresAt: meta.expiresAt,
          scopes: Array.isArray(meta.scopes) && meta.scopes.length > 0 ? meta.scopes : undefined
        };
      }

      // Standalone / CLI token fallback
      const cliAccountTokenPath = path.join(PathUtils.getCliAccountsDir(), email, 'antigravity-oauth-token');
      if (fs.existsSync(cliAccountTokenPath)) {
        try {
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
          Logger.getInstance().debug(`[AccountRepo] Failed to parse CLI token for ${email}`, e);
        }
      }

      return null;
    } catch (e) {
      Logger.getInstance().error(`Failed to retrieve tokens for ${email}`, e);
      return null;
    }
  }

  async getAccountSummaries(): Promise<AccountSummary[]> {
    const accounts = await this.getAllAccounts();
    return accounts.map(a => ({
      email: a.email,
      displayName: a.alias || a.name || a.email,
      alias: a.alias,
      avatarUrl: a.avatarUrl,
      balances: a.balances,
      status: a.status,
      isActive: a.isActive,
      workflow: a.workflow,
    }));
  }

  // ── Device Profile Storage (SecretStorage) ──────────────────────────────────

  private deviceProfileKey(email: string): string {
    return `antigravityAccount.secure.${email}.deviceProfile`;
  }

  async storeDeviceProfile(email: string, profile: DeviceProfile): Promise<void> {
    try {
      await this.context.secrets.store(
        this.deviceProfileKey(email),
        JSON.stringify(profile)
      );
    } catch (e) {
      Logger.getInstance().debug(`[AccountRepo] SecretStorage device profile store failed for ${email}`, e);
    }
    // Mark account as having a device profile
    await this.updateAccount(email, { hasDeviceProfile: true } as Partial<Account>);
    Logger.getInstance().info(`Device profile stored securely for: ${email}`);
  }

  async getDeviceProfile(email: string): Promise<DeviceProfile | null> {
    try {
      const raw = await this.context.secrets.get(this.deviceProfileKey(email));
      if (!raw) return null;
      return JSON.parse(raw) as DeviceProfile;
    } catch (e) {
      Logger.getInstance().debug(`Failed to retrieve device profile for ${email}`, e);
      return null;
    }
  }

  // ── Preferred Model Setting ─────────────────────────────────────────────────

  async getPreferredModel(): Promise<string | null> {
    return this.context.globalState.get<string | null>(STORAGE_KEYS.PREFERRED_MODEL, null);
  }

  async setPreferredModel(modelKey: string): Promise<void> {
    await this.context.globalState.update(STORAGE_KEYS.PREFERRED_MODEL, modelKey);
    Logger.getInstance().info(`Preferred model set to: ${modelKey || '(none)'}`);
  }

  // ── Global Balance Refresh Timestamp ────────────────────────────────────────

  async getBalancesLastRefreshed(): Promise<number> {
    return this.context.globalState.get<number>(STORAGE_KEYS.BALANCES_LAST_REFRESHED, 0);
  }

  async setBalancesLastRefreshed(timestampMs: number): Promise<void> {
    await this.context.globalState.update(STORAGE_KEYS.BALANCES_LAST_REFRESHED, timestampMs);
  }

  // ── Pending Refresh Accounts (Resume on Relaunch) ───────────────────────────

  async getPendingRefreshEmails(): Promise<string[]> {
    return this.context.globalState.get<string[]>(STORAGE_KEYS.PENDING_REFRESH_EMAILS, []);
  }

  async setPendingRefreshEmails(emails: string[]): Promise<void> {
    await this.context.globalState.update(STORAGE_KEYS.PENDING_REFRESH_EMAILS, emails);
  }

  // ── Workflow Management ───────────────────────────────────────────────────

  async getWorkflows(): Promise<Workflow[]> {
    return this.context.globalState.get<Workflow[]>(STORAGE_KEYS.WORKFLOWS, []);
  }

  async saveWorkflow(workflow: Workflow): Promise<void> {
    const workflows = await this.getWorkflows();
    const index = workflows.findIndex(w => w.id === workflow.id);
    if (index >= 0) {
      workflows[index] = { ...workflows[index], ...workflow };
    } else {
      workflows.push(workflow);
    }
    await this.context.globalState.update(STORAGE_KEYS.WORKFLOWS, workflows);
    Logger.getInstance().info(`Workflow saved: ${workflow.name} (${workflow.id})`);
  }

  async deleteWorkflow(workflowId: string): Promise<void> {
    const workflows = await this.getWorkflows();
    const filtered = workflows.filter(w => w.id !== workflowId);
    await this.context.globalState.update(STORAGE_KEYS.WORKFLOWS, filtered);

    // Unassign accounts that belonged to this workflow (do not delete the accounts!)
    const accounts = await this.getAllAccounts();
    let accountsUpdated = false;
    for (const acc of accounts) {
      if (acc.workflow === workflowId) {
        acc.workflow = undefined;
        accountsUpdated = true;
      }
    }
    if (accountsUpdated) {
      await this.context.globalState.update(STORAGE_KEYS.ACCOUNTS_LIST, accounts);
    }

    // Reset active workflow if it was the deleted one
    const activeWf = await this.getActiveWorkflowId();
    if (activeWf === workflowId) {
      await this.setActiveWorkflowId(null);
    }

    Logger.getInstance().info(`Workflow deleted: ${workflowId}`);
  }

  async renameWorkflow(workflowId: string, newName: string): Promise<void> {
    const workflows = await this.getWorkflows();
    const target = workflows.find(w => w.id === workflowId);
    if (target) {
      target.name = newName.trim();
      await this.context.globalState.update(STORAGE_KEYS.WORKFLOWS, workflows);
      Logger.getInstance().info(`Workflow ${workflowId} renamed to: ${newName}`);
    }
  }

  async getActiveWorkflowId(): Promise<string | null> {
    return this.context.globalState.get<string | null>(STORAGE_KEYS.ACTIVE_WORKFLOW, null);
  }

  async setActiveWorkflowId(workflowId: string | null): Promise<void> {
    await this.context.globalState.update(STORAGE_KEYS.ACTIVE_WORKFLOW, workflowId);
    Logger.getInstance().info(`Active workflow set to: ${workflowId || '(all)'}`);
  }

  async assignAccountsToWorkflow(emails: string[], workflowId?: string): Promise<void> {
    const emailSet = new Set(emails.map(e => e.toLowerCase().trim()));
    const accounts = await this.getAllAccounts();
    let updated = false;

    for (const acc of accounts) {
      if (emailSet.has(acc.email.toLowerCase().trim())) {
        if (workflowId) {
          acc.workflow = workflowId;
        } else {
          delete acc.workflow;
        }
        updated = true;
      }
    }

    if (updated) {
      await this.context.globalState.update(STORAGE_KEYS.ACCOUNTS_LIST, accounts);
      Logger.getInstance().info(`Assigned ${emails.length} accounts to workflow: ${workflowId || '(none)'}`);
    }
  }
}

