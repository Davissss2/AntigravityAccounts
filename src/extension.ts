/**
 * Antigravity Hub — VS Code Extension Entry Point
 *
 * This is the main activation/deactivation entry for the extension.
 * It follows the Composition Root pattern: all dependencies are wired here
 * and injected into the appropriate layers.
 */

import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { Logger } from './core/utils/logger';
import { I18nService } from './i18n/i18n.service';
import { ExtensionConfig } from './core/config/extension.config';
import { PathUtils } from './core/utils/path.utils';

import { Account, AccountStatus, AccountSummary } from './core/domain/models/account.model';
import { AntigravityAccountApi, SwitchAccountOptions, AutoSwitchResult, ActiveAccountInfo, ExtensionSettingsConfig } from './api/extension-api';
import { ChatResumeUtils } from './core/utils/chat-resume.utils';

export * from './api/extension-api';

import { AuthService } from './infrastructure/auth/auth.service';
import { BalanceService } from './infrastructure/api/balance.service';
import { AccountRepositoryImpl } from './infrastructure/storage/account.repository.impl';
import { StateDbService } from './infrastructure/storage/state-db.service';
import { AccountService } from './features/accounts/account.service';
import { StatusBarProvider } from './presentation/providers/status-bar.provider';
import { AccountsWebviewProvider } from './presentation/providers/accounts-webview.provider';

/**
 * Called when the extension is activated.
 * Responsible for:
 * - Initializing core services (Logger, I18n, Config)
 * - Registering commands and public API
 * - Setting up the sidebar webview
 * - Initializing the status bar
 */
export async function activate(context: vscode.ExtensionContext): Promise<AntigravityAccountApi> {
  const logger = Logger.getInstance();
  logger.info('Antigravity Account is activating...');

  // ── Initialize Configuration ──
  const config = ExtensionConfig.getInstance();
  config.initialize(context);

  // ── Execute Pending Chat Resume (on account switch / quota depletion) ──
  try {
    const storageDir = PathUtils.getAntigravityDataPath(context);
    let pendingResume = ChatResumeUtils.readAndClearPendingResume(storageDir);
    if (!pendingResume) {
      pendingResume = ChatResumeUtils.readAndClearPendingResume(PathUtils.getAntigravityDataPath());
    }
    if (pendingResume && config.isAutoResumeChatEnabled()) {
      logger.info(
        `[ChatResume] Restoring chat after account switch to ${pendingResume.targetEmail} (wasWorking=${pendingResume.wasWorking}, prompt="${pendingResume.prompt}")`
      );
      ChatResumeUtils.executePendingResume(pendingResume).catch(err => {
        logger.warn('[ChatResume] Error executing chat resume on startup', err);
      });
    }
  } catch (resumeErr) {
    logger.debug('[ChatResume] Could not check pending chat resume on startup', resumeErr);
  }

  // ── Run Storage Migration & Sanitization ──
  try {
    await migrateAndSanitizeStorage(context);
    await ensureValidMcpConfig();
  } catch (err: any) {
    logger.error('Failed to run storage migration/sanitization during activation', err);
  }

  // ── Initialize i18n ──
  const i18n = I18nService.getInstance();
  
  const updateLanguage = () => {
    let language = config.getLanguage();
    if (language === 'auto') {
      const fullLang = (vscode.env.language || '').toLowerCase();
      const editorLang = fullLang.split('-')[0];
      if (fullLang.startsWith('zh')) {
        language = 'zh-CN';
      } else if (fullLang.startsWith('pt')) {
        language = 'pt-BR';
      } else if (['ar', 'es', 'fr', 'de', 'ja', 'ru', 'ko'].includes(editorLang)) {
        language = editorLang;
      } else {
        language = 'en';
      }
    }
    i18n.setLocale(language);
    logger.info(`Language set to: ${language} (configured: ${config.getLanguage()})`);
  };
  
  updateLanguage();

  // ── Register Commands & Public API ──
  const { disposables, api } = registerCommands(context, i18n);
  context.subscriptions.push(...disposables);

  // ── Listen for configuration changes ──
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e: vscode.ConfigurationChangeEvent) => {
      if (e.affectsConfiguration('antigravityAccount.language')) {
        updateLanguage();
      }
    })
  );

  logger.info('Antigravity Account activated successfully.');
  return api;
}

