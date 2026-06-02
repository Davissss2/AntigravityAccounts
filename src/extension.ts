/**
 * Antigravity Hub — VS Code Extension Entry Point
 *
 * This is the main activation/deactivation entry for the extension.
 * It follows the Composition Root pattern: all dependencies are wired here
 * and injected into the appropriate layers.
 */

import * as vscode from 'vscode';
import { Logger } from './core/utils/logger';
import { I18nService } from './i18n/i18n.service';
import { ExtensionConfig } from './core/config/extension.config';

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
  logger.info('Antigravity Hub is activating...');

  // ── Initialize Configuration ──
  const config = ExtensionConfig.getInstance();
  config.initialize(context);

  // ── Run Storage Migration & Sanitization ──
  try {
    await migrateAndSanitizeStorage(context);
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
      if (e.affectsConfiguration('antigravityHub.language')) {
        updateLanguage();
      }
    })
  );

  logger.info('Antigravity Hub activated successfully.');
}

/**
 * Called when the extension is deactivated.
 * Clean up resources here.
 */
export function deactivate(): void {
  const logger = Logger.getInstance();
  logger.info('Antigravity Hub deactivated.');
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

  // Initialize UI Providers
  const statusBarProvider = new StatusBarProvider(accountRepo, accountService);
  disposables.push(statusBarProvider);

  const accountsProvider = new AccountsWebviewProvider(context.extensionUri, accountRepo, accountService);
  disposables.push(
    vscode.window.registerWebviewViewProvider(AccountsWebviewProvider.viewType, accountsProvider)
  );

  // Listen for account state changes to update UI
  disposables.push(
    accountService.onAccountsChanged(() => {
      statusBarProvider.update();
    })
  );

  // No longer syncing on startup, webview detects it dynamically on render.

  disposables.push(
    vscode.commands.registerCommand('antigravity-hub.openPanel', () => {
      // Focus the webview panel in the sidebar
      vscode.commands.executeCommand('antigravity-hub.accountsView.focus');
    })
  );



  disposables.push(
    vscode.commands.registerCommand('antigravity-hub.addAccount', async () => {
      await accountService.addAccountWorkflow();
    })
  );

  disposables.push(
    vscode.commands.registerCommand('antigravity-hub.switchAccount', async () => {
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
    vscode.commands.registerCommand('antigravity-hub.refreshBalances', async () => {
      await accountService.refreshBalancesWorkflow(true);
    })
  );

  disposables.push(
    vscode.commands.registerCommand('antigravity-hub.setLanguage', async () => {
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
        const extConfig = vscode.workspace.getConfiguration('antigravityHub');
        await extConfig.update('language', picked.description, vscode.ConfigurationTarget.Global);
        vscode.commands.executeCommand('antigravity-hub.openPanel'); // trigger webview focus to reflect changes if possible
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
 *    from the conflict-prone prefix "antigravity.account.*" to the isolated prefix "antigravityHub.secure.*".
 * 3. Wipes old "antigravity.account.*" keys from SecretStorage to prevent IDE 500 crashes.
 */
async function migrateAndSanitizeStorage(context: vscode.ExtensionContext): Promise<void> {
  const logger = Logger.getInstance();
  logger.info('Starting storage migration and sanitization check...');

  try {
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
        // Old keys:
        const oldRefKey = `antigravity.account.${srcEmail}.refreshToken`;
        const oldAccKey = `antigravity.account.${srcEmail}.accessToken`;
        const oldMetaKey = `antigravity.account.${srcEmail}.metadata`;
        const oldProfileKey = `antigravity.account.${srcEmail}.deviceProfile`;

        // New isolated keys:
        const newRefKey = `antigravityHub.secure.${email}.refreshToken`;
        const newAccKey = `antigravityHub.secure.${email}.accessToken`;
        const newMetaKey = `antigravityHub.secure.${email}.metadata`;
        const newProfileKey = `antigravityHub.secure.${email}.deviceProfile`;

        // Retrieve from old keys
        const refreshToken = await secrets.get(oldRefKey);
        const accessToken = await secrets.get(oldAccKey);
        const metadata = await secrets.get(oldMetaKey);
        const deviceProfile = await secrets.get(oldProfileKey);

        if (refreshToken || accessToken || metadata || deviceProfile) {
          logger.info(`Migrating credentials for account: ${srcEmail} -> ${email}`);

          if (refreshToken) await secrets.store(newRefKey, refreshToken);
          if (accessToken) await secrets.store(newAccKey, accessToken);
          if (metadata) await secrets.store(newMetaKey, metadata);
          if (deviceProfile) await secrets.store(newProfileKey, deviceProfile);
        }

        // Clean up old keys unconditionally from SecretStorage
        await secrets.delete(oldRefKey);
        await secrets.delete(oldAccKey);
        await secrets.delete(oldMetaKey);
        await secrets.delete(oldProfileKey);
      }
    }

    logger.info('Storage migration and sanitization check finished successfully.');
  } catch (error: any) {
    logger.error('Failed to complete storage migration/sanitization', error);
  }
}
