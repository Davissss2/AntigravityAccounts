/**
 * Account Repository Implementation
 *
 * Concrete implementation of IAccountRepository.
 * Uses VS Code `globalState` for non-sensitive data,
 * and `SecretStorage` for OAuth tokens.
 */

import * as vscode from 'vscode';
import { IAccountRepository } from '../../core/domain/repositories/account.repository';
import { Account, AccountCreationData, AccountTokens, AccountSummary } from '../../core/domain/models/account.model';
import { DeviceProfile } from '../../core/domain/models/device-profile.model';
import { Workflow } from '../../core/domain/models/workflow.model';
import { STORAGE_KEYS, SECRET_KEYS } from '../../core/constants/app.constants';
import { Logger } from '../../core/utils/logger';
import { PathUtils } from '../../core/utils/path.utils';
import { isEmailMatch } from '../../core/utils/account.utils';
import { WorkflowStorage } from './workflow.storage';
import { TokenCliStorage } from './token-cli.storage';

export class AccountRepositoryImpl implements IAccountRepository {
  private workflowStorage: WorkflowStorage;

  constructor(private context: vscode.ExtensionContext) {
    this.workflowStorage = new WorkflowStorage(context);
  }

  async getAllAccounts(): Promise<Account[]> {
    const raw = this.context.globalState.get<Account[]>(STORAGE_KEYS.ACCOUNTS_LIST, []);
    const isValidEmail = (email: any): boolean =>
      typeof email === 'string' && email.includes('@') && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());