/**
 * Called when the extension is deactivated.
 * Clean up resources here.
 */
export function deactivate(): void {
  const logger = Logger.getInstance();
  logger.info('Antigravity Account deactivated.');
}

/**
 * Register all extension commands and expose programmatic API.
 * Each command delegates to the appropriate use case / controller.
 */
function registerCommands(
  context: vscode.ExtensionContext,
  i18n: I18nService
): { disposables: vscode.Disposable[]; api: AntigravityAccountApi } {
  const authService = new AuthService();
  const balanceService = new BalanceService();
  const accountRepo = new AccountRepositoryImpl(context);
  const stateDbService = new StateDbService(context);
  const accountService = new AccountService(authService, balanceService, accountRepo, stateDbService);

  const disposables: vscode.Disposable[] = [];

  // ── Periodic Check for Active Account changes in state.vscdb ──
  const logger = Logger.getInstance();
  const config = ExtensionConfig.getInstance();
  let lastActiveEmail: string | null = null;
  let lastActiveBalanceCheckTime = 0;

  // Initial reconciliation from SecretStorage (recovers any orphaned or desynchronized accounts)
  accountService.reconcileOrphanedSecretAccounts().catch((err) => {
    logger.debug('Reconciliation of orphaned secret accounts skipped or failed', err);
  });

  // Initial auto-capture & sync of active Antigravity account and VS Code sessions on startup
  if (config.isAutoCaptureAccountsEnabled()) {
    accountService.syncActiveAccountFromDb(false).then((acc) => {
      if (acc) {
        lastActiveEmail = acc.email;
      }
    }).catch((err) => {
      logger.debug('Initial active account sync skipped or failed', err);
    });
    accountService.syncFromAuthenticationSessions().catch(() => {});
  }

  // Monitor VS Code Google / external authentication changes in real-time
  try {
    context.subscriptions.push(
      vscode.authentication.onDidChangeSessions(async (event) => {
        logger.info(`[Auth Monitor] Authentication sessions changed for provider: ${event.provider.id}`);
        if (config.isAutoCaptureAccountsEnabled()) {
          await accountService.syncFromAuthenticationSessions();
          await accountService.syncActiveAccountFromDb(true);
        }
      })
    );
  } catch (authErr) {
    logger.debug('Failed to subscribe to onDidChangeSessions', authErr);
  }

  let authSyncCounter = 0;
  const activeCheckInterval = setInterval(async () => {
    try {
      // Periodically check for new external auth sessions (every 12 seconds = every 3 ticks)
      authSyncCounter++;
      if (authSyncCounter % 3 === 0 && config.isAutoCaptureAccountsEnabled()) {
        accountService.syncFromAuthenticationSessions().catch(() => {});
      }

      const activeInfo = await accountService.getActiveAntigravityAccountInfo();
      const currentActive = activeInfo?.email || null;

      // ── 1. Detect Account Change in IDE ──
      if (currentActive !== lastActiveEmail) {
        logger.info(`Active account changed in IDE to: ${currentActive}`);
        lastActiveEmail = currentActive;
        
        if (currentActive && config.isAutoCaptureAccountsEnabled()) {
          // Auto-capture / sync newly active account and refresh its quota immediately
          await accountService.syncActiveAccountFromDb(true);
        }
        accountService.emitAccountsChanged();
      } else if (currentActive && config.isAutoCaptureAccountsEnabled()) {
        // Ensure account is captured even if lastActiveEmail hasn't changed
        const account = await accountRepo.getAccount(currentActive);
        if (!account) {
          await accountService.syncActiveAccountFromDb(true);
        }
      }

      // ── 2. Sync Active Tokens ──
      if (currentActive && activeInfo?.tokens) {
        const tokens = activeInfo.tokens;
        const storedTokens = await accountRepo.getTokens(currentActive);
        if (!storedTokens || storedTokens.accessToken !== tokens.accessToken || storedTokens.refreshToken !== tokens.refreshToken) {
          await accountRepo.storeTokens(currentActive, tokens);
          logger.info(`Synchronized active tokens for ${currentActive} from state.vscdb to repository.`);
        }
      }

      // ── 3. Fast Active Account Quota Monitoring & Auto-Switch ──
      if (currentActive) {
        const now = Date.now();
        const preferredModel = await accountRepo.getPreferredModel();
        const activeAccount = await accountRepo.getAccount(currentActive);
        const quota = activeAccount ? accountService.getAccountUsableQuotaPercentage(activeAccount, preferredModel) : 100;

        // Dynamic interval:
        // - Critical (<= 10%): Poll every 8s to catch depletion immediately without rate limiting
        // - Low (<= 25%): Poll every 20s
        // - Normal (> 25%): Respect user setting (default: 45s)
        let dynamicIntervalSec = 45;
        if (config.isAdaptiveQuotaPollingEnabled()) {
          if (quota <= 10) {
            dynamicIntervalSec = 8;
          } else if (quota <= 25) {
            dynamicIntervalSec = 20;
          } else {
            dynamicIntervalSec = Math.max(25, config.getActiveQuotaRefreshIntervalSeconds());
          }
        } else {
          dynamicIntervalSec = Math.max(15, config.getActiveQuotaRefreshIntervalSeconds());
        }

        const intervalMs = dynamicIntervalSec * 1000;

        if (now - lastActiveBalanceCheckTime >= intervalMs) {
          lastActiveBalanceCheckTime = now;
          logger.debug(`[Adaptive Quota Monitor] Polling ${currentActive} (quota: ${quota}%, interval: ${dynamicIntervalSec}s)...`);
          accountService.refreshActiveAccountFast(false).catch((err: any) => {
            logger.debug(`Fast quota check error for ${currentActive}`, err);
          });
        }
      }
    } catch (e) {
      // ignore
    }
  }, 4000); // Check every 4 seconds for responsive updates

  // Responsive trigger: refresh active quota on window focus if remaining quota is low (<= 15%)
  context.subscriptions.push(
    vscode.window.onDidChangeWindowState(async (state) => {
      if (state.focused) {
        const currentActive = await accountService.getActiveAntigravityEmail();
        if (currentActive) {
          const activeAccount = await accountRepo.getAccount(currentActive);
          if (activeAccount) {
            const preferredModel = await accountRepo.getPreferredModel();
            const quota = accountService.getAccountUsableQuotaPercentage(activeAccount, preferredModel);
            if (quota <= 15 && (Date.now() - lastActiveBalanceCheckTime >= 8000)) {
              lastActiveBalanceCheckTime = Date.now();
              accountService.refreshActiveAccountFast(false).catch(() => {});
            }
          }
        }
      }
    })
  );

  // ── Periodic Background Balance Refresh ──
  const periodicRefreshInterval = setInterval(async () => {
    try {
      // Must respect autoRefreshEnabled setting
      if (!config.isAutoRefreshEnabled()) return;

      const refreshIntervalMinutes = config.getRefreshIntervalMinutes();
      if (refreshIntervalMinutes <= 0) return; // Disabled

      const lastRefreshed = await accountRepo.getBalancesLastRefreshed();
      const now = Date.now();
      const elapsedMs = now - lastRefreshed;
      const intervalMs = refreshIntervalMinutes * 60 * 1000;

      if (elapsedMs >= intervalMs) {
        logger.info(`Periodic background balance refresh starting (elapsed: ${Math.round(elapsedMs / 1000 / 60)}m, interval: ${refreshIntervalMinutes}m)...`);
        // Run progressive refresh respecting cache (force = false)
        accountService.refreshBalancesWorkflow(false, { force: false }).catch((err: any) => {
          logger.error('Failed to execute periodic background balance refresh', err);
        });
      }
    } catch (periodicErr: any) {
      logger.error('Error in periodic background refresh check', periodicErr);
    }
  }, 60 * 1000); // Check every minute

  disposables.push({
    dispose: () => {
      clearInterval(activeCheckInterval);
      clearInterval(periodicRefreshInterval);
    }
  });

  // Initialize UI Providers
  const statusBarProvider = new StatusBarProvider(accountRepo, accountService);
  disposables.push(statusBarProvider);

  const accountsProvider = new AccountsWebviewProvider(context.extensionUri, accountRepo, accountService);
  disposables.push(
    vscode.window.registerWebviewViewProvider(
      AccountsWebviewProvider.viewType,
      accountsProvider,
      {
        webviewOptions: {
          retainContextWhenHidden: true
        }
      }
    )
  );

  // Listen for account state changes to update UI
  disposables.push(
    accountService.onAccountsChanged(() => {
      statusBarProvider.update();
    })
  );

  // ── Public Programmatic API Definition ──
  const api: AntigravityAccountApi = {
    async getAccounts() {
      return await accountRepo.getAccountSummaries();
    },
    async getAllAccounts() {
      return await accountRepo.getAllAccounts();
    },
    async getActiveAccount() {
      const activeInfo = await accountService.getActiveAntigravityAccountInfo();
      const email = activeInfo?.email || null;
      let account: AccountSummary | null = null;
      if (email) {
        const summaries = await accountRepo.getAccountSummaries();
        account = summaries.find(s => s.email.toLowerCase() === email.toLowerCase()) || null;
      }
      return {
        email,
        account,
        raw: activeInfo
      };
    },
    async switchAccount(email: string, options?: SwitchAccountOptions) {
      if (accountsProvider.isRefreshing()) {
        const remaining = accountsProvider.getPendingQueueEmails();
        if (remaining.length > 0) {
          await accountRepo.setPendingRefreshEmails(remaining);
          accountsProvider.cancelRefresh();
        }
      }
      return await accountService.switchAccountWorkflow(email, options);
    },
    async autoSwitch(options?: SwitchAccountOptions) {
      const activeEmail = (await accountService.getActiveAntigravityEmail()) || '';
      const candidate = await accountService.findBestAccountWithQuota(activeEmail);
      if (!candidate) {
        return {
          success: false,
          message: 'No healthy account with quota available for auto-switch.'
        };
      }
      if (accountsProvider.isRefreshing()) {
        const remaining = accountsProvider.getPendingQueueEmails();
        if (remaining.length > 0) {
          await accountRepo.setPendingRefreshEmails(remaining);
          accountsProvider.cancelRefresh();
        }
      }
      const res = await accountService.switchAccountWorkflow(candidate.email, { skipPrompt: options?.skipPrompt ?? true });
      return {
        success: res === 'success',
        targetEmail: candidate.email,
        message: res === 'success' ? `Switched to ${candidate.email}` : `Switch to ${candidate.email} ended with status: ${res}`
      };
    },
    async refreshActiveQuota(force = true) {
      return await accountService.refreshActiveAccountFast(force);
    },
    async refreshBalances(force = true) {
      await accountService.refreshBalancesWorkflow(false, { force });
    },
    async syncActiveAccount(forceRefresh = true) {
      return await accountService.syncActiveAccountFromDb(forceRefresh);
    },
    async reconcileAccounts() {
      return await accountService.reconcileOrphanedSecretAccounts();
    },
    async setAutoSwitchEnabled(enabled: boolean) {
      await config.setAutoRotateEnabled(enabled);
    },
    isAutoSwitchEnabled() {
      return config.isAutoRotateEnabled();
    },
    isAutoCaptureAccountsEnabled() {
      return config.isAutoCaptureAccountsEnabled();
    },
    async setAutoCaptureAccountsEnabled(enabled: boolean) {
      await config.setAutoCaptureAccountsEnabled(enabled);
    },
    getConfig() {
      return config.getFullConfig();
    },
    async updateConfig(settings: Partial<ExtensionSettingsConfig>) {
      await config.updateFullConfig(settings as Record<string, any>);
      statusBarProvider.update();
    }
  };

  // ── Register Commands ──
  disposables.push(
    vscode.commands.registerCommand('antigravity-account.openPanel', () => {
      vscode.commands.executeCommand('antigravity-account.accountsView.focus');
    })
  );

  disposables.push(
    vscode.commands.registerCommand('antigravity-account.addAccount', async () => {
      await accountService.addAccountWorkflow();
    })
  );

  disposables.push(
    vscode.commands.registerCommand('antigravity-account.switchAccount', async (targetEmailOrOptions?: any, maybeOptions?: any) => {
      let targetEmail: string | undefined;
      let skipPrompt: boolean = false;

      if (typeof targetEmailOrOptions === 'string') {
        targetEmail = targetEmailOrOptions;
        if (maybeOptions && typeof maybeOptions === 'object') {
          skipPrompt = !!maybeOptions.skipPrompt;
        }
      } else if (targetEmailOrOptions && typeof targetEmailOrOptions === 'object') {
        targetEmail = targetEmailOrOptions.email;
        skipPrompt = !!targetEmailOrOptions.skipPrompt;
      }

      if (targetEmail) {
        if (accountsProvider.isRefreshing()) {
          const remaining = accountsProvider.getPendingQueueEmails();
          if (remaining.length > 0) {
            await accountRepo.setPendingRefreshEmails(remaining);
            accountsProvider.cancelRefresh();
          }
        }
        return await accountService.switchAccountWorkflow(targetEmail, { skipPrompt });
      }

      // Temporary quick pick until UI is built
      const accounts = await accountRepo.getAccountSummaries();
      if (accounts.length === 0) {
        vscode.window.showWarningMessage(i18n.t('extension.noAccountsToSwitch'));
        return 'error';
      }

      // Dynamically detect the active account from Antigravity's state.vscdb
      const activeEmail = await accountService.getActiveAntigravityEmail();
      const activeEmailLower = activeEmail?.toLowerCase() ?? null;

      const items = accounts.map(a => {
        const isActive = activeEmailLower !== null && a.email.toLowerCase() === activeEmailLower;
        let creditsStr = '?';
        if (a.balances && Object.keys(a.balances).length > 0) {
          creditsStr = Object.values(a.balances).join('/');
        }
        return {
          label: `${isActive ? '✅ ' : ''}${a.displayName}`,
          description: `${creditsStr} Credits`,
          email: a.email
        };
      });

      const picked = await vscode.window.showQuickPick(items, {
        placeHolder: i18n.t('extension.selectAccountToSwitch')
      });

      if (picked) {
        if (accountsProvider.isRefreshing()) {
          const remaining = accountsProvider.getPendingQueueEmails();
          if (remaining.length > 0) {
            await accountRepo.setPendingRefreshEmails(remaining);
            accountsProvider.cancelRefresh();
          }
        }
        return await accountService.switchAccountWorkflow(picked.email);
      }
      return 'cancelled';
    })
  );

  disposables.push(
    vscode.commands.registerCommand('antigravity-account.getAccounts', async () => {
      return await api.getAccounts();
    })
  );

  disposables.push(
    vscode.commands.registerCommand('antigravity-account.getActiveAccount', async () => {
      return await api.getActiveAccount();
    })
  );

  disposables.push(
    vscode.commands.registerCommand('antigravity-account.autoSwitch', async (options?: SwitchAccountOptions) => {
      return await api.autoSwitch(options);
    })
  );

  disposables.push(
    vscode.commands.registerCommand('antigravity-account.refreshActiveQuota', async (force?: boolean) => {
      return await api.refreshActiveQuota(force !== false);
    })
  );

  disposables.push(
    vscode.commands.registerCommand('antigravity-account.toggleAutoSwitch', async (explicitEnabled?: boolean) => {
      const nextVal = typeof explicitEnabled === 'boolean' ? explicitEnabled : !api.isAutoSwitchEnabled();
      await api.setAutoSwitchEnabled(nextVal);
      const msg = nextVal ? i18n.t('webview.autoRotateEnabledToast') : i18n.t('webview.autoRotateDisabledToast');
      vscode.window.showInformationMessage(msg);
      return nextVal;
    })
  );

  disposables.push(
    vscode.commands.registerCommand('antigravity-account.syncActiveAccount', async (forceRefresh?: boolean) => {
      const acc = await api.syncActiveAccount(forceRefresh !== false);
      if (acc) {
        vscode.window.showInformationMessage(`Active Antigravity account synchronized: ${acc.email}`);
      }
      return acc;
    })
  );

  disposables.push(
    vscode.commands.registerCommand('antigravity-account.refreshBalances', async (force?: boolean) => {
      await accountService.refreshBalancesWorkflow(force !== false);
    })
  );

  disposables.push(
    vscode.commands.registerCommand('antigravity-account.setLanguage', async () => {
      const languages = [
        { label: i18n.t('webview.languageAuto'), description: 'auto' },
        ...i18n.getAvailableLocales().map((locale) => ({
          label: locale.name,
          description: locale.code,
        }))
      ];

      const picked = await vscode.window.showQuickPick(languages, {
        placeHolder: i18n.t('commands.setLanguage.placeholder'),
      });

      if (picked) {
        const extConfig = vscode.workspace.getConfiguration('antigravityAccount');
        await extConfig.update('language', picked.description, vscode.ConfigurationTarget.Global);
        vscode.commands.executeCommand('antigravity-account.openPanel');
      }
    })
  );

  disposables.push(
    vscode.commands.registerCommand('antigravity-account.toggleAutoCapture', async () => {
      const current = config.isAutoCaptureAccountsEnabled();
      await config.setAutoCaptureAccountsEnabled(!current);
      vscode.window.showInformationMessage(
        `Antigravity Account: Auto-Capture ${!current ? 'ENABLED' : 'DISABLED'}`
      );
    })
  );

  disposables.push(
    vscode.commands.registerCommand('antigravity-account.toggleAutoResume', async () => {
      const current = config.isAutoResumeChatEnabled();
      await vscode.workspace.getConfiguration('antigravityAccount').update('autoResumeChat', !current, vscode.ConfigurationTarget.Global);
      vscode.window.showInformationMessage(
        `Antigravity Account: Chat Auto-Resume ${!current ? 'ENABLED' : 'DISABLED'}`
      );
    })
  );

  disposables.push(
    vscode.commands.registerCommand('antigravity-account.reconcileAccounts', async () => {
      const restored = await api.reconcileAccounts();
      if (restored.length > 0) {
        vscode.window.showInformationMessage(`Restored ${restored.length} account(s) from SecretStorage.`);
      } else {
        vscode.window.showInformationMessage('No orphaned accounts found in SecretStorage.');
      }
      return restored;
    })
  );

  disposables.push(
    vscode.commands.registerCommand('antigravity-account.getConfig', () => {
      return api.getConfig();
    })
  );

  disposables.push(
    vscode.commands.registerCommand('antigravity-account.updateConfig', async (newSettings: Partial<ExtensionSettingsConfig>) => {
      await api.updateConfig(newSettings);
      return api.getConfig();
    })
  );

  return { disposables, api };
}

