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
 * - Registering commands
 * - Setting up the sidebar webview
 * - Initializing the status bar
 */
export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const logger = Logger.getInstance();
  logger.info('Antigravity Account is activating...');

  // ── Initialize Configuration ──
  const config = ExtensionConfig.getInstance();
  config.initialize(context);

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
      const editorLang = vscode.env.language.split('-')[0].toLowerCase();
      if (editorLang === 'ar') {
        language = 'ar';
      } else if (editorLang === 'es') {
        language = 'es';
      } else {
        language = 'en';
      }
    }
    i18n.setLocale(language);
    logger.info(`Language set to: ${language} (configured: ${config.getLanguage()})`);
  };
  
  updateLanguage();

  // ── Register Commands ──
  const commands = registerCommands(context, i18n);
  context.subscriptions.push(...commands);

  // ── Listen for configuration changes ──
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e: vscode.ConfigurationChangeEvent) => {
      if (e.affectsConfiguration('antigravityAccount.language')) {
        updateLanguage();
      }
    })
  );



  logger.info('Antigravity Account activated successfully.');
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
 * Register all extension commands.
 * Each command delegates to the appropriate use case / controller.
 */
function registerCommands(
  context: vscode.ExtensionContext,
  i18n: I18nService
): vscode.Disposable[] {
  const authService = new AuthService();
  const balanceService = new BalanceService();
  const accountRepo = new AccountRepositoryImpl(context);
  const stateDbService = new StateDbService(context);
  const accountService = new AccountService(authService, balanceService, accountRepo, stateDbService);

  const disposables: vscode.Disposable[] = [];

  // ── Periodic Check for Active Account changes in state.vscdb ──
  const logger = Logger.getInstance();
  let lastActiveEmail: string | null = null;
  accountService.getActiveAntigravityEmail().then((email: string | null | undefined) => {
    lastActiveEmail = email || null;
  }).catch(() => {});

  const activeCheckInterval = setInterval(async () => {
    try {
      const activeInfo = await accountService.getActiveAntigravityAccountInfo();
      const currentActive = activeInfo?.email || null;
      if (currentActive !== lastActiveEmail) {
        logger.info(`Active account changed in IDE to: ${currentActive}`);
        lastActiveEmail = currentActive;
        accountService.emitAccountsChanged();
      }

      // Sync active tokens from state.vscdb to our local repository
      if (currentActive && activeInfo?.tokens) {
        const tokens = activeInfo.tokens;
        const storedTokens = await accountRepo.getTokens(currentActive);
        // Only update if the access token or refresh token is different to avoid unnecessary writes
        if (!storedTokens || storedTokens.accessToken !== tokens.accessToken || storedTokens.refreshToken !== tokens.refreshToken) {
          await accountRepo.storeTokens(currentActive, tokens);
          logger.info(`Synchronized active tokens for ${currentActive} from state.vscdb to repository.`);
        }
      }
    } catch (e) {
      // ignore
    }
  }, 5000); // Check every 5 seconds for responsive updates

  disposables.push({
    dispose: () => clearInterval(activeCheckInterval)
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

  // No longer syncing on startup, webview detects it dynamically on render.

  disposables.push(
    vscode.commands.registerCommand('antigravity-account.openPanel', () => {
      // Focus the webview panel in the sidebar
      vscode.commands.executeCommand('antigravity-account.accountsView.focus');
    })
  );



  disposables.push(
    vscode.commands.registerCommand('antigravity-account.addAccount', async () => {
      await accountService.addAccountWorkflow();
    })
  );

  disposables.push(
    vscode.commands.registerCommand('antigravity-account.switchAccount', async () => {
      // Temporary quick pick until UI is built
      const accounts = await accountRepo.getAccountSummaries();
      if (accounts.length === 0) {
        vscode.window.showWarningMessage(i18n.t('extension.noAccountsToSwitch'));
        return;
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
        await accountService.switchAccountWorkflow(picked.email);
      }
    })
  );

  disposables.push(
    vscode.commands.registerCommand('antigravity-account.refreshBalances', async () => {
      await accountService.refreshBalancesWorkflow(true);
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
        vscode.commands.executeCommand('antigravity-account.openPanel'); // trigger webview focus to reflect changes if possible
      }
    })
  );

  return disposables;
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
