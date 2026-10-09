/**
 * Account Service (Use Cases / Logic)
 * 
 * Orchestrates the interactions between Auth, API, and DB services.
 * Implements the core workflows of the extension.
 */

import * as vscode from 'vscode';
import { AuthService } from '../../infrastructure/auth/auth.service';
import { BalanceService } from '../../infrastructure/api/balance.service';
import { IAccountRepository } from '../../core/domain/repositories/account.repository';
import { StateDbService } from '../../infrastructure/storage/state-db.service';
import { Logger } from '../../core/utils/logger';
import { I18nService } from '../../i18n/i18n.service';
import { Account, AccountPlan, AccountStatus } from '../../core/domain/models/account.model';
import { ExtensionConfig } from '../../core/config/extension.config';
import { generateDeviceProfile } from '../../core/domain/models/device-profile.model';
import { isEmailMatch } from '../../core/utils/account.utils';
import { getModelBalanceValue } from '../../core/utils/model.utils';
import { ApiClient } from '../../core/network/api.client';
import { OAUTH, AUTH_PROVIDERS } from '../../core/constants/app.constants';
import { ChatResumeUtils } from '../../core/utils/chat-resume.utils';
import { PathUtils } from '../../core/utils/path.utils';

export class AccountService {
  private _onAccountsChanged = new vscode.EventEmitter<void>();
  public readonly onAccountsChanged = this._onAccountsChanged.event;

  /** Guard to prevent multiple simultaneous account switches */
  private _isSwitching: boolean = false;
  /** Timestamp of the last fast quota check for the active account */
  private _lastActiveQuotaCheckTime: number = 0;

  /** Manually fire the accounts changed event (e.g. after import) */
  public emitAccountsChanged(): void {
    this._onAccountsChanged.fire();
  }

  /** Cancel any scheduled queued refresh */
  public cancelQueue(): void {
    if (this._queuedTimeout) {
      clearTimeout(this._queuedTimeout);
      this._queuedTimeout = null;
      Logger.getInstance().info('Queued refresh cancelled.');
    }
  }

  /** Timestamp of the last successful refresh start (ms) */
  private _lastRefreshTime: number = 0;
  /** Minimum interval between global refreshes in milliseconds (60 seconds) */
  private static readonly REFRESH_COOLDOWN_MS = 60_000;
  /** Whether a refresh is currently in progress */
  private _isRefreshing: boolean = false;
  /** Timeout for automatic queued refresh */
  private _queuedTimeout: NodeJS.Timeout | null = null;
  /** Last email notified for native vs injected mismatch */
  private _lastNotifiedMismatchEmail: string | null = null;

  constructor(
    private authService: AuthService,
    private balanceService: BalanceService,
    private accountRepo: IAccountRepository,
    private stateDbService: StateDbService
  ) {}

  private async determineAccountStatus(
    balanceInfo: { balances: Record<string, any>; hasError: boolean; status?: AccountStatus; isDepleted?: boolean },
    preferredModel: string | null
  ): Promise<AccountStatus> {
    if (balanceInfo.status === AccountStatus.INELIGIBLE) {
      return AccountStatus.INELIGIBLE;
    }
    if (balanceInfo.isDepleted || balanceInfo.status === AccountStatus.DEPLETED) {
      return AccountStatus.DEPLETED;
    }
    if (balanceInfo.hasError) {
      return AccountStatus.ERROR;
    }

    const config = ExtensionConfig.getInstance();
    let isDepleted = false;
    let isLow = false;
    let totalCredits = 0;

    const primaryModelValues: number[] = [];
    for (const [k, rawV] of Object.entries(balanceInfo.balances)) {
      const lower = k.toLowerCase();
      // Filter out internal preview, tabs, chats
      if (lower.startsWith('chat') || lower.startsWith('tab') || lower.startsWith('tap')) {
        continue;
      }

      if (typeof rawV === 'object' && rawV !== null && 'value' in rawV) {
        primaryModelValues.push(rawV.value);
      } else {
        totalCredits += typeof rawV === 'number' ? rawV : Number(rawV);
      }
    }

    if (preferredModel) {
      const prefValue = getModelBalanceValue(balanceInfo.balances, preferredModel);
      if (prefValue === 0) {
        isDepleted = true;
      } else if (prefValue > 0 && prefValue < 20) {
        isLow = true;
      } else if (prefValue === -1) {
        const hasModelsWithQuota = primaryModelValues.some(val => val > 0);
        if (primaryModelValues.length > 0 && !hasModelsWithQuota && totalCredits <= 0) {
          isDepleted = true;
        } else if (totalCredits <= config.getLowCreditThreshold()) {
          isLow = true;
        }
      }
    } else {
      const hasModelsWithQuota = primaryModelValues.some(val => val > 0);
      if (primaryModelValues.length > 0 && !hasModelsWithQuota && totalCredits <= 0) {
        isDepleted = true;
      } else if (totalCredits <= config.getLowCreditThreshold()) {
        isLow = true;
      }
    }

    if (isDepleted) return AccountStatus.DEPLETED;
    if (isLow) return AccountStatus.LOW_BALANCE;
    return AccountStatus.ACTIVE;
  }