/**
 * Startup routine that:
 * 1. Sanitizes any account email containing typo domains like ".con" -> ".com"
 *    inside the globalState accounts list and the active account key.
 * 2. Migrates all stored secrets (refresh token, access token, metadata, deviceProfile)
 *    from conflict-prone prefixes to the isolated prefix "antigravityAccount.secure.*".
 * 3. Wipes old keys from SecretStorage to prevent IDE 500 crashes.
 * 4. Renames legacy Antigravity directory to prevent recurring settings migration popups in the 2.0 IDE.
 */
async function migrateAndSanitizeStorage(context: vscode.ExtensionContext): Promise<void> {
  const logger = Logger.getInstance();
  logger.info('Starting storage migration and sanitization check...');

  try {
    // ── Rename legacy configuration directory to disable the annoying settings migration prompt ──
    try {
      const currentDataPath = PathUtils.getAntigravityDataPath(context);
      const appDataDir = path.dirname(currentDataPath);
      const oldAppDataDir = path.join(appDataDir, 'Antigravity');
      const backupOldAppDataDir = path.join(appDataDir, 'Antigravity_pre20_backup');

      // Do not rename if we are currently running from 'Antigravity' directory
      const isRunningFromOldDir = path.basename(currentDataPath).toLowerCase() === 'antigravity';

      if (!isRunningFromOldDir && fs.existsSync(oldAppDataDir) && !fs.existsSync(backupOldAppDataDir)) {
        logger.info(`Detected legacy Antigravity data folder at: ${oldAppDataDir}. Renaming to disable IDE migration prompts...`);
        fs.renameSync(oldAppDataDir, backupOldAppDataDir);
        logger.info(`Successfully renamed legacy Antigravity data folder to ${backupOldAppDataDir}`);
      }
    } catch (renameErr: any) {
      logger.warn(`Failed to rename legacy Antigravity configuration directory: ${renameErr.message}`);
    }

    const globalState = context.globalState;
    const secrets = context.secrets;

    // 1. Load accounts list
    let accounts = globalState.get<any[]>('antigravity.accounts.list', []);
    let activeAccount = globalState.get<string | null>('antigravity.accounts.active', null);
    let accountsModified = false;

    // Keep a map of old email -> new email
    const emailReplacements = new Map<string, string>();

    // Step A: Sanitize emails with ".con" typo in the accounts list
    const sanitizedAccounts = accounts.map(account => {
      const email = account.email;
      if (email && email.toLowerCase().endsWith('.con')) {
        const newEmail = email.slice(0, -4) + '.com';
        emailReplacements.set(email.toLowerCase(), newEmail.toLowerCase());
        logger.info(`Detected typo email in list: "${email}". Correcting to "${newEmail}"`);
        accountsModified = true;
        return {
          ...account,
          email: newEmail,
          displayName: account.displayName === email ? newEmail : account.displayName
        };
      }
      return account;
    });

    // Step B: Sanitize active account setting
    if (activeAccount && activeAccount.toLowerCase().endsWith('.con')) {
      const newActive = activeAccount.slice(0, -4) + '.com';
      logger.info(`Detected typo in active account config: "${activeAccount}". Correcting to "${newActive}"`);
      activeAccount = newActive;
      globalState.update('antigravity.accounts.active', activeAccount);
    }

    if (accountsModified) {
      logger.info('Saving sanitized accounts list to globalState...');
      await globalState.update('antigravity.accounts.list', sanitizedAccounts);
      accounts = sanitizedAccounts;
    }

    // Step C: Migrate secrets and clean up legacy/typo keys
    for (const account of accounts) {
      const email = account.email;
      // Check if we corrected this email from a typo
      const oldEmail = Array.from(emailReplacements.entries()).find(([_, val]) => val === email.toLowerCase())?.[0];

      // Source emails to migrate from: check both current email and typo email
      const sourceEmailsToCheck = [email];
      if (oldEmail) {
        sourceEmailsToCheck.push(oldEmail);
      }

      for (const srcEmail of sourceEmailsToCheck) {
        // Old legacy keys:
        const oldLegacyKeys = {
          ref: `antigravity.account.${srcEmail}.refreshToken`,
          acc: `antigravity.account.${srcEmail}.accessToken`,
          meta: `antigravity.account.${srcEmail}.metadata`,
          profile: `antigravity.account.${srcEmail}.deviceProfile`
        };

        // Old Hub keys:
        const oldHubKeys = {
          ref: `antigravityHub.secure.${srcEmail}.refreshToken`,
          acc: `antigravityHub.secure.${srcEmail}.accessToken`,
          meta: `antigravityHub.secure.${srcEmail}.metadata`,
          profile: `antigravityHub.secure.${srcEmail}.deviceProfile`
        };

        // New isolated keys for Antigravity Account extension:
        const newRefKey = `antigravityAccount.secure.${email}.refreshToken`;
        const newAccKey = `antigravityAccount.secure.${email}.accessToken`;
        const newMetaKey = `antigravityAccount.secure.${email}.metadata`;
        const newProfileKey = `antigravityAccount.secure.${email}.deviceProfile`;

        // Retrieve from old keys, prioritizing Hub keys over older legacy keys
        const refreshToken = (await secrets.get(oldHubKeys.ref)) || (await secrets.get(oldLegacyKeys.ref));
        const accessToken = (await secrets.get(oldHubKeys.acc)) || (await secrets.get(oldLegacyKeys.acc));
        const metadata = (await secrets.get(oldHubKeys.meta)) || (await secrets.get(oldLegacyKeys.meta));
        const deviceProfile = (await secrets.get(oldHubKeys.profile)) || (await secrets.get(oldLegacyKeys.profile));

        if (refreshToken || accessToken || metadata || deviceProfile) {
          logger.info(`Migrating credentials for account: ${srcEmail} -> ${email}`);

          if (refreshToken) await secrets.store(newRefKey, refreshToken);
          if (accessToken) await secrets.store(newAccKey, accessToken);
          if (metadata) await secrets.store(newMetaKey, metadata);
          if (deviceProfile) await secrets.store(newProfileKey, deviceProfile);
        }

        // Clean up old keys unconditionally from SecretStorage
        await secrets.delete(oldLegacyKeys.ref);
        await secrets.delete(oldLegacyKeys.acc);
        await secrets.delete(oldLegacyKeys.meta);
        await secrets.delete(oldLegacyKeys.profile);

        await secrets.delete(oldHubKeys.ref);
        await secrets.delete(oldHubKeys.acc);
        await secrets.delete(oldHubKeys.meta);
        await secrets.delete(oldHubKeys.profile);
      }
    }

    logger.info('Storage migration and sanitization check finished successfully.');
  } catch (error: any) {
    logger.error('Failed to complete storage migration/sanitization', error);
  }
}