    const valid = raw.filter(a => a && isValidEmail(a.email));
    if (valid.length !== raw.length) {
      const removedCount = raw.length - valid.length;
      Logger.getInstance().warn(`[AccountRepo] Purged ${removedCount} malformed/non-email account(s) from globalState.`);
      await this.context.globalState.update(STORAGE_KEYS.ACCOUNTS_LIST, valid);

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
      const discovery = TokenCliStorage.discoverCliAccounts(valid, isValidEmail);
      if (discovery.updated) {
        await this.context.globalState.update(STORAGE_KEYS.ACCOUNTS_LIST, discovery.accounts);
        return discovery.accounts;
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
    const existingIndex = accounts.findIndex(a => a.email === data.email);

    const newAccount: Account = {
      email: data.email,
      name: data.name,
      avatarUrl: data.avatarUrl,
      projectId: data.projectId,
      plan: 'unknown' as any,
      status: 'active' as any,
      balances: {},
      addedAt: new Date().toISOString(),
      isActive: false,
      hasDeviceProfile: false,
      workflow: data.workflow,
    };

    if (existingIndex >= 0) {
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
    const filtered = accounts.filter(a => !isEmailMatch(a.email, email));
    await this.context.globalState.update(STORAGE_KEYS.ACCOUNTS_LIST, filtered);

    const cleanEmail = email.trim().toLowerCase();
    await this.context.secrets.delete(SECRET_KEYS.REFRESH_TOKEN(email));
    await this.context.secrets.delete(SECRET_KEYS.ACCESS_TOKEN(email));
    await this.context.secrets.delete(SECRET_KEYS.METADATA(email));
    if (cleanEmail !== email) {
      await this.context.secrets.delete(SECRET_KEYS.REFRESH_TOKEN(cleanEmail));
      await this.context.secrets.delete(SECRET_KEYS.ACCESS_TOKEN(cleanEmail));
      await this.context.secrets.delete(SECRET_KEYS.METADATA(cleanEmail));
    }

    const active = await this.getActiveAccountEmail();
    if (active && isEmailMatch(active, email)) {
      await this.setActiveAccount(null);
    }

    Logger.getInstance().info(`Account removed: ${email}`);
  }

  async updateAccount(email: string, updates: Partial<Account>): Promise<void> {
    const accounts = await this.getAllAccounts();
    const index = accounts.findIndex(a => isEmailMatch(a.email, email));

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
      if (tokens.refreshToken && tokens.refreshToken.trim()) {
        await this.context.secrets.store(SECRET_KEYS.REFRESH_TOKEN(email), tokens.refreshToken.trim());
      }
      if (tokens.accessToken && tokens.accessToken.trim()) {
        await this.context.secrets.store(SECRET_KEYS.ACCESS_TOKEN(email), tokens.accessToken.trim());
      }
      if (tokens.expiresAt || tokens.scopes?.length) {
        let scopes = tokens.scopes?.length ? tokens.scopes : undefined;
        if (!scopes) {
          try {
            const previous = await this.context.secrets.get(SECRET_KEYS.METADATA(email));
            const parsed = previous ? JSON.parse(previous) : null;
            if (Array.isArray(parsed?.scopes) && parsed.scopes.length > 0) {
              scopes = parsed.scopes;
            }
          } catch {}
        }
        const metadata: { expiresAt?: number; scopes?: string[] } = { expiresAt: tokens.expiresAt };
        if (scopes?.length) metadata.scopes = scopes;
        await this.context.secrets.store(SECRET_KEYS.METADATA(email), JSON.stringify(metadata));
      }
    } catch (err) {
      Logger.getInstance().debug(`[AccountRepo] SecretStorage store failed for ${email} (headless environment):`, err);
    }

    TokenCliStorage.syncTokensToCli(email, tokens);
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

      return TokenCliStorage.readTokensFromCli(email);
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

  // ── Device Profile Storage ──────────────────────────────────────────────────

  private deviceProfileKey(email: string): string {
    return `antigravityAccount.secure.${email}.deviceProfile`;
  }

  async storeDeviceProfile(email: string, profile: DeviceProfile): Promise<void> {
    try {
      await this.context.secrets.store(this.deviceProfileKey(email), JSON.stringify(profile));
    } catch (e) {
      Logger.getInstance().debug(`[AccountRepo] SecretStorage device profile store failed for ${email}`, e);
    }
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

  // ── Preferred Model & Timestamps ───────────────────────────────────────────

  async getPreferredModel(): Promise<string | null> {
    return this.context.globalState.get<string | null>(STORAGE_KEYS.PREFERRED_MODEL, null);
  }

  async setPreferredModel(modelKey: string): Promise<void> {
    await this.context.globalState.update(STORAGE_KEYS.PREFERRED_MODEL, modelKey);
    Logger.getInstance().info(`Preferred model set to: ${modelKey || '(none)'}`);
  }

  async getBalancesLastRefreshed(): Promise<number> {
    return this.context.globalState.get<number>(STORAGE_KEYS.BALANCES_LAST_REFRESHED, 0);
  }

  async setBalancesLastRefreshed(timestampMs: number): Promise<void> {
    await this.context.globalState.update(STORAGE_KEYS.BALANCES_LAST_REFRESHED, timestampMs);
  }

  async getPendingRefreshEmails(): Promise<string[]> {
    return this.context.globalState.get<string[]>(STORAGE_KEYS.PENDING_REFRESH_EMAILS, []);
  }

  async setPendingRefreshEmails(emails: string[]): Promise<void> {
    await this.context.globalState.update(STORAGE_KEYS.PENDING_REFRESH_EMAILS, emails);
  }

  // ── Workflows Delegated to WorkflowStorage ──────────────────────────────────

  async getWorkflows(): Promise<Workflow[]> {
    return this.workflowStorage.getWorkflows();
  }

  async saveWorkflow(workflow: Workflow): Promise<void> {
    return this.workflowStorage.saveWorkflow(workflow);
  }

  async deleteWorkflow(workflowId: string): Promise<void> {
    return this.workflowStorage.deleteWorkflow(
      workflowId,
      () => this.getAllAccounts(),
      accs => this.context.globalState.update(STORAGE_KEYS.ACCOUNTS_LIST, accs)
    );
  }

  async renameWorkflow(workflowId: string, newName: string): Promise<void> {
    return this.workflowStorage.renameWorkflow(workflowId, newName);
  }

  async getActiveWorkflowId(): Promise<string | null> {
    return this.workflowStorage.getActiveWorkflowId();
  }

  async setActiveWorkflowId(workflowId: string | null): Promise<void> {
    return this.workflowStorage.setActiveWorkflowId(workflowId);
  }

  async assignAccountsToWorkflow(emails: string[], workflowId?: string): Promise<void> {
    return this.workflowStorage.assignAccountsToWorkflow(
      emails,
      workflowId,
      () => this.getAllAccounts(),
      accs => this.context.globalState.update(STORAGE_KEYS.ACCOUNTS_LIST, accs)
    );
  }
}