  /**
   * Workflow: Add a new Google account
   * Authenticates, fetches initial balance (fails gracefully), and saves locally.
   */
  async addAccountWorkflow(): Promise<void> {
    const i18n = I18nService.getInstance();
    
    try {
      await vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: i18n.t('auth.signingIn'),
        cancellable: false
      }, async (progress) => {
        
        // 1. Authenticate via Browser
        const { tokens, profile } = await this.authService.login();

        progress.report({ message: i18n.t('common.loading') });

        // 2. Fetch Initial Balance (Decision 1: Fails gracefully)
        const balanceInfo = await this.balanceService.getBalanceInfo(tokens.accessToken);
        
        // 3. Save core account data and secure tokens
        const expiresAt = Math.floor(Date.now() / 1000) + tokens.expiresIn;
        await this.accountRepo.saveAccount({
          email: profile.email,
          name: profile.name,
          avatarUrl: profile.picture,
          projectId: balanceInfo.projectId,
          accessToken: tokens.accessToken,
          refreshToken: tokens.refreshToken,
          expiresAt: expiresAt
        });

        // Determine status based on config thresholds
        const preferredModel = await this.accountRepo.getPreferredModel();
        const finalStatus = await this.determineAccountStatus(balanceInfo, preferredModel);

        // 4. Update dynamic properties (balances, plan)
        await this.accountRepo.updateAccount(profile.email, {
          balances: balanceInfo.balances,
          plan: balanceInfo.plan,
          status: finalStatus,
          lastRefreshedAt: new Date().toISOString()
        });

        // 5. Generate unique Device Profile for this account
        progress.report({ message: i18n.t('service.generatingDeviceProfile') });
        const existingProfile = await this.accountRepo.getDeviceProfile(profile.email);
        if (!existingProfile) {
          const deviceProfile = generateDeviceProfile();
          await this.accountRepo.storeDeviceProfile(profile.email, deviceProfile);
          Logger.getInstance().info(`Generated new device profile for ${profile.email}`);
        }

        // 6. Notify User
        if (finalStatus === AccountStatus.INELIGIBLE) {
          vscode.window.showWarningMessage(i18n.t('service.accountIneligible', { email: profile.email }));
        } else if (balanceInfo.hasError) {
          vscode.window.showWarningMessage(i18n.t('service.accountAddedErrorBalance', { email: profile.email }));
        } else {
          const formattedBalances = Object.entries(balanceInfo.balances).map(([k, v]) => `${k}: ${v}`).join(' | ');
          vscode.window.showInformationMessage(i18n.t('service.accountAddedSuccess', { email: profile.email, balances: formattedBalances }));
        }
        
        this._onAccountsChanged.fire();
      });
    } catch (error: any) {
      Logger.getInstance().error('Add account workflow failed', error);
      vscode.window.showErrorMessage(i18n.t('service.accountAddError', { error: error.message }));
    }
  }

  /**
   * Workflow: Switch active account
   * Validates/refreshes token, injects into SQLite, and marks active.
   */
  async switchAccountWorkflow(email: string, options?: { skipPrompt?: boolean }): Promise<'success' | 'cancelled' | 'error'> {
    const account = await this.accountRepo.getAccount(email);
    if (!account) return 'error';

    const i18n = I18nService.getInstance();
    if (account.status === AccountStatus.INELIGIBLE) {
      vscode.window.showErrorMessage(i18n.t('service.switchIneligibleAccount', { email }));
      return 'error';
    }

    let tokens = await this.accountRepo.getTokens(email);
    if (!tokens) {
      vscode.window.showErrorMessage(i18n.t('service.missingLoginData', { email }));
      return 'error';
    }

    // Decision 2: Pre-emptive Token Refresh (Add 5-minute buffer)
    const now = Math.floor(Date.now() / 1000);
    if (tokens.refreshToken && tokens.expiresAt < (now + 300)) {
      Logger.getInstance().info(`Token for ${email} is expired or expiring soon. Refreshing before injection...`);
      try {
        const newTokens = await this.authService.refreshAccessToken(tokens.refreshToken);
        tokens = {
          accessToken: newTokens.accessToken,
          refreshToken: newTokens.refreshToken, // Keeps original if response omits it
          expiresAt: now + newTokens.expiresIn
        };
        await this.accountRepo.storeTokens(email, tokens);
        Logger.getInstance().info(`Token refreshed successfully for ${email}`);
      } catch (e: any) {
        Logger.getInstance().error(`Failed to refresh token for ${email}`, e);
        const i18n = I18nService.getInstance();
        vscode.window.showErrorMessage(i18n.t('service.sessionExpiredFailed', { email }));
        await this.accountRepo.updateAccount(email, { status: AccountStatus.TOKEN_EXPIRED });
        return 'error';
      }
    } else if (!tokens.refreshToken && tokens.expiresAt <= now) {
      // Access token expired and no refresh token is stored yet
      const i18n = I18nService.getInstance();
      vscode.window.showErrorMessage(i18n.t('service.sessionExpiredFailed', { email }));
      await this.accountRepo.updateAccount(email, { status: AccountStatus.TOKEN_EXPIRED });
      return 'error';
    }

    // Ensure device profile exists (generate if missing — for accounts added before this feature)
    let deviceProfile = await this.accountRepo.getDeviceProfile(email);
    if (!deviceProfile) {
      Logger.getInstance().info(`No device profile found for ${email}. Generating one now...`);
      deviceProfile = generateDeviceProfile();
      await this.accountRepo.storeDeviceProfile(email, deviceProfile);
    } else if (!deviceProfile.firstSessionDate) {
      // Backward compatibility: older profiles lack firstSessionDate.
      // Generate only the missing field; keep all other IDs stable.
      const { generatePlausibleFirstSessionDate } = await import('../../core/domain/models/device-profile.model');
      deviceProfile.firstSessionDate = generatePlausibleFirstSessionDate();
      await this.accountRepo.storeDeviceProfile(email, deviceProfile);
      Logger.getInstance().info(`Migrated device profile for ${email}: added firstSessionDate.`);
    }

    // Inject into Database (tokens + device profile + telemetry)
    const result = await this.stateDbService.injectAccountState(account, tokens, deviceProfile, options?.skipPrompt);
    
    if (result === 'success') {
      try {
        await this.accountRepo.setActiveAccountEmail(email.toLowerCase());
      } catch {}
      this._onAccountsChanged.fire();
      // NOTE: Window reload is handled by StateDbService if user consents
      return 'success';
    } else if (result === 'cancelled') {
      return 'cancelled';
    } else {
      const i18n = I18nService.getInstance();
      vscode.window.showErrorMessage(i18n.t('service.switchFailed', { email }));
      return 'error';
    }
  }

  /**
   * Get the currently active account email directly from Antigravity's live session or state database.
   * Prioritizes live native auth session (antigravity_auth / google) in memory (~0ms) before disk state.vscdb.
   */
  async getActiveAntigravityEmail(): Promise<string | null | undefined> {
    try {
      // 1. FAST IN-MEMORY LIVE AUTH: Query Antigravity native session directly
      try {
        const nativeEmail = await Promise.race([
          this.getNativeAuthEmail(),
          new Promise<undefined>(r => setTimeout(() => r(undefined), 1000))
        ]);
        if (nativeEmail) {
          return nativeEmail.toLowerCase();
        }
      } catch (err) {
        Logger.getInstance().debug('Failed to get live native auth email', err);
      }

      // 2. FALLBACK: Read directly from state.vscdb
      try {
        const dbEmail = await Promise.race([
          this.stateDbService.readCurrentEmailFromDb(),
          new Promise<undefined>(r => setTimeout(() => r(undefined), 1500))
        ]);
        if (dbEmail) {
          return dbEmail.toLowerCase();
        }
      } catch (err) {
        Logger.getInstance().debug('Failed to read email from state.vscdb', err);
      }

      // 3. PERSISTENCE FALLBACK: If repository has an active account recorded, preserve it
      // so temporary startup delays never wipe out the active account pin
      try {
        const repoActive = await this.accountRepo.getActiveAccountEmail();
        if (repoActive) {
          return repoActive.toLowerCase();
        }
      } catch {}

      return null;
    } catch (error) {
      Logger.getInstance().error('Failed to read active account from Antigravity', error);
      return undefined;
    }
  }

  /**
   * Get the active account's tokens directly from Antigravity's state database.
   */
  async getActiveAntigravityTokens(): Promise<{ accessToken: string; refreshToken: string; expiresAt: number } | null> {
    try {
      const activeInfo = await this.getActiveAntigravityAccountInfo();
      if (activeInfo?.tokens) {
        return activeInfo.tokens;
      }
      return await this.stateDbService.readActiveTokensFromDb();
    } catch (error) {
      Logger.getInstance().error('Failed to read active tokens from Antigravity', error);
      return null;
    }
  }

  /**
   * Get the active account's email and tokens from live IDE session or Antigravity's state database.
   * Prioritizes live in-memory native auth session to guarantee valid, non-expired tokens.
   */
  async getActiveAntigravityAccountInfo(): Promise<{ email: string | null; tokens: { accessToken: string; refreshToken: string; expiresAt: number } | null; avatarUrl?: string | null } | null> {
    try {
      // 1. LIVE IN-MEMORY NATIVE SESSION
      const nativeSession = await this.getNativeAuthSession();
      if (nativeSession && nativeSession.tokens?.accessToken) {
        return {
          email: nativeSession.email,
          tokens: nativeSession.tokens,
          avatarUrl: nativeSession.avatarUrl
        };
      }

      // 2. FALLBACK: Static state.vscdb read
      return await this.stateDbService.readActiveAccountInfoFromDb();
    } catch (error) {
      Logger.getInstance().error('Failed to read active account info from Antigravity', error);
      return null;
    }
  }

  /**
   * Retrieves the live authentication session (email, tokens, profile) from VS Code / Antigravity IDE.
   * Checks Antigravity native auth ('antigravity_auth') and standard ('google').
   */
  async getNativeAuthSession(): Promise<{
    email: string;
    tokens: { accessToken: string; refreshToken: string; expiresAt: number };
    avatarUrl?: string;
    name?: string;
  } | null> {
    try {
      const providers = AUTH_PROVIDERS;
      const scopesOptions = [
        [],
        ['https://www.googleapis.com/auth/userinfo.email', 'https://www.googleapis.com/auth/userinfo.profile'],
        ['https://www.googleapis.com/auth/cloud-platform', 'https://www.googleapis.com/auth/userinfo.email', 'https://www.googleapis.com/auth/userinfo.profile'],
        ['email', 'profile']
      ];

      for (const providerId of providers) {
        let session: vscode.AuthenticationSession | undefined;

        for (const scopes of scopesOptions) {
          try {
            session = await vscode.authentication.getSession(providerId, scopes, { silent: true });
            if (session?.accessToken) break;
          } catch {}
        }

        if (!session?.accessToken && typeof (vscode.authentication as any).getAccounts === 'function') {
          try {
            const accounts = await (vscode.authentication as any).getAccounts(providerId);
            if (accounts && accounts.length > 0) {
              for (const scopes of scopesOptions) {
                try {
                  session = await vscode.authentication.getSession(providerId, scopes, {
                    silent: true,
                    account: accounts[0]
                  });
                  if (session?.accessToken) break;
                } catch {}
              }
            }
          } catch {}
        }

        if (session && session.accessToken) {
          let email: string | undefined;
          let name: string = session.account?.label || 'User';
          let avatarUrl: string | undefined;

          // Instant in-memory label resolution (0ms, avoids blocking network fetch)
          if (session.account?.label) {
            const raw = session.account.label.trim().toLowerCase();
            const cleaned = raw.replace(/\s*\(.*?\)\s*/g, '').trim();
            if (cleaned.includes('@')) {
              email = cleaned;
            } else if (cleaned.length > 0) {
              email = `${cleaned}@gmail.com`;
            }
          }

          // Only if email cannot be resolved from label, attempt userinfo with short 800ms timeout
          if (!email) {
            try {
              const userInfo = await ApiClient.request<{ email?: string; name?: string; picture?: string }>(
                OAUTH.USERINFO_URL,
                { accessToken: session.accessToken, timeoutMs: 800 }
              );
              if (userInfo?.email) email = userInfo.email.trim().toLowerCase();
              if (userInfo?.name) name = userInfo.name;
              if (userInfo?.picture) avatarUrl = userInfo.picture;
            } catch (e) {
              Logger.getInstance().debug(`[Native Auth] Google userinfo fetch failed for provider ${providerId}`, e);
            }
          }

          if (email && email.includes('@')) {
            let refreshToken = (session as any).refreshToken || '';
            if (!refreshToken) {
              try {
                const dbInfo = await this.stateDbService.readActiveAccountInfoFromDb();
                if (dbInfo?.email && isEmailMatch(dbInfo.email, email) && dbInfo.tokens?.refreshToken) {
                  refreshToken = dbInfo.tokens.refreshToken;
                }
              } catch {}
            }

            const expiresAt = Math.floor(Date.now() / 1000) + 3600;
            return {
              email,
              name,
              avatarUrl,
              tokens: {
                accessToken: session.accessToken,
                refreshToken,
                expiresAt
              }
            };
          }
        }
      }
      return null;
    } catch (err) {
      Logger.getInstance().debug('[Native Auth] Failed to query native auth session', err);
      return null;
    }
  }

  /**
   * Retrieves the email address of the active Google / Antigravity authentication session in the IDE.
   */
  async getNativeAuthEmail(): Promise<string | null> {
    try {
      const session = await this.getNativeAuthSession();
      return session?.email || null;
    } catch {
      return null;
    }
  }

  /**
   * Automatically captures and registers the active Antigravity account from state.vscdb
   * if the user logged in directly through Antigravity IDE without adding it manually.
   */
  async syncActiveAccountFromDb(forceRefresh: boolean = false): Promise<Account | null> {
    try {
      const activeInfo = await this.getActiveAntigravityAccountInfo();
      if (!activeInfo?.email) {
        return null;
      }

      const email = activeInfo.email?.trim().toLowerCase();
      if (!email || !email.includes('@') || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        Logger.getInstance().debug(`[Auto-Capture] Ignored non-email identifier from IDE: '${activeInfo.email}'`);
        return null;
      }
      let account = await this.accountRepo.getAccount(email);

      // Check if account is not registered yet
      if (!account) {
        const config = ExtensionConfig.getInstance();
        if (!config.isAutoCaptureAccountsEnabled()) {
          Logger.getInstance().debug(`[Auto-Capture] Skipped saving unregistered account ${email} (autoCaptureAccounts is disabled)`);
          return null;
        }

        Logger.getInstance().info(`[Auto-Capture] Detected new account logged into Antigravity IDE: ${email}`);

        let name = email.split('@')[0];
        let avatarUrl = (activeInfo as any).avatarUrl || undefined;

        if (activeInfo.tokens?.accessToken) {
          try {
            const userInfo = await ApiClient.request<{ name?: string; picture?: string }>(
              OAUTH.USERINFO_URL,
              { accessToken: activeInfo.tokens.accessToken, timeoutMs: 4000 }
            );
            if (userInfo.name) name = userInfo.name;
            if (userInfo.picture) avatarUrl = userInfo.picture;
          } catch (uiErr) {
            Logger.getInstance().debug(`[Auto-Capture] Could not fetch userinfo for ${email}, using defaults.`);
          }
        }

        const expiresAt = activeInfo.tokens?.expiresAt || (Math.floor(Date.now() / 1000) + 3600);
        const accessToken = activeInfo.tokens?.accessToken || '';
        const refreshToken = activeInfo.tokens?.refreshToken || '';

        // Save core account
        await this.accountRepo.saveAccount({
          email,
          name,
          avatarUrl,
          accessToken,
          refreshToken,
          expiresAt
        });

        // Generate and save unique device profile
        const existingProfile = await this.accountRepo.getDeviceProfile(email);
        if (!existingProfile) {
          const deviceProfile = generateDeviceProfile();
          await this.accountRepo.storeDeviceProfile(email, deviceProfile);
          Logger.getInstance().info(`[Auto-Capture] Generated device profile for ${email}`);
        }

        // Fetch initial balances immediately
        if (accessToken) {
          try {
            const balanceInfo = await this.balanceService.getBalanceInfo(accessToken);
            const preferredModel = await this.accountRepo.getPreferredModel();
            const status = await this.determineAccountStatus(balanceInfo, preferredModel);
            await this.accountRepo.updateAccount(email, {
              balances: balanceInfo.balances,
              plan: balanceInfo.plan,
              projectId: balanceInfo.projectId,
              status,
              lastRefreshedAt: new Date().toISOString()
            });
          } catch (balErr) {
            Logger.getInstance().warn(`[Auto-Capture] Failed to fetch initial balance for ${email}`, balErr);
          }
        }

        account = await this.accountRepo.getAccount(email);
        this._onAccountsChanged.fire();

        if (config.isNotificationsEnabled()) {
          const i18n = I18nService.getInstance();
          vscode.window.showInformationMessage(
            i18n.t('service.autoCapturedAccount', { email })
          );
        }

        return account;
      } else {
        // Account exists: keep tokens in sync if newer
        if (activeInfo.tokens) {
          const storedTokens = await this.accountRepo.getTokens(email);
          if (!storedTokens || storedTokens.accessToken !== activeInfo.tokens.accessToken || storedTokens.refreshToken !== activeInfo.tokens.refreshToken) {
            await this.accountRepo.storeTokens(email, activeInfo.tokens);
            Logger.getInstance().info(`[Auto-Capture] Synchronized updated tokens for active account ${email}`);
          }
        }

        // If it was expired or error, mark active since user has a valid active session
        if (account.status === AccountStatus.TOKEN_EXPIRED || account.status === AccountStatus.ERROR) {
          await this.accountRepo.updateAccount(email, { status: AccountStatus.ACTIVE });
          this._onAccountsChanged.fire();
        }

        if (forceRefresh) {
          await this.refreshActiveAccountFast(true);
        }

        return account;
      }
    } catch (err) {
      Logger.getInstance().error('Error during syncActiveAccountFromDb', err);
      return null;
    }
  }

  /**
   * Reconciles accounts between SecretStorage and the accounts repository.
   * If any accounts exist in SecretStorage with valid tokens but are missing from
   * the repository list, restores them, generates device profiles, and fetches their initial balance.
   */
  async reconcileOrphanedSecretAccounts(): Promise<Account[]> {
    try {
      const secretEmails = await this.stateDbService.findSecretAccountEmails();
      if (!secretEmails.length) return [];

      const restored: Account[] = [];
      for (const email of secretEmails) {
        const existing = await this.accountRepo.getAccount(email);
        if (existing) continue;

        // Account has credentials in SecretStorage but is missing from repository list
        const tokens = await this.accountRepo.getTokens(email);
        if (!tokens || !tokens.refreshToken) continue;

        Logger.getInstance().info(`[Reconcile] Restoring orphaned account found in SecretStorage: ${email}`);

        let name = email.split('@')[0];
        name = name.charAt(0).toUpperCase() + name.slice(1);
        let avatarUrl: string | undefined;

        // Try to fetch user info with access token if available
        if (tokens.accessToken) {
          try {
            const userInfo = await ApiClient.request<{ name?: string; picture?: string }>(
              OAUTH.USERINFO_URL,
              { accessToken: tokens.accessToken, timeoutMs: 3000 }
            );
            if (userInfo.name) name = userInfo.name;
            if (userInfo.picture) avatarUrl = userInfo.picture;
          } catch { /* use defaults */ }
        }

        await this.accountRepo.saveAccount({
          email,
          name,
          avatarUrl,
          accessToken: tokens.accessToken,
          refreshToken: tokens.refreshToken,
          expiresAt: tokens.expiresAt || (Math.floor(Date.now() / 1000) + 3600)
        });

        // Ensure device profile exists
        const deviceProfile = await this.accountRepo.getDeviceProfile(email);
        if (!deviceProfile) {
          await this.accountRepo.storeDeviceProfile(email, generateDeviceProfile());
        }

        // Fetch balance
        if (tokens.accessToken) {
          try {
            const balanceInfo = await this.balanceService.getBalanceInfo(tokens.accessToken);
            const preferredModel = await this.accountRepo.getPreferredModel();
            const status = await this.determineAccountStatus(balanceInfo, preferredModel);
            await this.accountRepo.updateAccount(email, {
              balances: balanceInfo.balances,
              plan: balanceInfo.plan,
              projectId: balanceInfo.projectId,
              status,
              lastRefreshedAt: new Date().toISOString()
            });
          } catch (balErr) {
            Logger.getInstance().warn(`[Reconcile] Failed balance fetch for restored account ${email}`);
          }
        }

        const reloaded = await this.accountRepo.getAccount(email);
        if (reloaded) restored.push(reloaded);
      }

      if (restored.length > 0) {
        Logger.getInstance().info(`[Reconcile] Successfully restored ${restored.length} account(s) from SecretStorage!`);
        this._onAccountsChanged.fire();
      }

      return restored;
    } catch (err) {
      Logger.getInstance().error('Error reconciling orphaned accounts from SecretStorage', err);
      return [];
    }
  }

  /**
   * Scans VS Code's authentication sessions for any Google/Antigravity accounts that are logged in
   * and auto-captures them into the extension repository if enabled.
   */
  async syncFromAuthenticationSessions(targetProviderId?: string): Promise<void> {
    try {
      const config = ExtensionConfig.getInstance();
      if (!config.isAutoCaptureAccountsEnabled()) return;

      const providerCandidates = targetProviderId 
        ? Array.from(new Set([targetProviderId, ...AUTH_PROVIDERS]))
        : Array.from(AUTH_PROVIDERS);

      const scopesOptions = [
        [],
        ['https://www.googleapis.com/auth/userinfo.email', 'https://www.googleapis.com/auth/userinfo.profile'],
        ['https://www.googleapis.com/auth/cloud-platform', 'https://www.googleapis.com/auth/userinfo.email', 'https://www.googleapis.com/auth/userinfo.profile'],
        ['email', 'profile']
      ];

      for (const providerId of providerCandidates) {
        try {
          let accounts: readonly vscode.AuthenticationSessionAccountInformation[] = [];
          if (typeof (vscode.authentication as any).getAccounts === 'function') {
            try {
              accounts = await (vscode.authentication as any).getAccounts(providerId);
            } catch {}
          }

          // Also check default session without account specified
          const sessionsToProcess: vscode.AuthenticationSession[] = [];
          for (const scopes of scopesOptions) {
            try {
              const defaultSession = await vscode.authentication.getSession(providerId, scopes, { silent: true });
              if (defaultSession?.accessToken) {
                sessionsToProcess.push(defaultSession);
                break;
              }
            } catch {}
          }

          // For each discovered account, query session
          for (const acc of accounts) {
            for (const scopes of scopesOptions) {
              try {
                const session = await vscode.authentication.getSession(providerId, scopes, {
                  silent: true,
                  account: acc
                });
                if (session?.accessToken && !sessionsToProcess.some(s => s.id === session.id || s.accessToken === session.accessToken)) {
                  sessionsToProcess.push(session);
                  break;
                }
              } catch {}
            }
          }

          for (const session of sessionsToProcess) {
            if (!session?.accessToken) continue;

            // Resolve real email using Google UserInfo API
            let email: string | undefined;
            let name: string = session.account?.label || 'User';
            let avatarUrl: string | undefined;

            try {
              const userInfo = await ApiClient.request<{ email?: string; name?: string; picture?: string }>(
                OAUTH.USERINFO_URL,
                { accessToken: session.accessToken, timeoutMs: 4000 }
              );
              if (userInfo?.email) email = userInfo.email.trim().toLowerCase();
              if (userInfo?.name) name = userInfo.name;
              if (userInfo?.picture) avatarUrl = userInfo.picture;
            } catch {
              // Fallback to account label
              if (session.account?.label) {
                const raw = session.account.label.trim();
                email = raw.includes('@') ? raw.toLowerCase() : `${raw.toLowerCase()}@gmail.com`;
              }
            }

            if (!email || !email.includes('@')) continue;

            // Attempt to link refresh token if in state.vscdb
            let refreshToken = (session as any).refreshToken || '';
            if (!refreshToken) {
              try {
                const dbInfo = await this.stateDbService.readActiveAccountInfoFromDb();
                if (dbInfo?.email && isEmailMatch(dbInfo.email, email) && dbInfo.tokens?.refreshToken) {
                  refreshToken = dbInfo.tokens.refreshToken;
                }
              } catch {}
            }

            const existing = await this.accountRepo.getAccount(email);
            if (!existing) {
              Logger.getInstance().info(`[Auth Monitor] Auto-capturing new account from ${providerId}: ${email}`);

              await this.accountRepo.saveAccount({
                email,
                name: name || email.split('@')[0],
                avatarUrl,
                accessToken: session.accessToken,
                refreshToken,
                expiresAt: Math.floor(Date.now() / 1000) + 3600
              });

              // Ensure device profile
              const existingProfile = await this.accountRepo.getDeviceProfile(email);
              if (!existingProfile) {
                await this.accountRepo.storeDeviceProfile(email, generateDeviceProfile());
              }

              // Fetch initial balances
              try {
                const balanceInfo = await this.balanceService.getBalanceInfo(session.accessToken);
                const preferredModel = await this.accountRepo.getPreferredModel();
                const status = await this.determineAccountStatus(balanceInfo, preferredModel);
                await this.accountRepo.updateAccount(email, {
                  balances: balanceInfo.balances,
                  plan: balanceInfo.plan,
                  projectId: balanceInfo.projectId,
                  status,
                  lastRefreshedAt: new Date().toISOString()
                });
              } catch (balErr) {
                Logger.getInstance().warn(`[Auth Monitor] Balance fetch failed for ${email}`, balErr);
              }

              this._onAccountsChanged.fire();
              if (config.isNotificationsEnabled()) {
                const i18n = I18nService.getInstance();
                vscode.window.showInformationMessage(
                  i18n.t('service.autoCapturedAccount', { email })
                );
              }
            } else {
              // Existing account: keep tokens up to date
              const storedTokens = await this.accountRepo.getTokens(email);
              const effectiveRefreshToken = refreshToken || storedTokens?.refreshToken || '';
              if (!storedTokens || storedTokens.accessToken !== session.accessToken || (!storedTokens.refreshToken && effectiveRefreshToken)) {
                await this.accountRepo.storeTokens(email, {
                  accessToken: session.accessToken,
                  refreshToken: effectiveRefreshToken,
                  expiresAt: Math.floor(Date.now() / 1000) + 3600
                });
                Logger.getInstance().info(`[Auth Monitor] Updated tokens for existing account: ${email}`);
              }

              if (existing.status === AccountStatus.TOKEN_EXPIRED || existing.status === AccountStatus.ERROR) {
                await this.accountRepo.updateAccount(email, { status: AccountStatus.ACTIVE });
                this._onAccountsChanged.fire();
              }
            }
          }
        } catch (provErr) {
          Logger.getInstance().debug(`Error checking provider ${providerId}`, provErr);
        }
      }
    } catch (e) {
      Logger.getInstance().debug('syncFromAuthenticationSessions error', e);
    }
  }

  /**
   * Helper: compute remaining usable quota percentage (0-100) for an account.
   * Examines preferred model first, or the lowest non-zero primary model balance.
   */
  getAccountUsableQuotaPercentage(account: Account, preferredModel?: string | null): number {
    if (!account || !account.balances) return 100;
    if (account.status === AccountStatus.DEPLETED || account.status === AccountStatus.TOKEN_EXPIRED || account.status === AccountStatus.ERROR || account.status === AccountStatus.INELIGIBLE) {
      return 0;
    }

    if (preferredModel) {
      const prefVal = getModelBalanceValue(account.balances, preferredModel);
      if (prefVal >= 0) return prefVal;
    }

    // Examine core models (ignoring internal tab/tap prefixes)
    const values: number[] = [];
    for (const [k, v] of Object.entries(account.balances)) {
      const lower = k.toLowerCase();
      if (lower.startsWith('chat') || lower.startsWith('tab') || lower.startsWith('tap')) continue;
      if (typeof v === 'object' && v !== null && 'value' in v) {
        values.push(typeof v.value === 'number' ? v.value : Number(v.value));
      }
    }

    if (values.length === 0) return 100;
    return Math.min(...values);
  }

  /**
   * Lightweight, rapid balance refresh for the currently active Antigravity account.
   * Runs in milliseconds directly against model quotas without artificial delay.
   */
  async refreshActiveAccountFast(force: boolean = false): Promise<Account | null> {
    const activeEmail = await this.getActiveAntigravityEmail();
    if (!activeEmail) return null;

    const account = await this.accountRepo.getAccount(activeEmail);
    if (!account) {
      // Auto-capture if not yet registered!
      return await this.syncActiveAccountFromDb(true);
    }

    const now = Date.now();
    const config = ExtensionConfig.getInstance();
    const preferredModel = await this.accountRepo.getPreferredModel();
    const currentQuota = this.getAccountUsableQuotaPercentage(account, preferredModel);

    // Dynamic throttle:
    // When quota is <= 10%, throttle allows rapid checks every 8 seconds without hitting Google rate limits.
    // When quota is <= 25%, throttle allows checks every 15 seconds.
    // Otherwise throttle requires 25 seconds between background requests.
    const minThrottleMs = (config.isAdaptiveQuotaPollingEnabled() && currentQuota <= 10) ? 8_000 : (currentQuota <= 25 ? 15_000 : 25_000);
    if (!force && (now - this._lastActiveQuotaCheckTime < minThrottleMs)) {
      return account;
    }
    this._lastActiveQuotaCheckTime = now;

    const activeInfo = await this.getActiveAntigravityAccountInfo();
    let tokens = activeInfo?.tokens || await this.accountRepo.getTokens(activeEmail);
    if (activeInfo?.tokens) {
      await this.accountRepo.storeTokens(activeEmail, activeInfo.tokens);
    }

    if (tokens?.refreshToken && (tokens.expiresAt < (Math.floor(Date.now() / 1000) + 120) || !tokens.accessToken)) {
      try {
        const newTokens = await this.authService.refreshAccessToken(tokens.refreshToken);
        tokens.accessToken = newTokens.accessToken;
        tokens.expiresAt = Math.floor(Date.now() / 1000) + newTokens.expiresIn;
        await this.accountRepo.storeTokens(activeEmail, tokens);
      } catch (e) {
        Logger.getInstance().warn(`Could not refresh access token for active account ${activeEmail}`);
      }
    }

    if (!tokens?.accessToken) return account;

    try {
      const balanceInfo = await this.balanceService.getBalanceInfo(tokens.accessToken, {
        fast: true,
        projectId: account.projectId
      });

      if (balanceInfo.isRateLimited && !balanceInfo.isDepleted) {
        Logger.getInstance().warn(`Rate limit (429) detected during fast refresh for ${activeEmail}`);
        return account;
      }

      if (balanceInfo.isDepleted) {
        balanceInfo.balances = this.balanceService.createExhaustedBalances(account.balances);
      }

      const preferredModel = await this.accountRepo.getPreferredModel();
      const newStatus = await this.determineAccountStatus(balanceInfo, preferredModel);

      const oldBalances = account.balances || {};
      const newBalances = balanceInfo.isDepleted ? balanceInfo.balances : { ...oldBalances, ...balanceInfo.balances };
      const hasChanged = JSON.stringify(oldBalances) !== JSON.stringify(newBalances) || account.status !== newStatus;

      await this.accountRepo.updateAccount(activeEmail, {
        balances: newBalances,
        plan: balanceInfo.plan !== AccountPlan.UNKNOWN ? balanceInfo.plan : account.plan,
        projectId: balanceInfo.projectId || account.projectId,
        status: newStatus,
        lastRefreshedAt: new Date().toISOString()
      });

      if (hasChanged) {
        this._onAccountsChanged.fire();
      }

      // Check for auto-switch on depletion!
      const config = ExtensionConfig.getInstance();
      if (config.isAutoRotateEnabled() && newStatus === AccountStatus.DEPLETED) {
        Logger.getInstance().info(`[Fast Monitor] Active account ${activeEmail} depleted. Triggering auto-switch.`);
        await this.triggerAutoRotation(activeEmail, true);
      }

      return await this.accountRepo.getAccount(activeEmail);
    } catch (err) {
      Logger.getInstance().error(`Fast refresh failed for active account ${activeEmail}`, err);
      return account;
    }
  }

  /**
   * Finds the best healthy account with available quota to switch to.
   * Priority:
   * 1. Preferred model quota > 0 (highest % first)
   * 2. Highest total/average model quota > 0
   * 3. Status ACTIVE / LOW_BALANCE (not DEPLETED, not TOKEN_EXPIRED, not INELIGIBLE)
   */
  async findBestAccountWithQuota(currentEmail: string): Promise<Account | null> {
    const allAccounts = await this.accountRepo.getAllAccounts();
    const candidates = allAccounts.filter(a => 
      !isEmailMatch(a.email, currentEmail) &&
      a.status !== AccountStatus.DEPLETED &&
      a.status !== AccountStatus.TOKEN_EXPIRED &&
      a.status !== AccountStatus.INELIGIBLE
    );

    if (candidates.length === 0) return null;

    const preferredModel = await this.accountRepo.getPreferredModel();

    if (preferredModel) {
      const candidatesWithPref = candidates.map(acc => ({
        account: acc,
        prefQuota: getModelBalanceValue(acc.balances, preferredModel),
      }));

      const positivePref = candidatesWithPref.filter(c => c.prefQuota > 0);
      if (positivePref.length > 0) {
        positivePref.sort((a, b) => b.prefQuota - a.prefQuota);
        return positivePref[0].account;
      }
    }

    const ranked = candidates.map(acc => {
      let maxQuota = 0;
      let totalQuota = 0;
      for (const v of Object.values(acc.balances || {})) {
        const val = typeof v === 'object' && v !== null && 'value' in v ? v.value : (typeof v === 'number' ? v : 0);
        if (val > maxQuota) maxQuota = val;
        totalQuota += val;
      }
      return { account: acc, maxQuota, totalQuota };
    });

    ranked.sort((a, b) => {
      if (b.maxQuota !== a.maxQuota) return b.maxQuota - a.maxQuota;
      return b.totalQuota - a.totalQuota;
    });

    return ranked[0].account;
  }


  /**
   * Workflow: Refresh all balances
   * Loops through all stored accounts and updates their credits/status.
   * 
   *   - When auto-refresh is disabled — only the active account gets updated.
   *   - When the user is searching — only the visible accounts are refreshed.
   * @param notify Whether to show toast notification on completion
   * @param options.onAccountStart Called when an individual account starts refreshing
   * @param options.onAccountDone  Called when an individual account finishes (success or skip)
   * @param options.onComplete     Called when all accounts are done
   * @param options.signal         AbortSignal to cancel the refresh mid-loop
   * @param options.orderedEmails  If provided, accounts are refreshed in this order (matching UI display order)
   * @param options.onlyEmails     If provided, only accounts matching these emails are refreshed
   */
  async refreshBalancesWorkflow(
    notify: boolean = true,
    options?: {
      onAccountStart?: (email: string) => void;
      onAccountDone?: (email: string, updatedBalances?: Record<string, any>, updatedStatus?: AccountStatus) => void;
      onComplete?: () => void;
      signal?: AbortSignal;
      orderedEmails?: string[];
      onlyEmails?: string[];
      force?: boolean;
    }
  ): Promise<boolean> {
    // ── Guard: Prevent concurrent or rapid-fire refreshes ──
    if (this._isRefreshing) {
      Logger.getInstance().info('Refresh already in progress, ignoring duplicate request.');
      if (notify && ExtensionConfig.getInstance().isNotificationsEnabled()) {
        const i18n = I18nService.getInstance();
        vscode.window.showInformationMessage(i18n.t('service.refreshInProgress'));
      }
      return false;
    }

    const now = Date.now();
    const elapsed = now - this._lastRefreshTime;
    if (!options?.force && elapsed < AccountService.REFRESH_COOLDOWN_MS) {
      const remainingMs = AccountService.REFRESH_COOLDOWN_MS - elapsed;
      const remainingSec = Math.ceil(remainingMs / 1000);
      Logger.getInstance().info(`Refresh cooldown active. Queueing next refresh in ${remainingSec}s.`);
      
      this.cancelQueue();
      
      if (notify && ExtensionConfig.getInstance().isNotificationsEnabled()) {
        const i18n = I18nService.getInstance();
        vscode.window.showInformationMessage(
          i18n.t('service.refreshQueued', { seconds: remainingSec })
        );
      }

      this._queuedTimeout = setTimeout(async () => {
        this._queuedTimeout = null;
        try {
          await this.refreshBalancesWorkflow(notify, options);
        } catch (err) {
          Logger.getInstance().error('Error executing queued refresh balances', err);
        }
      }, remainingMs);

      return false;
    }

    this._isRefreshing = true;
    this._lastRefreshTime = now;

    try {
    let accounts = await this.accountRepo.getAllAccounts();
    if (accounts.length === 0) { this._isRefreshing = false; return false; }

    // Filter to specific accounts if requested (e.g., search-filtered refresh)
    if (options?.onlyEmails && options.onlyEmails.length > 0) {
      const filterSet = new Set(options.onlyEmails.map(e => e.toLowerCase()));
      accounts = accounts.filter(a => filterSet.has(a.email.toLowerCase()));
      if (accounts.length === 0) { this._isRefreshing = false; return false; }
    }

    // Reorder accounts to match UI display order if provided
    if (options?.orderedEmails && options.orderedEmails.length > 0) {
      const emailOrder = options.orderedEmails.map(e => e.toLowerCase());
      accounts = [...accounts].sort((a, b) => {
        const aIdx = emailOrder.indexOf(a.email.toLowerCase());
        const bIdx = emailOrder.indexOf(b.email.toLowerCase());
        const aPos = aIdx === -1 ? emailOrder.length : aIdx;
        const bPos = bIdx === -1 ? emailOrder.length : bIdx;
        return aPos - bPos;
      });
    }

    let successCount = 0;
    const config = ExtensionConfig.getInstance();
    let accountsProcessed = 0;
    const activeEmail = await this.getActiveAntigravityEmail();

    for (const account of accounts) {
      // ── Check for cancellation ──
      if (options?.signal?.aborted) {
        Logger.getInstance().info('Refresh cancelled by user.');
        break;
      }

      // ── Check cache if not forced ──
      if (!options?.force) {
        const isActive = activeEmail && isEmailMatch(account.email, activeEmail);
        if (!isActive && account.lastRefreshedAt) {
          const lastRefreshed = new Date(account.lastRefreshedAt).getTime();
          const cacheDurationDays = ExtensionConfig.getInstance().getCacheDurationDays();
          const cacheDurationMs = cacheDurationDays * 24 * 60 * 60 * 1000;
          if (Date.now() - lastRefreshed < cacheDurationMs) {
            Logger.getInstance().info(`Skipping refresh for cached account: ${account.email}`);
            options?.onAccountDone?.(account.email, account.balances, account.status);
            continue;
          }
        }
      }

      // ── Anti-Ban: Dynamic randomized delay ("medio medio": 4s a 8s) ──
      if (accountsProcessed > 0) {
        // Base delay: random entre 4,000ms (4s) y 8,000ms (8s)
        const minDelay = 4000;
        const maxDelay = 8000;
        let delay = Math.floor(Math.random() * (maxDelay - minDelay + 1)) + minDelay;

        // Pequeña pausa natural cada 8 a 12 cuentas (6s a 10s) para romper patrones lineales
        if (accountsProcessed % (Math.floor(Math.random() * 5) + 8) === 0) {
          const extraPause = Math.floor(Math.random() * (10000 - 6000 + 1)) + 6000;
          Logger.getInstance().info(`Anti-ban: Pausa natural de ${Math.round(extraPause / 1000)}s tras procesar ${accountsProcessed} cuentas.`);
          delay += extraPause;
        }

        Logger.getInstance().info(`Anti-ban: Esperando ${(delay / 1000).toFixed(1)}s antes de consultar ${account.email}...`);
        
        await new Promise(resolve => {
          const timer = setTimeout(resolve, delay);
          options?.signal?.addEventListener('abort', () => {
            clearTimeout(timer);
            resolve(undefined);
          }, { once: true });
        });

        if (options?.signal?.aborted) {
          Logger.getInstance().info('Refresh cancelled during anti-ban delay.');
          break;
        }
      }

      accountsProcessed++;

      // Notify UI: this account is starting
      options?.onAccountStart?.(account.email);

      let tokens = await this.accountRepo.getTokens(account.email);
      if (!tokens) {
        options?.onAccountDone?.(account.email);
        continue;
      }

      const now = Math.floor(Date.now() / 1000);
      
      // Auto-refresh token if needed before API call (for active account, sync live native session)
      const isActive = activeEmail && isEmailMatch(account.email, activeEmail);
      if (isActive) {
        const activeInfo = await this.getActiveAntigravityAccountInfo();
        if (activeInfo?.tokens?.accessToken) {
          tokens.accessToken = activeInfo.tokens.accessToken;
          tokens.expiresAt = activeInfo.tokens.expiresAt;
          await this.accountRepo.storeTokens(account.email, tokens);
        }
      } else if (tokens.expiresAt < (now + 300)) {
        try {
          const newTokens = await this.authService.refreshAccessToken(tokens.refreshToken);
          tokens.accessToken = newTokens.accessToken;
          tokens.expiresAt = now + newTokens.expiresIn;
          await this.accountRepo.storeTokens(account.email, tokens);
        } catch(e) {
          Logger.getInstance().warn(`Skipping balance fetch for ${account.email} due to expired token.`);
          await this.accountRepo.updateAccount(account.email, { status: AccountStatus.TOKEN_EXPIRED });
          options?.onAccountDone?.(account.email, undefined, AccountStatus.TOKEN_EXPIRED);
          continue; 
        }
      }

      // Check cancellation again before API call
      if (options?.signal?.aborted) {
        Logger.getInstance().info('Refresh cancelled by user before API call.');
        break;
      }

      // Fetch Balance
      const balanceInfo = await this.balanceService.getBalanceInfo(tokens.accessToken, { projectId: account.projectId });
      
      // Safety Guard: Detect Google API rate limit (429) and abort workflow immediately to protect all accounts
      if (balanceInfo.isRateLimited && !balanceInfo.isDepleted) {
        Logger.getInstance().warn(`Rate limit (429) detected while refreshing ${account.email}. Aborting scan to protect remaining accounts!`);
        vscode.window.showWarningMessage('Google API rate limit detected. Refresh stopped immediately to protect accounts from being blocked.');
        options?.onAccountDone?.(account.email, account.balances, account.status);
        break;
      }

      if (balanceInfo.isDepleted) {
        balanceInfo.balances = this.balanceService.createExhaustedBalances(account.balances);
      }

      const preferredModel = await this.accountRepo.getPreferredModel();
      const status = await this.determineAccountStatus(balanceInfo, preferredModel);
      
      if (!balanceInfo.hasError) {
        successCount++;
      }

      await this.accountRepo.updateAccount(account.email, {
        balances: balanceInfo.balances,
        plan: balanceInfo.plan !== AccountPlan.UNKNOWN ? balanceInfo.plan : account.plan,
        projectId: balanceInfo.projectId || account.projectId,
        status: status,
        lastRefreshedAt: new Date().toISOString()
      });

      // Notify UI: this account is done with updated data
      options?.onAccountDone?.(account.email, balanceInfo.balances, status);

      // Trigger low balance warning native notification if enabled
      if (config.isLowCreditNotificationsEnabled() && !balanceInfo.hasError) {
        const i18n = I18nService.getInstance();
        if (status === AccountStatus.DEPLETED) {
          vscode.window.showWarningMessage(i18n.t('notifications.depleted', { email: account.email }));
        } else if (status === AccountStatus.LOW_BALANCE) {
          let totalCredits = 0;
          if (preferredModel) {
            totalCredits = getModelBalanceValue(balanceInfo.balances, preferredModel);
          } else {
            const values = Object.values(balanceInfo.balances);
            totalCredits = values.reduce((sum: number, val: any) => sum + (typeof val === 'number' ? val : (val?.value || 0)), 0);
          }
          vscode.window.showWarningMessage(i18n.t('notifications.lowBalance', { email: account.email, amount: totalCredits }));
        }
      }

      // Check if we need to auto-rotate
      const isAutoRotate = ExtensionConfig.getInstance().isAutoRotateEnabled();
      if (isAutoRotate && status === AccountStatus.DEPLETED) {
        const activeEmail = await this.getActiveAntigravityEmail();
        if (activeEmail && isEmailMatch(account.email, activeEmail)) {
          Logger.getInstance().info(`Active account ${account.email} is depleted and auto-rotate is enabled.`);
          await this.triggerAutoRotation(account.email, true);
        }
      }
    }

    const wasCancelled = !!options?.signal?.aborted;

    if (wasCancelled) {
      // Don't show "all refreshed" — show cancellation notice instead
      if (notify) {
        const i18n = I18nService.getInstance();
        vscode.window.showInformationMessage(i18n.t('accounts.refreshCancelled'));
      }
    } else if (notify && successCount > 0 && ExtensionConfig.getInstance().isNotificationsEnabled()) {
      const i18n = I18nService.getInstance();
      vscode.window.showInformationMessage(i18n.t('notifications.refreshComplete'));
    }
    
    // Update global refresh timestamp
    await this.accountRepo.setBalancesLastRefreshed(Date.now());
    
    // Notify UI: all done
    options?.onComplete?.();
    
    this._onAccountsChanged.fire();
    return !wasCancelled;
    } finally {
      this._isRefreshing = false;
    }
  }

  /**
   * Refreshes the balance for a single account.
   * Used when auto-refresh is disabled — only the active account gets updated.
   * Follows the same per-account logic as refreshBalancesWorkflow.
   */
  async refreshSingleAccountBalance(
    email: string,
    callbacks?: {
      onStart?: (email: string) => void;
      onDone?: (email: string, balances?: Record<string, any>, status?: AccountStatus) => void;
    },
    options?: {
      force?: boolean;
    }
  ): Promise<void> {
    const account = await this.accountRepo.getAccount(email);
    if (!account) return;

    // Safety Guard: Per-account debounce cooldown (30 seconds) unless explicitly forced
    if (!options?.force && account.lastRefreshedAt) {
      const elapsed = Date.now() - new Date(account.lastRefreshedAt).getTime();
      if (elapsed < 30_000) {
        Logger.getInstance().info(`Skipping single account refresh for ${email}: refreshed ${Math.round(elapsed / 1000)}s ago (cooldown 30s).`);
        callbacks?.onDone?.(email, account.balances, account.status);
        return;
      }
    }

    callbacks?.onStart?.(email);

    let tokens = await this.accountRepo.getTokens(email);
    const activeEmail = await this.getActiveAntigravityEmail();
    const isActive = activeEmail && isEmailMatch(email, activeEmail);

    if (isActive) {
      const activeInfo = await this.getActiveAntigravityAccountInfo();
      if (activeInfo?.tokens) {
        tokens = activeInfo.tokens;
        await this.accountRepo.storeTokens(email, tokens);
      }
    }

    if (!tokens) {
      callbacks?.onDone?.(email);
      return;
    }

    const now = Math.floor(Date.now() / 1000);

    // Auto-refresh token if needed before API call (only for non-active accounts)
    if (!isActive && tokens.refreshToken && (tokens.expiresAt < (now + 120) || !tokens.accessToken)) {
      try {
        const newTokens = await this.authService.refreshAccessToken(tokens.refreshToken);
        tokens.accessToken = newTokens.accessToken;
        tokens.expiresAt = now + newTokens.expiresIn;
        await this.accountRepo.storeTokens(email, tokens);
      } catch (e) {
        Logger.getInstance().warn(`Skipping balance fetch for ${email}: expired token.`);
        await this.accountRepo.updateAccount(email, { status: AccountStatus.TOKEN_EXPIRED });
        callbacks?.onDone?.(email, undefined, AccountStatus.TOKEN_EXPIRED);
        return;
      }
    }

    const config = ExtensionConfig.getInstance();
    const balanceInfo = await this.balanceService.getBalanceInfo(tokens.accessToken, { projectId: account.projectId });

    // Safety Guard: Detect Google API rate limit (429) ONLY if not depleted
    if (balanceInfo.isRateLimited && !balanceInfo.isDepleted) {
      Logger.getInstance().warn(`Rate limit (429) hit while refreshing single account ${email}.`);
      vscode.window.showWarningMessage('Google API rate limit detected for this account. Please wait before retrying.');
      callbacks?.onDone?.(email, account.balances, account.status);
      return;
    }

    if (balanceInfo.isDepleted) {
      balanceInfo.balances = this.balanceService.createExhaustedBalances(account.balances);
    }

    const preferredModel = await this.accountRepo.getPreferredModel();
    const status = await this.determineAccountStatus(balanceInfo, preferredModel);

    await this.accountRepo.updateAccount(email, {
      balances: balanceInfo.balances,
      plan: balanceInfo.plan !== AccountPlan.UNKNOWN ? balanceInfo.plan : account.plan,
      projectId: balanceInfo.projectId || account.projectId,
      status: status,
      lastRefreshedAt: new Date().toISOString()
    });

    callbacks?.onDone?.(email, balanceInfo.balances, status);

    // Trigger low balance warning native notification if enabled
    if (config.isLowCreditNotificationsEnabled() && !balanceInfo.hasError) {
      const i18n = I18nService.getInstance();
      if (status === AccountStatus.DEPLETED) {
        vscode.window.showWarningMessage(i18n.t('notifications.depleted', { email }));
      } else if (status === AccountStatus.LOW_BALANCE) {
        let totalCredits = 0;
        if (preferredModel) {
          totalCredits = getModelBalanceValue(balanceInfo.balances, preferredModel);
        } else {
          const values = Object.values(balanceInfo.balances);
          totalCredits = values.reduce((sum: number, val: any) => sum + (typeof val === 'number' ? val : (val?.value || 0)), 0);
        }
        vscode.window.showWarningMessage(i18n.t('notifications.lowBalance', { email, amount: totalCredits }));
      }
    }

    const isAutoRotate = ExtensionConfig.getInstance().isAutoRotateEnabled();
    if (isAutoRotate && status === AccountStatus.DEPLETED) {
      const currentActive = await this.getActiveAntigravityEmail();
      if (currentActive && isEmailMatch(email, currentActive)) {
        Logger.getInstance().info(`Active account ${email} is depleted and auto-rotate is enabled.`);
        await this.triggerAutoRotation(email, true);
      }
    }

    // Update global refresh timestamp
    await this.accountRepo.setBalancesLastRefreshed(Date.now());
    this._onAccountsChanged.fire();
  }

  /**
   * Workflow: Re-authenticate an account with an expired token
   * Runs the OAuth flow again for the SAME email, verifies identity,
   * and updates stored tokens without losing any account data (alias, device profile, etc.).
   */
  async reAuthenticateWorkflow(email: string): Promise<void> {
    const i18n = I18nService.getInstance();

    try {
      await vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: i18n.t('auth.reAuthenticating', { email }),
        cancellable: false
      }, async (progress) => {

        // 1. Run the OAuth login flow (opens browser)
        const { tokens, profile } = await this.authService.login();

        // 2. SECURITY CHECK: Verify the returned email matches the original account
        if (profile.email.toLowerCase() !== email.toLowerCase()) {
          throw new Error(i18n.t('service.reAuthEmailMismatch', {
            expected: email,
            actual: profile.email
          }));
        }

        progress.report({ message: i18n.t('common.loading') });

        // 3. Update stored tokens (preserves all other account data)
        const expiresAt = Math.floor(Date.now() / 1000) + tokens.expiresIn;
        await this.accountRepo.storeTokens(email, {
          accessToken: tokens.accessToken,
          refreshToken: tokens.refreshToken,
          expiresAt: expiresAt
        });

        // 4. Update avatar if changed
        if (profile.picture) {
          await this.accountRepo.updateAccount(email, {
            avatarUrl: profile.picture
          });
        }

        // 5. Reset status back to ACTIVE
        await this.accountRepo.updateAccount(email, {
          status: AccountStatus.ACTIVE
        });

        Logger.getInstance().info(`Successfully re-authenticated ${email}`);
        vscode.window.showInformationMessage(i18n.t('service.reAuthSuccess', { email }));

        this._onAccountsChanged.fire();

        // 6. Silently refresh balances in the background
        this.refreshBalancesWorkflow(false).catch(() => {});
      });
    } catch (error: any) {
      Logger.getInstance().error(`Re-authentication failed for ${email}`, error);
      vscode.window.showErrorMessage(i18n.t('service.reAuthFailed', { email, error: error.message }));
    }
  }

  /**
   * Workflow: Remove account
   * Prompts for confirmation and wipes data.
   */
  async removeAccountWorkflow(email: string): Promise<void> {
    const i18n = I18nService.getInstance();
    const actionYes = i18n.t('common.delete');
    
    const choice = await vscode.window.showWarningMessage(
      i18n.t('accounts.confirmDelete') + ` (${email})`,
      { modal: true, detail: i18n.t('accounts.deleteWarning') },
      actionYes,
      i18n.t('common.cancel')
    );

    if (choice === actionYes) {
      await this.accountRepo.removeAccount(email);
      vscode.window.showInformationMessage(i18n.t('service.accountRemoved', { email }));
      
      // We no longer need to check or clear the active account in local DB
      // because it is dynamically read from Antigravity.
      
      this._onAccountsChanged.fire();
    }
  }

  /**
   * Helper to automatically switch to the next healthy account with quota when active runs out.
   */
  public async triggerAutoRotation(depletedEmail: string, isAutomatic: boolean = true): Promise<void> {
    if (this._isSwitching) {
      Logger.getInstance().info('Auto-rotation already in progress, skipping duplicate call.');
      return;
    }

    const allAccounts = await this.accountRepo.getAllAccounts();
    if (allAccounts.length <= 1) {
      Logger.getInstance().info('Auto-rotation skipped: only one account registered.');
      return;
    }

    const nextAccount = await this.findBestAccountWithQuota(depletedEmail);
    const i18n = I18nService.getInstance();

    if (!nextAccount) {
      Logger.getInstance().warn('Active account is depleted, but no other healthy accounts with quota are available.');
      vscode.window.showWarningMessage(
        i18n.t('service.autoRotateNoCandidate', { email: depletedEmail })
      );
      return;
    }

    this._isSwitching = true;
    Logger.getInstance().info(`[Auto-Switch] Selected best candidate ${nextAccount.email} for depleted ${depletedEmail}`);

    const config = ExtensionConfig.getInstance();

    // 1. Detect if the AI was actively working and persist chat resume marker
    if (config.isAutoResumeChatEnabled()) {
      try {
        const timeoutSec = config.getAutoResumeTimeoutSeconds();
        const activity = ChatResumeUtils.detectRecentChatActivity(timeoutSec);
        const storageDir = PathUtils.getAntigravityDataPath(config.getContext());
        ChatResumeUtils.savePendingResume(storageDir, {
          reason: 'depleted',
          wasWorking: activity.wasWorking || activity.isQuotaError,
          prompt: config.getAutoResumePrompt(),
          targetEmail: nextAccount.email,
          timestamp: Date.now(),
          conversationId: activity.conversationId
        });
      } catch (resumeErr) {
        Logger.getInstance().debug('[Auto-Switch] Could not save pending chat resume marker', resumeErr);
      }
    }

    // 2. Configurable pre-switch notice countdown (default 0s = instant reload)
    const noticeSeconds = config.getNoticeDurationSeconds();
    if (noticeSeconds > 0) {
      let isCancelled = false;
      await new Promise<void>((resolve) => {
        let remaining = noticeSeconds;
        const msg = vscode.window.showInformationMessage(
          `[Auto-Switch] Switching to ${nextAccount.email} in ${remaining}s...`,
          'Cancel'
        );
        const timer = setInterval(() => {
          remaining--;
          if (remaining <= 0) {
            clearInterval(timer);
            resolve();
          }
        }, 1000);

        msg.then(choice => {
          if (choice === 'Cancel') {
            isCancelled = true;
            clearInterval(timer);
            resolve();
          }
        });
      });

      if (isCancelled) {
        Logger.getInstance().info('Auto-rotation cancelled by user via notice countdown.');
        this._isSwitching = false;
        return;
      }
    }

    try {
      // Immediate automatic switch and reload
      await this.switchAccountWorkflow(nextAccount.email, { skipPrompt: true });
    } finally {
      this._isSwitching = false;
    }
  }
}