/**
 * Ensures that the IDE's MCP config file (~/.gemini/config/mcp_config.json) is valid.
 * If the file exists and is empty (0 bytes) or contains invalid/corrupted JSON,
 * this function automatically overwrites it with `{}` to prevent Antigravity IDE
 * from throwing a 500 error on every model call.
 */
async function ensureValidMcpConfig(): Promise<void> {
  const logger = Logger.getInstance();
  const os = require('os');
  const path = require('path');
  const fs = require('fs');

  try {
    const homeDir = os.homedir();
    const mcpConfigDir = path.join(homeDir, '.gemini', 'config');
    const mcpConfigPath = path.join(mcpConfigDir, 'mcp_config.json');

    if (fs.existsSync(mcpConfigPath)) {
      const stat = fs.statSync(mcpConfigPath);
      let needsRepair = false;

      if (stat.size === 0) {
        logger.info(`Detected empty (0-byte) mcp_config.json at: ${mcpConfigPath}. Preparing to repair...`);
        needsRepair = true;
      } else {
        try {
          const content = fs.readFileSync(mcpConfigPath, 'utf-8').trim();
          if (!content) {
            needsRepair = true;
          } else {
            JSON.parse(content); // Test if it's valid JSON
          }
        } catch (parseError) {
          logger.info(`Detected invalid JSON in mcp_config.json at: ${mcpConfigPath}. Preparing to repair...`);
          needsRepair = true;
        }
      }

      if (needsRepair) {
        fs.writeFileSync(mcpConfigPath, '{}', 'utf-8');
        logger.info(`Successfully repaired mcp_config.json (wrote empty object '{}') to prevent IDE 500 crashes.`);
      }
    }
  } catch (error: any) {
    logger.error('Failed to run mcp_config.json validation and repair', error);
  }
}
