/**
 * Accounts Webview Provider
 * 
 * Manages the UI in the VS Code Sidebar.
 * Displays accounts, balances, and provides quick actions (Add, Switch, Delete).
 * Injects a beautiful Dark Purple CSS theme directly.
 */

import * as vscode from 'vscode';
import * as path from 'path';
import * as os from 'os';
import { IAccountRepository } from '../../core/domain/repositories/account.repository';
import { AccountService } from '../../features/accounts/account.service';
import { I18nService } from '../../i18n/i18n.service';
import { Logger } from '../../core/utils/logger';
import { Account, AccountTokens, AccountStatus } from '../../core/domain/models/account.model';
import { DeviceProfile } from '../../core/domain/models/device-profile.model';
import { CryptoUtils } from '../../core/utils/crypto.utils';
import { ExtensionConfig } from '../../core/config/extension.config';
import { getFriendlyModelName, normalizeModelKey } from '../../core/utils/model.utils';
import { isEmailMatch } from '../../core/utils/account.utils';

/** Shape of an individual account inside the backup */
interface ExportedAccount {
  email: string;
  account: Account;
  tokens: AccountTokens;
  deviceProfile: DeviceProfile | null;
}

/** Inner payload (the data that gets encrypted) */
interface ExportPayload {
  _format: 'antigravity-hub-backup';
  _version: 2;
  exportedAt: string;
  accounts: ExportedAccount[];
}

/** Outer envelope written to the file (v2 = encrypted) */
interface EncryptedEnvelope {
  _format: 'antigravity-hub-backup';
  _version: 2;
  encrypted: string; // AES-256-GCM ciphertext (salt:iv:authTag:data)
}

/** Legacy v1 format (unencrypted, for backward compatibility) */
interface LegacyExportPayload {
  _format: 'antigravity-hub-backup';
  _version: 1;
  exportedAt: string;
  accounts: ExportedAccount[];
}

export class AccountsWebviewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'antigravity-account.accountsView';
  private _view?: vscode.WebviewView;

  /**
   * Cached email of the account pinned by detectAndPinActiveAccount().
   * null = no account is pinned (either list is empty, logged out, or email not in list).
   * Once set, the post-refresh re-sort will respect this pin and not re-order this account.
   */
  private _pinnedActiveEmail: string | null = null;

  /** Current search query preserved across webview re-renders */
  private _searchQuery: string = '';

  /** Active refresh progress state to preserve banner across webview re-renders/tab switches */
  private _isRefreshingProgress: {
    isRefreshing: boolean;
    totalAccounts: number;
    currentIndex: number;
    currentEmail: string;
  } = {
    isRefreshing: false,
    totalAccounts: 0,
    currentIndex: 0,
    currentEmail: '',
  };

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly accountRepo: IAccountRepository,
    private readonly accountService: AccountService
  ) {
    // Automatically re-detect active account and re-render when data changes
    this.accountService.onAccountsChanged(() => {
      // Do not recreate full HTML DOM during active scan since cards update individually
      if (!this._isRefreshingProgress.isRefreshing) {
        this.detectAndPinActiveAccount().then(() => this.refresh());
      }
    });
  }

  /** AbortController for the current refresh cycle (null = not refreshing) */
  private _refreshAbortController: AbortController | null = null;

  public resolveWebviewView(
    webviewView: vscode.WebviewView,
    context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken,
  ) {
    const i18n = I18nService.getInstance();
    this._view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this.extensionUri]
    };

    // Handle messages sent from the Webview HTML UI
    webviewView.webview.onDidReceiveMessage(async (message) => {
      Logger.getInstance().info(`[Webview Message] Received: ${JSON.stringify(message)}`);
      switch (message.command) {
        case 'logError':
          Logger.getInstance().error(`[Webview JS Error] ${message.message} at ${message.source}:${message.lineno}:${message.colno}. Stack: ${message.stack}`);
          break;
        case 'showWarning':
          if (message.text) {
            vscode.window.showWarningMessage(message.text);
          }
          break;
        case 'consoleLog':
          const logMsg = `[Webview Console] [${message.level}] ${message.args.join(' ')}`;
          if (message.level === 'error') {
            Logger.getInstance().error(logMsg);
          } else if (message.level === 'warn') {
            Logger.getInstance().warn(logMsg);
          } else {
            Logger.getInstance().info(logMsg);
          }
          break;
        case 'addAccount':
          vscode.commands.executeCommand('antigravity-account.addAccount');
          break;
        case 'switchAccount':
          if (message.email) {
            const confirm = await vscode.window.showWarningMessage(
              i18n.t('accounts.confirmSwitch', { email: message.email }),
              { modal: true },
              i18n.t('common.yes')
            );
            if (confirm === i18n.t('common.yes')) {
              try {
                const result = await this.accountService.switchAccountWorkflow(message.email);
                if (result !== 'success') {
                  this._view?.webview.postMessage({ command: 'accountSwitchCancelled', email: message.email });
                }
              } catch (err) {
                this._view?.webview.postMessage({ command: 'accountSwitchCancelled', email: message.email });
              }
            } else {
              this._view?.webview.postMessage({ command: 'accountSwitchCancelled', email: message.email });
            }
          }
          break;
        case 'updateAlias':
          if (message.email && message.alias !== undefined) {
            await this.accountRepo.updateAccount(message.email, { alias: message.alias.trim() || undefined });
            this.accountService.emitAccountsChanged();
          }
          break;
        case 'deleteAccount':
          if (message.email) {
            await this.accountService.removeAccountWorkflow(message.email);
          }
          break;
        case 'reAuthenticate':
          if (message.email) {
            await this.accountService.reAuthenticateWorkflow(message.email);
          }
          break;
        case 'refreshAccounts':
          if (message.filteredEmails && message.filteredEmails.length === 0) {
            // Search mode with no visible results — do nothing
            break;
          }
          await this.handleProgressiveRefresh(true, message.filteredEmails || undefined, true);
          break;
        case 'refreshSingleAccount':
          if (message.email) {
            await this.handleSingleAccountRefresh(message.email);
          }
          break;
        case 'searchChanged':
          this._searchQuery = message.query || '';
          break;
        case 'cancelRefresh':
          this.accountService.cancelQueue();
          if (this._refreshAbortController) {
            this._refreshAbortController.abort();
            this._refreshAbortController = null;
            Logger.getInstance().info('Refresh abort signal sent by user.');
          }
          break;
        case 'switchModel':
          if (message.email && message.modelKey) {
            await this.accountRepo.setPreferredModel(message.modelKey);
            this.accountService.emitAccountsChanged();
            this._view?.webview.postMessage({ command: 'modelSwitched', email: message.email, modelKey: message.modelKey });
          }
          break;
        case 'exportAccounts':
          await this.handleExport();
          break;
        case 'importAccounts':
          await this.handleImport();
          break;
        case 'saveSettings': {
          const config = vscode.workspace.getConfiguration('antigravityAccount');
          const updates: Promise<any>[] = [];

          if (message.preferredModel !== undefined) {
            updates.push(this.accountRepo.setPreferredModel(message.preferredModel));
          }
          if (message.theme !== undefined && config.get<string>('theme') !== message.theme) {
            updates.push(Promise.resolve(config.update('theme', message.theme, vscode.ConfigurationTarget.Global)));
          }
          if (message.sortBy !== undefined && config.get<string>('sortBy') !== message.sortBy) {
            updates.push(Promise.resolve(config.update('sortBy', message.sortBy, vscode.ConfigurationTarget.Global)));
          }
          if (message.cacheDurationDays !== undefined && config.get<number>('cacheDurationDays') !== message.cacheDurationDays) {
            updates.push(Promise.resolve(config.update('cacheDurationDays', message.cacheDurationDays, vscode.ConfigurationTarget.Global)));
          }
          if (message.autoRefreshEnabled !== undefined && config.get<boolean>('autoRefreshEnabled') !== message.autoRefreshEnabled) {
            updates.push(Promise.resolve(config.update('autoRefreshEnabled', message.autoRefreshEnabled, vscode.ConfigurationTarget.Global)));
          }
          if (message.autoRotateEnabled !== undefined && config.get<boolean>('autoRotateEnabled') !== message.autoRotateEnabled) {
            updates.push(Promise.resolve(config.update('autoRotateEnabled', message.autoRotateEnabled, vscode.ConfigurationTarget.Global)));
          }
          if (message.lowCreditNotificationsEnabled !== undefined && config.get<boolean>('lowCreditNotificationsEnabled') !== message.lowCreditNotificationsEnabled) {
            updates.push(Promise.resolve(config.update('lowCreditNotificationsEnabled', message.lowCreditNotificationsEnabled, vscode.ConfigurationTarget.Global)));
          }
          if (message.refreshIntervalMinutes !== undefined && config.get<number>('refreshIntervalMinutes') !== message.refreshIntervalMinutes) {
            updates.push(Promise.resolve(config.update('refreshIntervalMinutes', message.refreshIntervalMinutes, vscode.ConfigurationTarget.Global)));
          }
          if (message.language !== undefined && config.get<string>('language') !== message.language) {
            updates.push(Promise.resolve(config.update('language', message.language, vscode.ConfigurationTarget.Global)));
          }

          if (updates.length > 0) {
            await Promise.all(updates);
          }
          await this.refresh();
          this._view?.webview.postMessage({ command: 'hideLoading' });
          break;
        }
      }
    });

    // Skip all account operations if not running in Antigravity editor
    if (!this.isAntigravityEditor()) {
      this.refresh();
      return;
    }

    // Step 1: Detect and pin the active Antigravity account (independent of balance refresh)
    // Step 2: Render the UI with the pinned account at the top
    // Step 3: Conditionally trigger balance refresh based on settings
    this.detectAndPinActiveAccount().then(() => this.refresh()).then(async () => {
      const accounts = await this.accountRepo.getAllAccounts();
      if (accounts.length === 0) return;

      const config = ExtensionConfig.getInstance();

      if (config.isAutoRefreshEnabled()) {
        // Auto-refresh ENABLED:
        // 1. Refresh the active account if it hasn't been refreshed in the last 10 seconds
        await this.handleActiveAccountRefresh(10 * 1000);

        // 2. Identify inactive accounts that have never been refreshed or have no balance data
        const accounts = await this.accountRepo.getAllAccounts();
        const inactiveEmailsToRefresh: string[] = [];
        
        for (const account of accounts) {
          const isPinned = this._pinnedActiveEmail && isEmailMatch(account.email, this._pinnedActiveEmail);
          if (!isPinned) {
            if (!account.lastRefreshedAt || Object.keys(account.balances || {}).length === 0) {
              inactiveEmailsToRefresh.push(account.email);
            }
          }
        }

        // 3. Trigger progressive refresh only for those specific accounts without balance data
        if (inactiveEmailsToRefresh.length > 0) {
          Logger.getInstance().info(`Auto-refreshing ${inactiveEmailsToRefresh.length} new inactive accounts without balance: ${inactiveEmailsToRefresh.join(', ')}`);
          await this.handleProgressiveRefresh(false, inactiveEmailsToRefresh);
        }
      }
    });
  }

  /**
   * Checks if the current editor is Antigravity (or a variant thereof).
   */
  private isAntigravityEditor(): boolean {
    return vscode.env.appName.toLowerCase().includes('antigravity');
  }

  /**
   * Forces a re-render of the Webview HTML.
   */
  public async refresh() {
    if (this._view) {
      const html = await this._getHtmlForWebview(this._view.webview);
      this._view.webview.html = html;
    }
  }

  // ─── Active Account Detection (Independent Process) ───────────────────────

  /**
   * Independent process: Detects the currently active Antigravity account
   * and pins it to the top of the account list.
   * 
   * This is NOT part of the balance refresh flow. It runs:
   *   - When the UI opens (before balance refresh consideration)
   *   - Before any manual balance refresh
   *   - When the user clicks the manual refresh button
   * 
   * Flow:
   *   1. Check if the tool's account list is empty → stop
   *   2. Read the logged-in email from Antigravity's state.vscdb
   *   3. If no email (logged out) → clear pin, stop
   *   4. If email exists, check if it's in the tool's account list
   *   5. If found → pin it (store in _pinnedActiveEmail)
   *   6. If not found → clear pin
   */
  private async detectAndPinActiveAccount(): Promise<void> {
    // Step 1: Check if the account list is empty
    const accounts = await this.accountRepo.getAllAccounts();
    if (accounts.length === 0) {
      this._pinnedActiveEmail = null;
      return;
    }

    // Step 2: Get the currently logged-in Antigravity account
    const activeEmail = await this.accountService.getActiveAntigravityEmail();

    // Step 2.5: If there was an error reading the database, preserve the current pin
    if (activeEmail === undefined) {
      Logger.getInstance().info('Failed to read active email, preserving current pin.');
      return;
    }

    // Step 3: If no account (Antigravity is logged out) → clear pin and stop
    if (!activeEmail) {
      this._pinnedActiveEmail = null;
      return;
    }

    // Step 4: Check if the email is in the tool's account list
    const matchedAccount = accounts.find(a => isEmailMatch(a.email, activeEmail));

    if (matchedAccount) {
      // Step 5: Pin this account — it will be moved to the top of the list
      this._pinnedActiveEmail = matchedAccount.email.toLowerCase();
      Logger.getInstance().info(`Pinned active account: ${matchedAccount.email}`);
    } else {
      // Step 6: Email not in our list — clear pin
      this._pinnedActiveEmail = null;
      Logger.getInstance().info(`Active Antigravity email "${activeEmail}" does not match any stored account.`);
    }
  }

  // ─── Progressive Refresh Handler ──────────────────────────────────────────

  /**
   * Refreshes all account balances progressively.
   * Sends per-account start/done messages to the webview so the UI can
   * show a small loading indicator on each card individually instead of
   * a full-screen overlay.
   */
  private async handleProgressiveRefresh(notify: boolean = true, onlyEmails?: string[], force: boolean = false): Promise<void> {
    // Step 0: Detect and pin active account BEFORE starting the balance refresh.
    // This is an independent verification — it always runs regardless of cooldowns.
    await this.detectAndPinActiveAccount();
    await this.refresh();

    // Step 1: Compute the display order so the refresh iterates accounts in
    // the same top-to-bottom sequence visible in the UI.
    let orderedEmails = await this.getDisplayOrderEmails();

    // If only specific emails should be refreshed (search-filtered), narrow the list
    if (onlyEmails && onlyEmails.length > 0) {
      const filterSet = new Set(onlyEmails.map(e => e.toLowerCase()));
      orderedEmails = orderedEmails.filter(e => filterSet.has(e.toLowerCase()));
    }

    const totalAccounts = orderedEmails.length;
    let currentIndex = 0;

    // Track active refresh progress state
    this._isRefreshingProgress = {
      isRefreshing: true,
      totalAccounts,
      currentIndex: 0,
      currentEmail: orderedEmails[0] || '',
    };

    // Create abort controller for this refresh cycle
    this._refreshAbortController = new AbortController();
    const signal = this._refreshAbortController.signal;

    // Tell webview to disable all buttons and show progress banner
    this._view?.webview.postMessage({ command: 'refreshStarted', totalAccounts });

    let didRun = false;
    try {
      didRun = await this.accountService.refreshBalancesWorkflow(notify, {
        signal,
        orderedEmails,
        onlyEmails,
        force,
        onAccountStart: (email: string) => {
          currentIndex++;
          this._isRefreshingProgress.currentIndex = currentIndex;
          this._isRefreshingProgress.currentEmail = email;
          this._view?.webview.postMessage({ command: 'accountRefreshStart', email, currentIndex, totalAccounts });
        },
        onAccountDone: async (email: string, updatedBalances?: Record<string, any>, updatedStatus?: string) => {
          const account = await this.accountRepo.getAccount(email);
          let cardHtml = '';
          if (account) {
            const preferredModel = await this.accountRepo.getPreferredModel();
            const effectivePreferred = preferredModel || '';
            const isPinned = this._pinnedActiveEmail && isEmailMatch(account.email, this._pinnedActiveEmail);
            account.isActive = !!isPinned;
            cardHtml = this.renderAccountCard(account, effectivePreferred);
          }
          this._view?.webview.postMessage({ command: 'accountRefreshDone', email, html: cardHtml, balances: updatedBalances, status: updatedStatus });
        },
        onComplete: () => {
          // Will re-render after finally block
        }
      });
    } finally {
      this._isRefreshingProgress = {
        isRefreshing: false,
        totalAccounts: 0,
        currentIndex: 0,
        currentEmail: '',
      };
      this._refreshAbortController = null;
      const wasCancelled = !!signal.aborted || !didRun;
      this._view?.webview.postMessage({ command: 'refreshFinished', wasCancelled });
      await this.refresh();
    }
  }

  // ─── Active Account Refresh (Auto-refresh Disabled) ─────────────────────

  /**
   * Refreshes only the active (pinned) account's balance.
   * Used when auto-refresh is disabled — provides a lightweight update
   * for just the account currently in use by Antigravity.
   * Only runs if more than 5 minutes have passed since that account's last refresh.
   */
  private async handleActiveAccountRefresh(cooldownMs: number = 5 * 60 * 1000): Promise<void> {
    if (!this._pinnedActiveEmail) return;

    // Find the actual email (preserving original case) from the account list
    const accounts = await this.accountRepo.getAllAccounts();
    const activeAccount = accounts.find(a => a.email.toLowerCase() === this._pinnedActiveEmail);
    if (!activeAccount) return;

    // Check if cooldownMs have passed since this account's last refresh
    if (activeAccount.lastRefreshedAt) {
      const lastRefreshed = new Date(activeAccount.lastRefreshedAt).getTime();
      if (Date.now() - lastRefreshed <= cooldownMs) return;
    }

    // Show progress banner for single account refresh
    this._view?.webview.postMessage({ command: 'refreshStarted', totalAccounts: 1 });

    try {
      // Refresh this single account with progress banner
      await this.accountService.refreshSingleAccountBalance(activeAccount.email, {
        onStart: (email: string) => {
          this._view?.webview.postMessage({ command: 'accountRefreshStart', email, currentIndex: 1, totalAccounts: 1 });
        },
        onDone: (email: string, updatedBalances?: Record<string, any>, updatedStatus?: string) => {
          this._view?.webview.postMessage({ command: 'accountRefreshDone', email, balances: updatedBalances, status: updatedStatus });
        }
      });
    } catch (e: any) {
      Logger.getInstance().error(`Error during active account refresh for ${activeAccount.email}`, e);
    } finally {
      // Tell webview refresh is finished
      this._view?.webview.postMessage({ command: 'refreshFinished', wasCancelled: false });
      // Re-render to apply updated data and sorting
      await this.refresh();
    }
  }

  /**
   * Refreshes a single account's balance manually.
   * Sends the updated card HTML back to the webview progressively.
   */
  private async handleSingleAccountRefresh(email: string): Promise<void> {
    try {
      this._view?.webview.postMessage({ command: 'refreshStarted', totalAccounts: 1 });
      
      await this.accountService.refreshSingleAccountBalance(email, {
        onStart: (email: string) => {
          this._view?.webview.postMessage({ command: 'accountRefreshStart', email, currentIndex: 1, totalAccounts: 1 });
        },
        onDone: async (email: string, updatedBalances?: Record<string, any>, updatedStatus?: string) => {
          const account = await this.accountRepo.getAccount(email);
          let cardHtml = '';
          if (account) {
            const preferredModel = await this.accountRepo.getPreferredModel();
            const effectivePreferred = preferredModel || '';
            const isPinned = this._pinnedActiveEmail && isEmailMatch(account.email, this._pinnedActiveEmail);
            account.isActive = !!isPinned;
            cardHtml = this.renderAccountCard(account, effectivePreferred);
          }
          this._view?.webview.postMessage({ command: 'accountRefreshDone', email, html: cardHtml, balances: updatedBalances, status: updatedStatus });
        }
      });
    } catch (e: any) {
      Logger.getInstance().error(`Error during manual single account refresh for ${email}`, e);
    } finally {
      this._view?.webview.postMessage({ command: 'refreshFinished', wasCancelled: false });
      await this.refresh();
    }
  }

  private async getDisplayOrderEmails(): Promise<string[]> {
    const accounts = await this.accountRepo.getAllAccounts();
    const pinnedEmailLower = this._pinnedActiveEmail;

    accounts.forEach(acc => {
      acc.isActive = (pinnedEmailLower !== null && acc.email.toLowerCase() === pinnedEmailLower);
    });

    const preferredModel = await this.accountRepo.getPreferredModel();
    const effectivePreferred = preferredModel || '';

    this.sortAccounts(accounts, effectivePreferred, pinnedEmailLower);

    return accounts.map(a => a.email);
  }

  // ─── Export Handler ──────────────────────────────────────────────────────

  private async handleExport(): Promise<void> {
    const logger = Logger.getInstance();
    const i18n = I18nService.getInstance();
    try {
      const accounts = await this.accountRepo.getAllAccounts();
      if (accounts.length === 0) {
        vscode.window.showWarningMessage(i18n.t('accounts.noExportAccounts'));
        return;
      }

      // ── Step 1: Ask user for an encryption password ──
      const password = await vscode.window.showInputBox({
        prompt: i18n.t('accounts.exportPasswordPrompt'),
        password: true,
        placeHolder: i18n.t('accounts.exportPasswordPlaceholder'),
        validateInput: (value) => {
          if (!value || value.length < 6) {
            return i18n.t('accounts.passwordTooShort');
          }
          return undefined;
        }
      });

      if (!password) return; // User cancelled

      // ── Step 2: Confirm password ──
      const confirmPassword = await vscode.window.showInputBox({
        prompt: i18n.t('accounts.exportPasswordConfirm'),
        password: true,
        placeHolder: i18n.t('accounts.exportPasswordPlaceholder'),
      });

      if (confirmPassword !== password) {
        vscode.window.showErrorMessage(i18n.t('accounts.passwordMismatch'));
        return;
      }

      this._view?.webview.postMessage({ command: 'showLoading', text: i18n.t('accounts.preparingExport') });

      // ── Step 3: Collect account data ──
      const exportedAccounts: ExportedAccount[] = [];
      for (const acc of accounts) {
        const tokens = await this.accountRepo.getTokens(acc.email);
        const deviceProfile = await this.accountRepo.getDeviceProfile(acc.email);
        if (!tokens) {
          logger.info(`Skipping export for ${acc.email}: no tokens found.`);
          continue;
        }
        exportedAccounts.push({
          email: acc.email,
          account: acc,
          tokens,
          deviceProfile,
        });
      }

      if (exportedAccounts.length === 0) {
        this._view?.webview.postMessage({ command: 'hideLoading' });
        vscode.window.showWarningMessage(i18n.t('accounts.noValidExportData'));
        return;
      }

      // ── Step 4: Build and encrypt the payload ──
      const payload: ExportPayload = {
        _format: 'antigravity-hub-backup',
        _version: 2,
        exportedAt: new Date().toISOString(),
        accounts: exportedAccounts,
      };

      const jsonStr = JSON.stringify(payload);
      const encryptedContent = CryptoUtils.encryptWithPassword(jsonStr, password);

      const envelope: EncryptedEnvelope = {
        _format: 'antigravity-hub-backup',
        _version: 2,
        encrypted: encryptedContent,
      };

      // ── Step 5: Save to file ──
      const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri;
      const defaultUri = workspaceFolder
        ? vscode.Uri.joinPath(workspaceFolder, 'antigravity-backup.json')
        : vscode.Uri.file(path.join(os.homedir(), 'Desktop', 'antigravity-backup.json'));

      const saveUri = await vscode.window.showSaveDialog({
        defaultUri,
        filters: { 'JSON Files': ['json'] },
        title: i18n.t('accounts.saveBackup'),
      });

      this._view?.webview.postMessage({ command: 'hideLoading' });

      if (!saveUri) return; // User cancelled

      const fs = require('fs');
      fs.writeFileSync(saveUri.fsPath, JSON.stringify(envelope), 'utf-8');

      logger.info(`Exported ${exportedAccounts.length} accounts (encrypted) to ${saveUri.fsPath}`);
      vscode.window.showInformationMessage(i18n.t('accounts.exportSuccess', { count: exportedAccounts.length }));
    } catch (error: any) {
      this._view?.webview.postMessage({ command: 'hideLoading' });
      logger.error('Export failed', error);
      vscode.window.showErrorMessage(i18n.t('accounts.exportFailed', { error: error.message }));
    }
  }

  // ─── Import Handler ──────────────────────────────────────────────────────

  private async handleImport(): Promise<void> {
    const logger = Logger.getInstance();
    const i18n = I18nService.getInstance();
    try {
      const fileUris = await vscode.window.showOpenDialog({
        canSelectMany: false,
        filters: { 'JSON Files': ['json'] },
        title: i18n.t('accounts.selectBackup'),
      });

      if (!fileUris || fileUris.length === 0) return;

      this._view?.webview.postMessage({ command: 'showLoading', text: i18n.t('accounts.verifyingFile') });

      const fs = require('fs');
      const rawContent = fs.readFileSync(fileUris[0].fsPath, 'utf-8');

      // ── Detect format and decode ──
      let payload: ExportPayload;

      try {
        // Try parsing as JSON first (v2 encrypted envelope or raw JSON)
        const parsed = JSON.parse(rawContent);

        if (parsed._format === 'antigravity-hub-backup' && parsed._version === 2 && parsed.encrypted) {
          // ── v2 Encrypted format ──
          const password = await vscode.window.showInputBox({
            prompt: i18n.t('accounts.importPasswordPrompt'),
            password: true,
            placeHolder: i18n.t('accounts.importPasswordPlaceholder'),
          });

          if (!password) {
            this._view?.webview.postMessage({ command: 'hideLoading' });
            return; // User cancelled
          }

          try {
            const decrypted = CryptoUtils.decryptWithPassword(parsed.encrypted, password);
            payload = JSON.parse(decrypted);
          } catch {
            this._view?.webview.postMessage({ command: 'hideLoading' });
            vscode.window.showErrorMessage(i18n.t('accounts.wrongPassword'));
            return;
          }
        } else if (parsed._format === 'antigravity-hub-backup' && parsed._version === 1) {
          // ── v1 Legacy unencrypted (already parsed as JSON) ──
          vscode.window.showWarningMessage(i18n.t('accounts.legacyFormatWarning'));
          payload = parsed as ExportPayload;
          // Override version for internal consistency
          (payload as any)._version = 2;
        } else {
          throw new Error('Unknown format');
        }
      } catch (jsonError) {
        // ── Fallback: Try legacy Base64 decode (v1 oldest format) ──
        try {
          const jsonStr = Buffer.from(rawContent, 'base64').toString('utf-8');
          const legacyPayload = JSON.parse(jsonStr) as LegacyExportPayload;

          if (legacyPayload._format === 'antigravity-hub-backup' && legacyPayload._version === 1) {
            vscode.window.showWarningMessage(i18n.t('accounts.legacyFormatWarning'));
            payload = legacyPayload as unknown as ExportPayload;
          } else {
            this._view?.webview.postMessage({ command: 'hideLoading' });
            vscode.window.showErrorMessage(i18n.t('accounts.invalidFile'));
            return;
          }
        } catch {
          this._view?.webview.postMessage({ command: 'hideLoading' });
          vscode.window.showErrorMessage(i18n.t('accounts.invalidFile'));
          return;
        }
      }

      // ── Validate structure ──
      if (
        payload._format !== 'antigravity-hub-backup' ||
        !Array.isArray(payload.accounts) ||
        payload.accounts.length === 0
      ) {
        this._view?.webview.postMessage({ command: 'hideLoading' });
        vscode.window.showErrorMessage(i18n.t('accounts.noBackupData'));
        return;
      }

      // Validate each account has required fields
      for (const entry of payload.accounts) {
        if (
          !entry.email ||
          !entry.account ||
          !entry.tokens ||
          !entry.tokens.accessToken ||
          !entry.tokens.refreshToken
        ) {
          this._view?.webview.postMessage({ command: 'hideLoading' });
          vscode.window.showErrorMessage(i18n.t('accounts.incompleteAccount', { email: entry.email || i18n.t('webview.unspecified') }));
          return;
        }
      }

      this._view?.webview.postMessage({ command: 'showLoading', text: i18n.t('accounts.importingAccounts') });

      // Get existing accounts to check for duplicates
      const existingAccounts = await this.accountRepo.getAllAccounts();
      const existingEmails = new Set(existingAccounts.map(a => a.email));

      let importedCount = 0;
      let skippedCount = 0;

      for (const entry of payload.accounts) {
        if (existingEmails.has(entry.email)) {
          logger.info(`Import: Skipping ${entry.email} (already exists).`);
          skippedCount++;
          continue;
        }

        // Save the account
        await this.accountRepo.saveAccount({
          email: entry.account.email,
          name: entry.account.name,
          avatarUrl: entry.account.avatarUrl,
          projectId: entry.account.projectId,
          accessToken: entry.tokens.accessToken,
          refreshToken: entry.tokens.refreshToken,
          expiresAt: entry.tokens.expiresAt,
        });

        // Restore balances and other metadata
        await this.accountRepo.updateAccount(entry.email, {
          balances: entry.account.balances || {},
          plan: entry.account.plan,
          status: entry.account.status,
          alias: entry.account.alias,
          hasDeviceProfile: !!entry.deviceProfile,
        });

        // Restore device profile if available
        if (entry.deviceProfile) {
          await this.accountRepo.storeDeviceProfile(entry.email, entry.deviceProfile);
        }

        importedCount++;
        logger.info(`Import: Added ${entry.email}.`);
      }

      this._view?.webview.postMessage({ command: 'hideLoading' });

      // Build result message
      let msg = i18n.t('accounts.importSuccess', { count: importedCount });
      if (skippedCount > 0) {
        msg += i18n.t('accounts.importSkipped', { count: skippedCount });
      }
      vscode.window.showInformationMessage(msg);

      // Refresh UI
      this.accountService.emitAccountsChanged();
      this.refresh();

      // Silently refresh balances for imported accounts
      if (importedCount > 0) {
        logger.info('Starting silent balance refresh for imported accounts...');
        this.accountService.refreshBalancesWorkflow(false).catch(() => {});
      }

    } catch (error: any) {
      this._view?.webview.postMessage({ command: 'hideLoading' });
      logger.error('Import failed', error);
      vscode.window.showErrorMessage(i18n.t('accounts.importFailed', { error: error.message }));
    }
  }

  /**
   * Generates the dynamic HTML content with embedded CSS variables.
   */
  private async _getHtmlForWebview(webview: vscode.Webview): Promise<string> {
    const i18n = I18nService.getInstance();
    const isRtl = i18n.getLocale() === 'ar';

    // ── Not-Antigravity screen ──
    if (!this.isAntigravityEditor()) {
      const logoUri = webview.asWebviewUri(
        vscode.Uri.joinPath(this.extensionUri, 'resources', 'only_logo.png')
      );
      return `<!DOCTYPE html>
      <html lang="${isRtl ? 'ar' : 'en'}" dir="${isRtl ? 'rtl' : 'ltr'}">
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <style>
          body {
            margin: 0; padding: 24px;
            display: flex; flex-direction: column; align-items: center; justify-content: center;
            min-height: 80vh;
            font-family: var(--vscode-font-family, 'Segoe UI', sans-serif);
            color: var(--vscode-foreground);
            background: transparent;
            text-align: center;
          }
          .logo { width: 72px; height: 72px; margin-bottom: 20px; opacity: 0.85; }
          .title { font-size: 1.1rem; font-weight: 600; margin-bottom: 8px; }
          .message { font-size: 0.88rem; opacity: 0.7; line-height: 1.5; margin-bottom: 24px; max-width: 280px; }
          .download-btn {
            display: inline-flex; align-items: center; gap: 6px;
            padding: 10px 20px; border: none; border-radius: 6px;
            background: var(--vscode-button-background, #4f46e5);
            color: var(--vscode-button-foreground, #fff);
            font-size: 0.9rem; font-weight: 500; cursor: pointer;
            text-decoration: none; transition: opacity 0.2s;
          }
          .download-btn:hover { opacity: 0.85; }
        </style>
      </head>
      <body>
        <img src="${logoUri}" class="logo" alt="Antigravity">
        <div class="title">${i18n.t('webview.notAntigravityTitle')}</div>
        <div class="message">${i18n.t('webview.notAntigravityMessage')}</div>
        <a class="download-btn" href="https://antigravity.google/">
          ${i18n.t('webview.downloadAntigravity')}
        </a>
      </body>
      </html>`;
    }

    const configLanguage = vscode.workspace.getConfiguration('antigravityAccount').get<string>('language', 'auto');
    const configTheme = vscode.workspace.getConfiguration('antigravityAccount').get<string>('theme', 'dark-purple');
    const configAutoRefresh = vscode.workspace.getConfiguration('antigravityAccount').get<boolean>('autoRefreshEnabled', true);
    const configAutoRotate = vscode.workspace.getConfiguration('antigravityAccount').get<boolean>('autoRotateEnabled', false);
    const configLowCreditNotifications = vscode.workspace.getConfiguration('antigravityAccount').get<boolean>('lowCreditNotificationsEnabled', true);
    const configRefreshInterval = vscode.workspace.getConfiguration('antigravityAccount').get<number>('refreshIntervalMinutes', 15);
    const configSortBy = vscode.workspace.getConfiguration('antigravityAccount').get<string>('sortBy', 'default');
    const getSortByLabel = (val: string) => {
      switch(val) {
        case 'name-asc': return i18n.t('webview.sortNameAsc');
        case 'name-desc': return i18n.t('webview.sortNameDesc');
        case 'email-asc': return i18n.t('webview.sortEmailAsc');
        case 'email-desc': return i18n.t('webview.sortEmailDesc');
        case 'date-added': return i18n.t('webview.sortDateAdded');
        case 'quota': return i18n.t('webview.sortQuota');
        case 'quota-regen': return i18n.t('webview.sortQuotaRegen');
        case 'default':
        default: return i18n.t('webview.sortDefault');
      }
    };
    const configCacheDurationDays = vscode.workspace.getConfiguration('antigravityAccount').get<number>('cacheDurationDays', 7);
    const accounts = await this.accountRepo.getAccountSummaries();

    // ── Preferred Model Resolution ──
    // Extract available model keys from all accounts with balances (after filtering)
    // and guarantee that standard IDE models are always present in the list.
    const availableModelKeysSet = new Set<string>([
      'Sonnet 4.6',
      'Opus 4.6',
      '3.7 Flash',
      '3.1 Pro (Low)',
      '3.1 Pro (High)',
      '3.5 Flash (Med)',
      '3.5 Flash (High)',
      'GPT-OSS 120B'
    ]);

    accounts.forEach(a => {
      if (a.balances) {
        this.extractFilteredModelKeys(a.balances).forEach(k => availableModelKeysSet.add(k));
      }
    });

    const availableModelKeys = Array.from(availableModelKeysSet);

    // ── Use the cached pinned active account (set by detectAndPinActiveAccount) ──
    // This does NOT re-read from state.vscdb; it uses the result of the last
    // independent verification process, ensuring the pinned account survives
    // post-refresh re-sorting.
    const pinnedEmailLower = this._pinnedActiveEmail;
    
    // Set isActive flag based on the pinned email
    accounts.forEach(acc => {
      acc.isActive = (pinnedEmailLower !== null && acc.email.toLowerCase() === pinnedEmailLower);
    });

    // Read stored preference (null = never set, "" = explicitly none)
    let preferredModel = await this.accountRepo.getPreferredModel();

    // Normalize legacy names or raw model IDs to the new shortened names
    if (preferredModel) {
      const normalized = normalizeModelKey(preferredModel);
      if (normalized && normalized !== preferredModel) {
        preferredModel = normalized;
        await this.accountRepo.setPreferredModel(normalized); // Migrate in storage
      }
    }

    if (preferredModel === null && availableModelKeys.length > 0) {
      // Auto-detect: find newest Claude model
      preferredModel = this.findNewestClaudeKey(availableModelKeys) || '';
      await this.accountRepo.setPreferredModel(preferredModel);
    }
    const effectivePreferred = preferredModel ? normalizeModelKey(preferredModel) : '';

    // Count accounts with quota > 0
    let withQuotaCount = 0;
    for (const acc of accounts) {
      if (acc.status === AccountStatus.ACTIVE || acc.status === AccountStatus.LOW_BALANCE) {
        let hasQ = false;
        if (acc.balances) {
          for (const rawV of Object.values(acc.balances)) {
            if (typeof rawV === 'object' && rawV !== null && 'value' in rawV) {
              if (Number((rawV as any).value) > 0) {
                hasQ = true;
                break;
              }
            } else if (typeof rawV === 'number' && rawV > 0) {
              hasQ = true;
              break;
            }
          }
        }
        if (hasQ) withQuotaCount++;
      }
    }

    // ── Set active state and sort accounts ──
    accounts.forEach(acc => {
      acc.isActive = (this._pinnedActiveEmail !== null && acc.email.toLowerCase() === this._pinnedActiveEmail);
    });
    this.sortAccounts(accounts, effectivePreferred, this._pinnedActiveEmail);

    const formatTime = (resetTimeStr?: string) => {
       if (!resetTimeStr) return i18n.t('webview.unspecified');
       const date = new Date(resetTimeStr);
       const diffMs = date.getTime() - Date.now();
       if (diffMs <= 0) return i18n.t('webview.availableNow');
       
       const totalHours = Math.floor(diffMs / (1000 * 60 * 60));
       const mins = Math.floor((diffMs % (1000 * 60 * 60)) / (1000 * 60));
       
       if (totalHours >= 24) {
         const days = Math.floor(totalHours / 24);
         const remainingHours = totalHours % 24;
         if (remainingHours === 0) {
           return i18n.t('webview.renewsInDaysMins', { days, mins });
         }
         return i18n.t('webview.renewsInDaysHoursMins', { days, hours: remainingHours, mins });
       }
       
       return i18n.t('webview.renewsInHoursMins', { hours: totalHours, mins });
    };

    // Generate HTML for each account card
    const accountCardsHtml = accounts.length > 0 ? accounts.map(acc => {
      return this.renderAccountCard(acc, effectivePreferred);
    }).join('') : `
      <div class="empty-state">
        <div class="empty-state-svg">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="width:64px; height:64px; color:var(--text-secondary);"><line x1="22" y1="12" x2="2" y2="12"/><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/><polyline points="14 12 14 14 10 14 10 12"/></svg>
        </div>
        <p>${i18n.t('accounts.noAccountsRegistered')}</p>
        <button class="btn btn-primary main-btn" onclick="sendMessage('addAccount')">${i18n.t('accounts.addNewAccount')}</button>
      </div>
    `;

    return `
      <!DOCTYPE html>
      <html lang="${isRtl ? 'ar' : 'en'}" dir="${isRtl ? 'rtl' : 'ltr'}" data-theme="${configTheme}">
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Antigravity Accounts</title>
        <style>
          /* ── Default: Dark Purple (Original Antigravity Theme) ── */
          :root,
          [data-theme="dark-purple"],
          .theme-dark-purple {
            --background-dark: #0c0a17;
            --surface-color: #161327;
            --surface-light: #211c3b;
            --surface-subtle: #110e20;
            
            --primary-color: #7c3aed;
            --primary-dark: #6d28d9;
            --primary-light: #a78bfa;
            --secondary-color: #262042;
            
            --text-primary: #f9fafb;
            --text-secondary: #9ca3af;
            --text-muted: #6b7280;
            
            --border-color: rgba(139, 92, 246, 0.18);
            --focus-border: #8b5cf6;
            
            --danger-color: #ef4444;
            --success-color: #10b981;
            --warning-color: #f59e0b;
            
            --glass-bg: #161327;
            --glass-border: rgba(139, 92, 246, 0.22);
            --shadow-color: rgba(0, 0, 0, 0.45);
            --hover-bg: #1f1a38;
            
            --active-glow: 0 0 16px rgba(139, 92, 246, 0.35);
            --primary-gradient: linear-gradient(135deg, #7c3aed, #4f46e5);
            --primary-gradient-hover: linear-gradient(135deg, #8b5cf6, #6366f1);
            --danger-gradient: linear-gradient(135deg, #ef4444, #b91c1c);
            --warning-gradient: linear-gradient(135deg, #f59e0b, #b45309);
          }

          [data-theme="midnight"],
          .theme-midnight {
            --background-dark: #050608;
            --surface-color: #0d0f14;
            --surface-light: #141720;
            --surface-subtle: #08090d;
            
            --primary-color: #0284c7;
            --primary-dark: #0369a1;
            --primary-light: #38bdf8;
            --secondary-color: #161b24;
            
            --text-primary: #f8fafc;
            --text-secondary: #94a3b8;
            --text-muted: #64748b;
            
            --border-color: rgba(255, 255, 255, 0.08);
            --focus-border: #38bdf8;
            
            --danger-color: #f43f5e;
            --success-color: #10b981;
            --warning-color: #fbbf24;
            
            --glass-bg: #0d0f14;
            --glass-border: rgba(255, 255, 255, 0.1);
            --shadow-color: rgba(0, 0, 0, 0.6);
            --hover-bg: #141720;
            
            --active-glow: 0 0 16px rgba(56, 189, 248, 0.25);
            --primary-gradient: linear-gradient(135deg, #0284c7, #6366f1);
            --primary-gradient-hover: linear-gradient(135deg, #38bdf8, #818cf8);
            --danger-gradient: linear-gradient(135deg, #f43f5e, #be123c);
            --warning-gradient: linear-gradient(135deg, #f59e0b, #b45309);
          }

          [data-theme="deep-blue"],
          .theme-deep-blue {
            --background-dark: #050b18;
            --surface-color: #0a1326;
            --surface-light: #111f3d;
            --surface-subtle: #070e1c;
            
            --primary-color: #2563eb;
            --primary-dark: #1d4ed8;
            --primary-light: #60a5fa;
            --secondary-color: #152344;
            
            --text-primary: #f0f9ff;
            --text-secondary: #94a3b8;
            --text-muted: #64748b;
            
            --border-color: rgba(96, 165, 250, 0.18);
            --focus-border: #60a5fa;
            
            --danger-color: #ef4444;
            --success-color: #10b981;
            --warning-color: #f59e0b;
            
            --glass-bg: #0a1326;
            --glass-border: rgba(96, 165, 250, 0.2);
            --shadow-color: rgba(0, 0, 0, 0.5);
            --hover-bg: #111f3d;
            
            --active-glow: 0 0 18px rgba(96, 165, 250, 0.3);
            --primary-gradient: linear-gradient(135deg, #2563eb, #0284c7);
            --primary-gradient-hover: linear-gradient(135deg, #3b82f6, #38bdf8);
            --danger-gradient: linear-gradient(135deg, #ef4444, #b91c1c);
            --warning-gradient: linear-gradient(135deg, #f59e0b, #b45309);
          }

          [data-theme="vscode"],
          .theme-vscode {
            --background-dark: transparent;
            --surface-color: var(--vscode-sideBarSectionHeader-background, var(--vscode-editor-background, rgba(128, 128, 128, 0.05)));
            --surface-light: var(--vscode-list-hoverBackground, rgba(128, 128, 128, 0.09));
            --surface-subtle: var(--vscode-input-background, rgba(128, 128, 128, 0.06));
            
            --primary-color: var(--vscode-button-background, #007acc);
            --primary-dark: var(--vscode-button-hoverBackground, #0062a3);
            --primary-light: var(--vscode-textLink-foreground, var(--vscode-focusBorder, #3b82f6));
            --secondary-color: var(--vscode-button-secondaryBackground, rgba(128, 128, 128, 0.14));
            
            --text-primary: var(--vscode-foreground, var(--vscode-editor-foreground, #e5e7eb));
            --text-secondary: var(--vscode-descriptionForeground, #9ca3af);
            --text-muted: var(--vscode-disabledForeground, rgba(128, 128, 128, 0.55));
            
            --border-color: var(--vscode-widget-border, var(--vscode-panel-border, var(--vscode-sideBar-border, rgba(128, 128, 128, 0.18))));
            --focus-border: var(--vscode-focusBorder, var(--vscode-button-background, #007acc));
            
            --danger-color: var(--vscode-errorForeground, var(--vscode-charts-red, #ef4444));
            --success-color: var(--vscode-testing-iconPassed, var(--vscode-charts-green, #10b981));
            --warning-color: var(--vscode-editorWarning-foreground, var(--vscode-charts-yellow, #f59e0b));
            
            --glass-bg: var(--surface-color);
            --glass-border: var(--border-color);
            --shadow-color: var(--vscode-widget-shadow, rgba(0, 0, 0, 0.18));
            --hover-bg: var(--surface-light);
            
            --active-glow: 0 0 14px rgba(124, 58, 237, 0.22);
            --primary-gradient: linear-gradient(135deg, var(--vscode-button-background, #007acc), var(--vscode-textLink-foreground, #3b82f6));
            --primary-gradient-hover: linear-gradient(135deg, var(--vscode-button-hoverBackground, #0062a3), var(--vscode-textLink-activeForeground, #60a5fa));
            --danger-gradient: linear-gradient(135deg, #ef4444, #b91c1c);
            --warning-gradient: linear-gradient(135deg, #f59e0b, #b45309);
          }

          /* Modern Scrollbar Styling */
          ::-webkit-scrollbar {
            width: 6px;
            height: 6px;
          }
          ::-webkit-scrollbar-track {
            background: transparent;
          }
          ::-webkit-scrollbar-thumb {
            background: var(--vscode-scrollbarSlider-background, rgba(128, 128, 128, 0.25));
            border-radius: 4px;
          }
          ::-webkit-scrollbar-thumb:hover {
            background: var(--vscode-scrollbarSlider-hoverBackground, rgba(128, 128, 128, 0.45));
          }

          body {
            padding: 12px;
            background-color: var(--background-dark);
            color: var(--text-primary);
            font-family: var(--vscode-font-family, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif);
            font-size: 13px;
            line-height: 1.4;
            margin: 0;
            container-type: inline-size;
            box-sizing: border-box;
            transition: background-color 0.2s ease, color 0.2s ease;
          }

          *, *::before, *::after {
            box-sizing: border-box;
          }
          
          .header-actions {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 14px;
            padding-bottom: 10px;
            border-bottom: 1px solid var(--border-color);
          }

          .header-actions h2 { 
            margin: 0; 
            font-size: 1.05rem; 
            color: var(--text-primary); 
            font-weight: 700;
            letter-spacing: -0.01em;
          }

          .quota-count-badge {
            display: inline-flex;
            align-items: center;
            gap: 5px;
            font-size: 0.72rem;
            font-weight: 600;
            padding: 2px 8px;
            border-radius: 12px;
            letter-spacing: 0.02em;
          }
          .quota-count-badge.has-quota {
            background: rgba(16, 185, 129, 0.12);
            color: var(--success-color);
            border: 1px solid rgba(16, 185, 129, 0.25);
          }
          .quota-count-badge.has-quota .quota-count-dot {
            width: 6px;
            height: 6px;
            border-radius: 50%;
            background-color: var(--success-color);
            box-shadow: 0 0 6px var(--success-color);
          }
          .quota-count-badge.no-quota {
            background: rgba(245, 158, 11, 0.12);
            color: var(--warning-color);
            border: 1px solid rgba(245, 158, 11, 0.25);
          }
          .quota-count-badge.no-quota .quota-count-dot {
            width: 6px;
            height: 6px;
            border-radius: 50%;
            background-color: var(--warning-color);
          }
          
          .btn-icon {
            background: var(--surface-light);
            border: 1px solid var(--border-color);
            color: var(--text-primary);
            cursor: pointer;
            padding: 6px 10px;
            border-radius: 6px;
            transition: all 0.15s cubic-bezier(0.16, 1, 0.3, 1);
            display: inline-flex;
            align-items: center;
            justify-content: center;
            font-size: 0.9rem;
            margin-inline-start: 4px;
          }
          .btn-icon:hover {
            background: var(--primary-color);
            color: var(--vscode-button-foreground, #ffffff);
            border-color: var(--primary-color);
            transform: translateY(-1px);
            box-shadow: 0 2px 8px rgba(0, 0, 0, 0.15);
          }
          .btn-icon:active {
            transform: translateY(0);
          }

          .account-card {
            content-visibility: auto;
            contain-intrinsic-size: auto 140px;
            background: var(--surface-color);
            border: 1px solid var(--border-color);
            border-radius: 12px;
            padding: 14px;
            margin-bottom: 12px;
            transition: transform 0.15s ease, box-shadow 0.15s ease, border-color 0.15s ease;
            position: relative;
            box-shadow: 0 2px 6px var(--shadow-color);
          }

          .account-card:hover {
            transform: translateY(-1.5px);
            box-shadow: 0 6px 16px var(--shadow-color);
            border-color: var(--focus-border);
          }

          .account-card.active {
            border: 1.5px solid var(--focus-border);
            box-shadow: var(--active-glow), 0 3px 10px var(--shadow-color);
            background: var(--surface-color);
          }

          .account-card.refreshing {
            border-color: var(--primary-light) !important;
            box-shadow: 0 0 12px rgba(124, 58, 237, 0.2), 0 2px 6px var(--shadow-color);
            opacity: 0.88;
            animation: cardRefreshPulse 2s infinite ease-in-out;
          }
          @keyframes cardRefreshPulse {
            0%, 100% { opacity: 0.75; }
            50% { opacity: 0.98; }
          }

          .btn-card-refresh {
            background: none;
            border: none;
            color: var(--text-secondary);
            cursor: pointer;
            padding: 2px 4px;
            border-radius: 4px;
            display: inline-flex;
            align-items: center;
            justify-content: center;
            transition: all 0.2s cubic-bezier(0.16, 1, 0.3, 1);
            opacity: 0.7;
          }
          .btn-card-refresh:hover {
            color: var(--primary-light);
            background: var(--surface-light);
            opacity: 1;
            transform: rotate(45deg);
          }
          .btn-card-refresh .icon-svg {
            width: 12px;
            height: 12px;
          }
          .account-card.refreshing .btn-card-refresh {
            animation: spin 1s linear infinite;
            pointer-events: none;
            opacity: 1;
          }

          /* ── Toolbar ── */
          .toolbar-container {
            display: flex;
            gap: 8px;
            margin-bottom: 14px;
          }
          .toolbar-sort, .toolbar-scan {
            position: relative;
            flex: 1;
            display: flex;
            align-items: center;
            gap: 4px;
            background: var(--surface-subtle);
            border: 1px solid var(--border-color);
            border-radius: 8px;
            padding: 6px 10px;
            box-sizing: border-box;
            transition: all 0.15s cubic-bezier(0.16, 1, 0.3, 1);
            user-select: none;
            -webkit-user-select: none;
            cursor: pointer;
          }
          .toolbar-sort:hover, .toolbar-scan:hover {
            border-color: var(--focus-border);
            background: var(--surface-light);
          }
          .toolbar-sort select, .toolbar-scan select {
            position: absolute;
            top: 0;
            left: 0;
            width: 100%;
            height: 100%;
            opacity: 0;
            cursor: pointer;
            -webkit-appearance: none;
            appearance: none;
          }
          .toolbar-sort select option, .toolbar-scan select option {
            background: var(--vscode-dropdown-background, var(--vscode-editor-background));
            color: var(--vscode-dropdown-foreground, var(--text-primary));
          }
          .toolbar-label {
            font-size: 0.72rem;
            color: var(--text-secondary);
            white-space: nowrap;
            font-weight: 600;
            text-transform: uppercase;
            letter-spacing: 0.5px;
            user-select: none;
            -webkit-user-select: none;
            pointer-events: none;
          }

          .card-header {
            display: flex;
            align-items: flex-start;
            gap: 12px;
            margin-bottom: 12px;
            min-width: 0;
          }

          .avatar {
            width: 38px;
            height: 38px;
            border-radius: 10px;
            background: var(--primary-gradient);
            display: flex;
            align-items: center;
            justify-content: center;
            font-weight: 700;
            font-size: 1.1rem;
            color: white;
            box-shadow: 0 2px 6px rgba(0, 0, 0, 0.15);
            object-fit: cover;
            border: 1px solid var(--border-color);
            flex-shrink: 0;
          }

          .user-info { flex: 1; overflow: hidden; min-width: 0; }
          .user-info h4 { 
            margin: 0 0 2px 0; 
            font-size: 0.94rem; 
            font-weight: 600;
            white-space: nowrap; 
            overflow: hidden; 
            text-overflow: ellipsis;
            color: var(--text-primary);
          }
          .user-info p { 
            margin: 0; 
            font-size: 0.78rem; 
            color: var(--text-secondary); 
            white-space: nowrap; 
            overflow: hidden; 
            text-overflow: ellipsis;
          }

          .badge {
            font-size: 0.68rem;
            padding: 3px 8px;
            border-radius: 12px;
            font-weight: 600;
            text-transform: uppercase;
            letter-spacing: 0.04em;
            flex-shrink: 0;
          }
          
          .active-badge {
            background: rgba(16, 185, 129, 0.12);
            color: var(--success-color);
            border: 1px solid rgba(16, 185, 129, 0.3);
            box-shadow: 0 0 8px rgba(16, 185, 129, 0.15);
            position: relative;
            padding-inline-start: 18px;
          }
          
          .active-badge::before {
            content: '';
            position: absolute;
            left: 6px;
            top: 50%;
            transform: translateY(-50%);
            width: 5px;
            height: 5px;
            border-radius: 50%;
            background: var(--success-color);
            box-shadow: 0 0 6px var(--success-color);
            animation: badgePulse 2s infinite;
          }
          [dir="rtl"] .active-badge {
            padding-inline-start: 8px;
            padding-inline-end: 18px;
          }
          [dir="rtl"] .active-badge::before {
            left: auto;
            right: 6px;
          }

          @keyframes badgePulse {
            0% { transform: translateY(-50%) scale(0.9); opacity: 0.6; }
            50% { transform: translateY(-50%) scale(1.2); opacity: 1; }
            100% { transform: translateY(-50%) scale(0.9); opacity: 0.6; }
          }

          .balances-container {
            display: flex;
            flex-wrap: wrap;
            gap: 6px;
            margin-bottom: 12px;
            padding: 10px;
            background: var(--surface-subtle);
            border-radius: 8px;
            border: 1px solid var(--border-color);
          }

          .balance-badge {
            display: flex;
            flex-direction: column;
            background: var(--surface-color);
            padding: 6px 8px;
            border-radius: 6px;
            flex: 1;
            min-width: 70px;
            text-align: center;
            border: 1px solid var(--border-color);
          }

          .balance-name { 
            font-size: 0.65rem; 
            color: var(--text-secondary); 
            margin-bottom: 2px; 
            text-transform: uppercase; 
            letter-spacing: 0.5px;
            font-weight: 600;
          }
          .balance-value { 
            font-size: 1.05rem; 
            font-weight: 700; 
            color: var(--primary-light); 
          }

          .card-actions {
            display: flex;
            gap: 8px;
            justify-content: flex-end;
            margin-top: 12px;
            padding-top: 10px;
            border-top: 1px solid var(--border-color);
          }

          .credits-container {
            display: flex;
            margin-bottom: 12px;
            padding: 10px;
            background: var(--surface-subtle);
            border-radius: 8px;
            border: 1px solid var(--border-color);
          }

          .credit-badge {
            display: flex;
            justify-content: space-between;
            align-items: center;
            width: 100%;
          }

          .credit-name {
            font-size: 0.78rem;
            color: var(--text-secondary);
            font-weight: 600;
            letter-spacing: 0.02em;
          }

          .credit-value {
            font-size: 1.1rem;
            color: var(--primary-light);
            font-weight: 800;
            letter-spacing: -0.01em;
          }

          .models-section {
            margin-bottom: 10px;
          }

          .collapse-header {
            display: flex;
            align-items: center;
            justify-content: space-between;
            background: var(--surface-subtle);
            border: 1px solid var(--border-color);
            border-radius: 8px;
            cursor: pointer;
            user-select: none;
            transition: all 0.15s cubic-bezier(0.16, 1, 0.3, 1);
            min-width: 0;
            gap: 6px;
          }
          
          .normal-collapse {
            padding: 8px 12px;
          }
          
          .normal-collapse:hover {
            background: var(--hover-bg);
            border-color: var(--focus-border);
          }

          .collapse-title {
            font-size: 0.8rem;
            font-weight: 600;
            color: var(--text-primary);
            white-space: nowrap;
            flex-shrink: 0;
          }

          .unified-collapse {
            padding: 6px 10px;
          }
          
          .unified-collapse:hover {
            background: var(--hover-bg);
            border-color: var(--focus-border);
          }
          
          .collapse-header-right {
            display: flex;
            align-items: center;
            gap: 6px;
            min-width: 0;
            flex-shrink: 1;
            overflow: hidden;
          }

          .pref-badge {
            display: flex;
            align-items: center;
            gap: 6px;
            background: var(--surface-color);
            padding: 3px 8px;
            border-radius: 6px;
            border: 1px solid var(--border-color);
            font-size: 0.72rem;
            transition: all 0.15s cubic-bezier(0.16, 1, 0.3, 1);
            cursor: pointer;
            min-width: 0;
            flex-shrink: 1;
            overflow: hidden;
          }

          .pref-badge:hover {
            background: var(--hover-bg);
            border-color: var(--focus-border);
          }

          .pref-badge.active-model {
            background: var(--primary-gradient);
            color: white;
            border-color: transparent;
            box-shadow: 0 2px 6px rgba(0, 0, 0, 0.2);
          }

          .pref-badge-name {
            font-weight: 600;
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
            color: inherit;
            min-width: 0;
            flex-shrink: 1;
          }

          .pref-badge-bar {
            width: 34px;
            min-width: 20px;
            height: 4px;
            background: rgba(128, 128, 128, 0.2);
            border-radius: 2px;
            overflow: hidden;
            flex-shrink: 1;
          }

          .pref-badge-val {
            font-weight: 700;
            white-space: nowrap;
            flex-shrink: 0;
            color: inherit;
          }

          .collapse-icon {
            font-size: 0.75rem;
            color: var(--text-secondary);
            transition: transform 0.2s cubic-bezier(0.16, 1, 0.3, 1);
            margin-inline-end: 2px;
          }
          
          .collapse-header.expanded .collapse-icon {
            transform: rotate(180deg);
          }

          .icon-svg {
            width: 14px;
            height: 14px;
            display: inline-block;
            vertical-align: middle;
            stroke-width: 2.2px;
          }
          .btn-icon .icon-svg {
            width: 15px;
            height: 15px;
          }
          .chevron-svg {
            width: 12px;
            height: 12px;
            color: var(--text-secondary);
            transition: transform 0.2s cubic-bezier(0.16, 1, 0.3, 1);
            margin-inline-end: 2px;
            vertical-align: middle;
          }
          .collapse-header.expanded .chevron-svg {
            transform: rotate(180deg);
          }
          .icon-warning {
            color: var(--warning-color);
            margin-inline-start: 4px;
          }
          .icon-error {
            color: var(--danger-color);
          }
          .icon-image {
            margin-inline-start: 4px;
            opacity: 0.8;
          }
          .empty-state-svg {
            color: var(--text-secondary);
            opacity: 0.5;
            margin-bottom: 14px;
            animation: floatAnimation 4s ease-in-out infinite;
          }
          @keyframes floatAnimation {
            0%, 100% { transform: translateY(0); }
            50% { transform: translateY(-4px); }
          }

          .collapsible-wrapper {
            display: grid;
            grid-template-rows: 0fr;
            transition: grid-template-rows 0.25s cubic-bezier(0.16, 1, 0.3, 1);
          }

          .collapsible-wrapper.expanded {
            grid-template-rows: 1fr;
          }

          .collapsible-inner {
            overflow: hidden;
          }

          .models-container {
            display: flex;
            flex-direction: column;
            gap: 6px;
            padding-top: 8px;
          }

          .model-card {
            background: var(--surface-subtle);
            padding: 8px 10px;
            border-radius: 8px;
            border: 1px solid var(--border-color);
            display: flex;
            flex-direction: column;
            transition: all 0.15s cubic-bezier(0.16, 1, 0.3, 1);
          }

          .model-card.active-model {
            border-color: var(--focus-border);
            background: var(--surface-light);
            box-shadow: 0 0 8px rgba(0, 0, 0, 0.12);
          }

          .model-card:hover {
            background: var(--surface-light);
            border-color: var(--focus-border);
            transform: translateX(2px);
          }
          [dir="rtl"] .model-card:hover {
            transform: translateX(-2px);
          }

          .model-header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 5px;
            gap: 6px;
            min-width: 0;
          }

          .model-name {
            font-size: 0.8rem;
            font-weight: 600;
            color: var(--text-primary);
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
            min-width: 0;
            flex-shrink: 1;
          }

          .model-reset {
            font-size: 0.68rem;
            color: var(--text-secondary);
            white-space: nowrap;
            flex-shrink: 0;
          }

          .progress-bar-container {
            width: 100%;
            height: 6px;
            background: rgba(128, 128, 128, 0.18);
            border-radius: 3px;
            overflow: hidden;
            margin-bottom: 3px;
            box-shadow: inset 0 1px 2px rgba(0, 0, 0, 0.1);
          }

          .progress-bar {
            height: 100%;
            border-radius: 3px;
            transition: width 0.4s cubic-bezier(0.4, 0, 0.2, 1);
            position: relative;
            overflow: hidden;
          }

          /* Subtle shimmer animation */
          .progress-bar::after {
            content: '';
            position: absolute;
            top: 0; left: 0; right: 0; bottom: 0;
            background: linear-gradient(
              90deg,
              rgba(255, 255, 255, 0) 0%,
              rgba(255, 255, 255, 0.18) 50%,
              rgba(255, 255, 255, 0) 100%
            );
            transform: translateX(-100%);
            animation: shimmer-effect 2.5s infinite;
          }

          @keyframes shimmer-effect {
            100% {
              transform: translateX(100%);
            }
          }

          .bg-high {
            background: linear-gradient(90deg, #10b981, #059669);
          }
          .bg-med {
            background: linear-gradient(90deg, #f59e0b, #d97706);
          }
          .bg-low {
            background: linear-gradient(90deg, #ef4444, #dc2626);
          }
          
          .bg-high-text { color: var(--success-color); font-weight: 600; }
          .bg-med-text { color: var(--warning-color); font-weight: 600; }
          .bg-low-text { color: var(--danger-color); font-weight: 600; }

          .model-percentage {
            font-size: 0.72rem;
            align-self: flex-end;
            font-weight: 700;
          }

          .empty-models {
            font-size: 0.78rem;
            color: var(--text-secondary);
            text-align: center;
            padding: 10px;
          }

          .btn {
            padding: 6px 14px;
            border-radius: 6px;
            font-size: 0.8rem;
            cursor: pointer;
            font-weight: 500;
            transition: all 0.15s cubic-bezier(0.16, 1, 0.3, 1);
            border: 1px solid transparent;
            color: var(--vscode-button-foreground, #ffffff);
            display: inline-flex;
            align-items: center;
            justify-content: center;
            gap: 5px;
          }
          .btn:active {
            transform: scale(0.98);
          }

          .btn-primary {
            background: var(--primary-color);
            color: var(--vscode-button-foreground, #ffffff);
          }
          .btn-primary:hover { 
            background: var(--primary-dark); 
          }

          .btn-danger {
            background: rgba(239, 68, 68, 0.08);
            color: var(--danger-color);
            border: 1px solid rgba(239, 68, 68, 0.2);
          }
          .btn-danger:hover {
            background: #ef4444;
            color: white;
            border-color: transparent;
            box-shadow: 0 2px 8px rgba(239, 68, 68, 0.25);
          }

          .btn-warning {
            background: rgba(245, 158, 11, 0.12);
            color: var(--warning-color);
            border: 1px solid rgba(245, 158, 11, 0.25);
          }
          .btn-warning:hover {
            background: #f59e0b;
            color: #000;
            border-color: transparent;
            box-shadow: 0 2px 8px rgba(245, 158, 11, 0.25);
          }

          .account-card.expired {
            border: 1px dashed var(--warning-color);
            opacity: 0.92;
          }
          .account-card.expired:hover {
            border-color: var(--warning-color);
          }

          .account-card.ineligible {
            border: 1px dashed var(--danger-color);
            opacity: 0.95;
          }
          .account-card.ineligible:hover {
            border-color: var(--danger-color);
          }

          .avatar-expired {
            opacity: 0.5;
            filter: grayscale(80%);
          }

          .avatar-ineligible {
            opacity: 0.5;
            filter: grayscale(100%);
          }

          .expired-badge {
            background: rgba(245, 158, 11, 0.12);
            color: var(--warning-color);
            border: 1px solid rgba(245, 158, 11, 0.25);
            white-space: nowrap;
          }

          .ineligible-badge {
            background: rgba(239, 68, 68, 0.12);
            color: var(--danger-color);
            border: 1px solid rgba(239, 68, 68, 0.25);
            white-space: nowrap;
          }

          .expired-banner {
            display: flex;
            align-items: center;
            gap: 8px;
            padding: 8px 10px;
            margin-bottom: 12px;
            background: rgba(245, 158, 11, 0.06);
            border: 1px solid rgba(245, 158, 11, 0.2);
            border-radius: 6px;
            animation: subtlePulse 3s ease-in-out infinite;
          }
          .expired-banner-icon {
            font-size: 1.1rem;
            flex-shrink: 0;
          }
          .expired-banner-text {
            font-size: 0.76rem;
            color: var(--warning-color);
            line-height: 1.4;
            font-weight: 500;
          }

          .ineligible-banner {
            display: flex;
            align-items: center;
            gap: 8px;
            padding: 8px 10px;
            margin-bottom: 12px;
            background: rgba(239, 68, 68, 0.06);
            border: 1px solid rgba(239, 68, 68, 0.2);
            border-radius: 6px;
            animation: redSubtlePulse 3s ease-in-out infinite;
          }
          .ineligible-banner-icon {
            font-size: 1.1rem;
            flex-shrink: 0;
          }
          .ineligible-banner-text {
            font-size: 0.76rem;
            color: var(--danger-color);
            line-height: 1.4;
            font-weight: 500;
          }

          @keyframes subtlePulse {
            0%, 100% { border-color: rgba(245, 158, 11, 0.2); }
            50% { border-color: rgba(245, 158, 11, 0.45); }
          }

          @keyframes redSubtlePulse {
            0%, 100% { border-color: rgba(239, 68, 68, 0.2); }
            50% { border-color: rgba(239, 68, 68, 0.45); }
          }

          .empty-state {
            text-align: center;
            padding: 36px 16px;
            color: var(--text-secondary);
            background: var(--surface-color);
            border-radius: 10px;
            border: 1px dashed var(--border-color);
          }
          .empty-icon { font-size: 2.8rem; margin-bottom: 12px; opacity: 0.6; }
          .main-btn { margin-top: 14px; padding: 8px 20px; font-size: 0.9rem; width: 100%;}

          /* ── Responsive: Container Queries for narrow sidebar ── */
          @container (max-width: 340px) {
            .toolbar-container { gap: 4px; }
            .toolbar-sort, .toolbar-scan { padding: 5px 6px; }
            .toolbar-label-prefix { display: none; }
            .scan-text-long { display: none !important; }
            .scan-text-short { display: inline !important; }
            .toolbar-value { font-size: 0.72rem !important; }
            .toolbar-label { font-size: 0.72rem; }
          }

          @container (max-width: 280px) {
            body { padding: 8px; }
            .account-card { padding: 10px; }
            .card-header { gap: 8px; }
            .avatar { width: 32px; height: 32px; font-size: 0.95rem; }
            .user-info h4 { font-size: 0.85rem; }
            .user-info p { font-size: 0.7rem; }
            .collapse-header { padding: 6px 8px; }
            .collapse-title { font-size: 0.76rem; }
            .pref-badge { gap: 4px; padding: 2px 5px; font-size: 0.68rem; }
            .pref-badge-bar { display: none; }
            .model-card { padding: 6px 8px; }
            .model-name { font-size: 0.76rem; }
            .model-reset { font-size: 0.65rem; }
            .model-percentage { font-size: 0.68rem; }
            .btn { padding: 5px 8px; font-size: 0.74rem; }
            .header-actions h2 { font-size: 0.92rem; }
            .btn-icon { padding: 5px 7px; font-size: 0.78rem; }
          }

          @container (max-width: 220px) {
            .pref-badge-name { max-width: 38px; }
            .collapse-title { font-size: 0.7rem; }
            .avatar { width: 26px; height: 26px; font-size: 0.8rem; border-radius: 6px; }
            .card-header { gap: 6px; }
            .badge { font-size: 0.58rem; padding: 2px 5px; }
          }

          /* ── Search ── */
          .search-container {
            position: relative;
            margin-bottom: 12px;
          }
          .search-input {
            width: 100%;
            padding: 7px 30px 7px 10px;
            background: var(--vscode-input-background, rgba(128, 128, 128, 0.08));
            border: 1px solid var(--vscode-input-border, var(--border-color));
            border-radius: 6px;
            color: var(--vscode-input-foreground, var(--text-primary));
            font-size: 0.82rem;
            font-family: inherit;
            outline: none;
            transition: border-color 0.15s ease, box-shadow 0.15s ease;
            box-sizing: border-box;
          }
          [dir="rtl"] .search-input {
            padding: 7px 10px 7px 30px;
          }
          .search-input:focus {
            border-color: var(--focus-border);
            box-shadow: 0 0 6px rgba(0, 0, 0, 0.15);
          }
          .search-input::placeholder {
            color: var(--vscode-input-placeholderForeground, var(--text-secondary));
            opacity: 0.75;
          }
          .search-input:disabled {
            opacity: 0.4;
            cursor: not-allowed;
          }
          .search-clear-btn {
            position: absolute;
            top: 50%;
            right: 6px;
            transform: translateY(-50%);
            background: none;
            border: none;
            color: var(--text-secondary);
            cursor: pointer;
            font-size: 0.82rem;
            padding: 2px 5px;
            border-radius: 4px;
            transition: all 0.15s;
            line-height: 1;
            display: none;
          }
          [dir="rtl"] .search-clear-btn {
            right: auto;
            left: 6px;
          }
          .search-clear-btn:hover {
            color: var(--text-primary);
            background: var(--surface-light);
          }
          .search-no-results {
            text-align: center;
            padding: 28px 16px;
            color: var(--text-secondary);
            display: none;
          }
          .search-no-results-icon {
            font-size: 1.8rem;
            margin-bottom: 8px;
            opacity: 0.45;
          }
          .search-no-results p {
            font-size: 0.82rem;
            margin: 0;
          }

          .account-card.search-hidden {
            display: none !important;
          }

          /* ── Top progress banner for refresh ── */
          .refresh-progress-banner {
            display: none;
            flex-direction: column;
            gap: 6px;
            padding: 10px 12px;
            margin-bottom: 14px;
            background: var(--surface-subtle);
            border: 1px solid var(--focus-border);
            border-radius: 8px;
            animation: fadeIn 0.2s ease;
            position: relative;
          }
          .refresh-progress-banner.visible {
            display: flex;
          }
          .refresh-progress-info {
            display: flex;
            justify-content: space-between;
            align-items: center;
            gap: 10px;
            min-width: 0;
          }
          .refresh-progress-stats {
            display: flex;
            align-items: center;
            gap: 8px;
            flex-shrink: 0;
          }
          .refresh-progress-count {
            font-size: 0.72rem;
            color: var(--text-secondary);
            font-weight: 600;
            background: var(--surface-color);
            padding: 2px 6px;
            border-radius: 4px;
            border: 1px solid var(--border-color);
            white-space: nowrap;
          }
          .refresh-progress-email {
            font-size: 0.8rem;
            color: var(--primary-light);
            font-weight: 500;
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
            min-width: 0;
            flex-shrink: 1;
          }
          .refresh-progress-email .refresh-label {
            color: var(--text-secondary);
            font-weight: 400;
          }
          .refresh-progress-percent {
            font-size: 0.8rem;
            font-weight: 700;
            color: var(--primary-light);
            flex-shrink: 0;
          }
          .refresh-progress-bar-track {
            width: 100%;
            height: 5px;
            background: rgba(128, 128, 128, 0.15);
            border-radius: 3px;
            overflow: hidden;
          }
          .refresh-progress-bar-fill {
            height: 100%;
            border-radius: 3px;
            background: var(--primary-color);
            transition: width 0.35s cubic-bezier(0.16, 1, 0.3, 1);
            width: 0%;
          }

          /* Toast notification */
          .refresh-toast {
            display: none;
            padding: 8px 12px;
            margin-bottom: 12px;
            background: rgba(16, 185, 129, 0.1);
            border: 1px solid var(--success-color);
            border-radius: 8px;
            font-size: 0.8rem;
            color: var(--success-color);
            font-weight: 600;
            text-align: center;
            animation: fadeIn 0.2s ease;
          }
          .refresh-toast.visible {
            display: block;
          }
          @keyframes spin { to { transform: rotate(360deg); } }

          /* ── Cancel / Loading bar in header ── */
          .btn-cancel-refresh {
            background: rgba(239, 68, 68, 0.12);
            color: var(--danger-color);
            border: 1px solid rgba(239, 68, 68, 0.25);
            cursor: pointer;
            padding: 5px 10px;
            border-radius: 6px;
            font-size: 0.76rem;
            font-weight: 600;
            display: none;
            align-items: center;
            gap: 4px;
            animation: fadeIn 0.15s ease;
            transition: all 0.15s;
          }
          .btn-cancel-refresh:hover { background: #ef4444; color: white; border-color: transparent; }

          /* ── Cancel Confirmation Dialog ── */
          .cancel-confirm-overlay {
            position: fixed;
            inset: 0;
            background: rgba(0,0,0,0.5);
            z-index: 1100;
            display: none;
            align-items: center;
            justify-content: center;
            animation: fadeIn 0.15s ease;
            backdrop-filter: blur(6px);
          }
          .cancel-confirm-box {
            background: var(--vscode-editor-background);
            border: 1px solid var(--vscode-widget-border, var(--border-color));
            border-radius: 10px;
            padding: 18px 20px;
            min-width: 240px;
            max-width: 320px;
            box-shadow: 0 8px 24px var(--shadow-color);
            text-align: center;
          }
          .cancel-confirm-box h4 {
            margin: 0 0 6px 0;
            font-size: 0.95rem;
            font-weight: 700;
            color: var(--text-primary);
          }
          .cancel-confirm-box p {
            margin: 0 0 16px 0;
            font-size: 0.8rem;
            color: var(--text-secondary);
            line-height: 1.4;
          }
          .cancel-confirm-actions {
            display: flex;
            gap: 8px;
            justify-content: center;
          }
          .cancel-confirm-actions .btn { min-width: 75px; }

          /* Disabled state for all action buttons during refresh */
          .actions-disabled .btn,
          .actions-disabled .btn-icon,
          .actions-disabled .dropdown-item {
            opacity: 0.4;
            pointer-events: none;
            cursor: not-allowed;
          }
          .actions-disabled .cancel-confirm-actions .btn {
            opacity: 1;
            pointer-events: auto;
            cursor: pointer;
          }

          /* Loading overlay for export/import */
          .loading-overlay {
            position: fixed;
            inset: 0;
            background: rgba(0,0,0,0.5);
            z-index: 1000;
            display: flex;
            flex-direction: column;
            align-items: center;
            justify-content: center;
            gap: 14px;
            backdrop-filter: blur(6px);
          }
          .loading-spinner {
            width: 32px; height: 32px;
            border: 3px solid rgba(128, 128, 128, 0.2);
            border-top-color: var(--primary-color);
            border-radius: 50%;
            animation: spin 0.8s linear infinite;
          }
          .loading-text {
            color: var(--text-secondary);
            font-size: 0.82rem;
            font-weight: 600;
          }

          /* ── Dropdown Menu ── */
          .menu-wrapper { position: relative; }
          .dropdown-menu {
            display: none;
            position: absolute;
            top: calc(100% + 6px);
            right: 0;
            min-width: 175px;
            background: var(--vscode-dropdown-background, var(--vscode-menu-background, var(--vscode-editor-background)));
            border: 1px solid var(--vscode-dropdown-border, var(--vscode-menu-border, var(--border-color)));
            border-radius: 6px;
            box-shadow: 0 6px 20px var(--shadow-color);
            z-index: 100;
            overflow: hidden;
            animation: fadeIn 0.15s ease;
          }
          .dropdown-menu.show { display: block; }
          @keyframes fadeIn { from { opacity: 0; transform: translateY(-4px); } to { opacity: 1; transform: translateY(0); } }
          .dropdown-item {
            display: flex;
            align-items: center;
            gap: 8px;
            width: 100%;
            padding: 8px 12px;
            background: none;
            border: none;
            color: var(--vscode-dropdown-foreground, var(--vscode-menu-foreground, var(--text-primary)));
            font-size: 0.8rem;
            cursor: pointer;
            text-align: start;
            transition: background 0.12s;
            font-weight: 500;
          }
          .dropdown-item:hover { background: var(--vscode-list-hoverBackground, var(--surface-light)); }
          .dropdown-item:disabled {
            opacity: 0.4;
            cursor: not-allowed;
          }
          .dropdown-item:disabled:hover { background: none; }
          .dropdown-icon { font-size: 0.95rem; display: inline-flex; align-items: center; justify-content: center; }
        </style>
      </head>
      <body>
        <!-- Loading Overlay -->
        <div id="loadingOverlay" class="loading-overlay" style="display:none;">
          <div class="loading-spinner"></div>
          <div class="loading-text" id="loadingText">${i18n.t('common.loading')}</div>
        </div>

        <div class="header-actions">
          <div style="display:flex;align-items:center;gap:8px;">
            <h2>${i18n.t('accounts.title')}</h2>
            ${accounts.length > 0 ? `
              <span class="quota-count-badge ${withQuotaCount > 0 ? 'has-quota' : 'no-quota'}" id="quotaCountBadge" title="${withQuotaCount} de ${accounts.length} cuentas con cuota disponible">
                <span class="quota-count-dot"></span>
                <span>${withQuotaCount}/${accounts.length}</span>
              </span>
            ` : ''}
          </div>
          <div style="display:flex;align-items:center;gap:4px;">
            <button id="cancelRefreshBtn" class="btn-cancel-refresh" onclick="showCancelConfirm()" title="${i18n.t('accounts.cancelRefresh')}">
              <svg class="icon-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:12px; height:12px; margin-inline-end: 4px;"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
              ${i18n.t('accounts.cancelRefresh')}
            </button>
            <button id="refreshBtn" class="btn-icon" onclick="handleRefresh()" title="${i18n.t('commands.refreshBalances.title')}">
              <svg class="icon-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21.5 2v6h-6"/><path d="M21.34 15.57a10 10 0 1 1-.57-8.38l5.67-5.67"/></svg>
            </button>
            <button id="addBtn" class="btn-icon" onclick="sendMessage('addAccount')" title="${i18n.t('commands.addAccount.title')}">
              <svg class="icon-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
            </button>
            <div class="menu-wrapper">
              <button class="btn-icon" onclick="toggleMenu(event)" title="${i18n.t('accounts.more')}" id="menuBtn">
                <svg class="icon-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="1.5"/><circle cx="12" cy="5" r="1.5"/><circle cx="12" cy="19" r="1.5"/></svg>
              </button>
              <div class="dropdown-menu" id="dropdownMenu">
                <button class="dropdown-item" onclick="handleMenuAction('export')" ${accounts.length === 0 ? 'disabled' : ''}>
                  <span class="dropdown-icon"><svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M8.5 2.5l3.5 3.5-1.5 1.5L8.5 5.5v7h-1v-7L5.5 7.5 4 6l4-3.5zM14 14v1H2v-1h12z"/></svg></span> ${i18n.t('accounts.exportAccounts')}
                </button>
                <button class="dropdown-item" onclick="handleMenuAction('import')">
                  <span class="dropdown-icon"><svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M8.5 10.5l3.5-3.5-1.5-1.5L8.5 7.5v-7h-1v7L5.5 5.5 4 7l4 3.5zM14 14v1H2v-1h12z"/></svg></span> ${i18n.t('accounts.importAccounts')}
                </button>
                <div style="border-top: 1px solid var(--vscode-menu-separatorBackground); margin: 4px 0;"></div>
                <button class="dropdown-item" onclick="handleMenuAction('settings')">
                  <span class="dropdown-icon"><svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M15.5 8l-1.5 1.5v1l1 1.5-1.5 1.5-1.5-1h-1L9.5 14h-3l-1.5-1.5h-1l-1.5 1-1.5-1.5 1-1.5v-1L.5 8l1.5-1.5v-1l-1-1.5 1.5-1.5 1.5 1h1L6.5 2h3l1.5 1.5h1l1.5-1 1.5 1.5-1 1.5v1L15.5 8zM8 11c1.65 0 3-1.35 3-3s-1.35-3-3-3-3 1.35-3 3 1.35 3 3 3z"/></svg></span> ${i18n.t('accounts.settings')}
                </button>
              </div>
            </div>
          </div>
        </div>

        ${accounts.length > 0 ? `
        <div class="search-container" id="searchContainer">
          <input type="text" id="searchInput" class="search-input" placeholder="${i18n.t('accounts.searchPlaceholder')}" autocomplete="off" />
          <button class="search-clear-btn" id="searchClearBtn" onclick="clearSearch()">
            <svg class="icon-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
          </button>
        </div>
        <div class="toolbar-container">
          <label class="toolbar-sort" for="sortSelect" style="position: relative;">
            <span class="toolbar-label" id="sortLabelDisplay"><span class="toolbar-label-prefix">${i18n.t('webview.sortBy')}: </span><span class="toolbar-value" style="color: var(--text-primary); font-size: 0.78rem; font-weight: 500; text-transform: none; margin-inline-start: 4px;">${getSortByLabel(configSortBy || 'default')}</span></span>
            <select id="sortSelect" onchange="handleSortChange()" style="position: absolute; inset: 0; width: 100%; height: 100%; opacity: 0; cursor: pointer; -webkit-appearance: none; appearance: none;">
              <option value="default" ${configSortBy === 'default' ? 'selected' : ''}>${i18n.t('webview.sortDefault')}</option>
              <option value="name-asc" ${configSortBy === 'name-asc' ? 'selected' : ''}>${i18n.t('webview.sortNameAsc')}</option>
              <option value="name-desc" ${configSortBy === 'name-desc' ? 'selected' : ''}>${i18n.t('webview.sortNameDesc')}</option>
              <option value="email-asc" ${configSortBy === 'email-asc' ? 'selected' : ''}>${i18n.t('webview.sortEmailAsc')}</option>
              <option value="email-desc" ${configSortBy === 'email-desc' ? 'selected' : ''}>${i18n.t('webview.sortEmailDesc')}</option>
              <option value="date-added" ${configSortBy === 'date-added' ? 'selected' : ''}>${i18n.t('webview.sortDateAdded')}</option>
              <option value="quota" ${configSortBy === 'quota' ? 'selected' : ''}>${i18n.t('webview.sortQuota')}</option>
              <option value="quota-regen" ${configSortBy === 'quota-regen' ? 'selected' : ''}>${i18n.t('webview.sortQuotaRegen')}</option>
            </select>
          </label>
          <label class="toolbar-scan" for="scanSelect" style="position: relative;">
            <span class="toolbar-label" id="scanLabelDisplay">⚡ <span class="scan-text-long">${i18n.t('webview.scanSegment')}</span><span class="scan-text-short" style="display: none;">${i18n.t('common.refresh')}</span></span>
            <select id="scanSelect" onchange="handleScanChange()" style="position: absolute; inset: 0; width: 100%; height: 100%; opacity: 0; cursor: pointer; -webkit-appearance: none; appearance: none;">
              <option value="">⚡ ${i18n.t('webview.scanSegment')}</option>
              <option value="all">${i18n.t('webview.scanAll')}</option>
              <option value="with-quota">${i18n.t('webview.scanWithQuota')}</option>
              <option value="without-quota">${i18n.t('webview.scanWithoutQuota')}</option>
            </select>
          </label>
        </div>` : ''}

        <div id="accounts-list">
          <!-- Refresh Progress Banner -->
          <div id="refreshProgressBanner" class="refresh-progress-banner ${this._isRefreshingProgress.isRefreshing ? 'visible' : ''}">
            <div class="refresh-progress-info">
              <span class="refresh-progress-email" id="refreshProgressEmail">${this._isRefreshingProgress.isRefreshing && this._isRefreshingProgress.currentEmail ? `<span class="refresh-label">${i18n.t('accounts.refreshingAccount')}: </span>${this._isRefreshingProgress.currentEmail}` : ''}</span>
              <div class="refresh-progress-stats">
                <span class="refresh-progress-count" id="refreshProgressCount">${this._isRefreshingProgress.currentIndex} / ${this._isRefreshingProgress.totalAccounts}</span>
                <span class="refresh-progress-percent" id="refreshProgressPercent">${this._isRefreshingProgress.totalAccounts > 0 ? Math.round((this._isRefreshingProgress.currentIndex / this._isRefreshingProgress.totalAccounts) * 100) : 0}%</span>
              </div>
            </div>
            <div class="refresh-progress-bar-track">
              <div class="refresh-progress-bar-fill" id="refreshProgressBar" style="width: ${this._isRefreshingProgress.totalAccounts > 0 ? Math.round((this._isRefreshingProgress.currentIndex / this._isRefreshingProgress.totalAccounts) * 100) : 0}%;"></div>
            </div>
          </div>
          <!-- Refresh Toast -->
          <div id="refreshToast" class="refresh-toast"></div>
          ${accountCardsHtml}
          <!-- Search No Results -->
          <div id="searchNoResults" class="search-no-results">
            <div class="search-no-results-icon">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="width:48px; height:48px; opacity:0.4; color:var(--text-secondary); margin-bottom: 8px;"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
            </div>
            <p>${i18n.t('accounts.noSearchResults')}</p>
          </div>
        </div>

        <!-- Cancel Confirmation Dialog -->
        <div id="cancelConfirmOverlay" class="cancel-confirm-overlay">
          <div class="cancel-confirm-box">
            <h4>${i18n.t('accounts.confirmCancelTitle')}</h4>
            <p>${i18n.t('accounts.confirmCancelMessage')}</p>
            <div class="cancel-confirm-actions">
              <button class="btn btn-danger" onclick="confirmCancel()">${i18n.t('accounts.confirmCancelYes')}</button>
              <button class="btn btn-primary" onclick="dismissCancelConfirm()">${i18n.t('accounts.confirmCancelNo')}</button>
            </div>
          </div>
        </div>

        <!-- Settings Modal -->
        <div id="settingsModal" class="modal-overlay" style="display:none; position:fixed; top:0; left:0; width:100%; height:100%; background:rgba(0,0,0,0.6); z-index:1000; align-items:center; justify-content:center; backdrop-filter:blur(4px);">
          <div class="modal-content" style="background:var(--surface-color); border:1px solid var(--border-color); color:var(--text-primary); border-radius:10px; width:90%; max-width:400px; padding:20px; box-shadow:0 8px 24px var(--shadow-color); max-height:90vh; overflow-y:auto;">
            <h3 style="margin-top:0; margin-bottom:16px; color:var(--text-primary);">${i18n.t('accounts.settings')}</h3>
            
            <div style="margin-bottom: 16px;">
              <label for="themeSelect" style="display:block; margin-bottom:8px; font-weight:bold; color:var(--text-primary);">${i18n.t('webview.theme')}</label>
              <select id="themeSelect" onchange="applyLiveTheme(this.value)" style="width:100%; padding:8px; background:var(--vscode-dropdown-background, var(--surface-subtle)); color:var(--vscode-dropdown-foreground, var(--text-primary)); border:1px solid var(--vscode-dropdown-border, var(--border-color)); border-radius:6px;">
                <option value="dark-purple" ${configTheme === 'dark-purple' ? 'selected' : ''}>${i18n.t('webview.themeDarkPurple')}</option>
                <option value="vscode" ${configTheme === 'vscode' ? 'selected' : ''}>${i18n.t('webview.themeVsCode')}</option>
                <option value="midnight" ${configTheme === 'midnight' ? 'selected' : ''}>${i18n.t('webview.themeMidnight')}</option>
                <option value="deep-blue" ${configTheme === 'deep-blue' ? 'selected' : ''}>${i18n.t('webview.themeDeepBlue')}</option>
              </select>
            </div>

            <div style="margin-bottom: 16px;">
              <label for="languageSelect" style="display:block; margin-bottom:8px; font-weight:bold; color:var(--text-primary);">${i18n.t('webview.language')}</label>
              <select id="languageSelect" style="width:100%; padding:8px; background:var(--vscode-dropdown-background, var(--surface-subtle)); color:var(--vscode-dropdown-foreground, var(--text-primary)); border:1px solid var(--vscode-dropdown-border, var(--border-color)); border-radius:6px;">
                <option value="auto" ${configLanguage === 'auto' ? 'selected' : ''}>${i18n.t('webview.languageAuto')}</option>
                <option value="en" ${configLanguage === 'en' ? 'selected' : ''}>English</option>
                <option value="es" ${configLanguage === 'es' ? 'selected' : ''}>Español</option>
                <option value="zh-CN" ${configLanguage === 'zh-CN' ? 'selected' : ''}>中文 (简体)</option>
                <option value="pt-BR" ${configLanguage === 'pt-BR' ? 'selected' : ''}>Português (Brasil)</option>
                <option value="fr" ${configLanguage === 'fr' ? 'selected' : ''}>Français</option>
                <option value="de" ${configLanguage === 'de' ? 'selected' : ''}>Deutsch</option>
                <option value="ja" ${configLanguage === 'ja' ? 'selected' : ''}>日本語</option>
                <option value="ru" ${configLanguage === 'ru' ? 'selected' : ''}>Русский</option>
                <option value="ko" ${configLanguage === 'ko' ? 'selected' : ''}>한국어</option>
                <option value="ar" ${configLanguage === 'ar' ? 'selected' : ''}>العربية</option>
              </select>
            </div>

            <div style="margin-bottom: 16px;">
              <label for="preferredModelSelect" style="display:block; margin-bottom:8px; font-weight:bold;">${i18n.t('webview.preferredModelSort')}</label>
              <select id="preferredModelSelect" style="width:100%; padding:8px; background:var(--vscode-dropdown-background); color:var(--vscode-dropdown-foreground); border:1px solid var(--vscode-dropdown-border); border-radius:4px;">
                <option value="">${i18n.t('webview.noSelectionDefault')}</option>
                <!-- Options populated by JS -->
              </select>
              <p style="font-size:0.85em; opacity:0.7; margin-top:8px;" id="settingsHelpText">
                ${i18n.t('webview.sortExplanation')}
              </p>
            </div>

            <div style="margin-bottom: 16px;">
              <label for="sortBySettingsSelect" style="display:block; margin-bottom:8px; font-weight:bold;">${i18n.t('webview.sortBy')}</label>
              <select id="sortBySettingsSelect" style="width:100%; padding:8px; background:var(--vscode-dropdown-background); color:var(--vscode-dropdown-foreground); border:1px solid var(--vscode-dropdown-border); border-radius:4px;">
                <option value="default" ${configSortBy === 'default' ? 'selected' : ''}>${i18n.t('webview.sortDefault')}</option>
                <option value="name-asc" ${configSortBy === 'name-asc' ? 'selected' : ''}>${i18n.t('webview.sortNameAsc')}</option>
                <option value="name-desc" ${configSortBy === 'name-desc' ? 'selected' : ''}>${i18n.t('webview.sortNameDesc')}</option>
                <option value="email-asc" ${configSortBy === 'email-asc' ? 'selected' : ''}>${i18n.t('webview.sortEmailAsc')}</option>
                <option value="email-desc" ${configSortBy === 'email-desc' ? 'selected' : ''}>${i18n.t('webview.sortEmailDesc')}</option>
                <option value="date-added" ${configSortBy === 'date-added' ? 'selected' : ''}>${i18n.t('webview.sortDateAdded')}</option>
                <option value="quota" ${configSortBy === 'quota' ? 'selected' : ''}>${i18n.t('webview.sortQuota')}</option>
                <option value="quota-regen" ${configSortBy === 'quota-regen' ? 'selected' : ''}>${i18n.t('webview.sortQuotaRegen')}</option>
              </select>
            </div>

            <div style="margin-bottom: 16px;">
              <label for="cacheDurationSelect" style="display:block; margin-bottom:8px; font-weight:bold;">${i18n.t('webview.cacheDurationLabel')}</label>
              <select id="cacheDurationSelect" style="width:100%; padding:8px; background:var(--vscode-dropdown-background); color:var(--vscode-dropdown-foreground); border:1px solid var(--vscode-dropdown-border); border-radius:4px;">
                <option value="1" ${configCacheDurationDays === 1 ? 'selected' : ''}>1 ${i18n.t('webview.day')}</option>
                <option value="3" ${configCacheDurationDays === 3 ? 'selected' : ''}>3 ${i18n.t('webview.days')}</option>
                <option value="7" ${configCacheDurationDays === 7 ? 'selected' : ''}>7 ${i18n.t('webview.days')}</option>
                <option value="14" ${configCacheDurationDays === 14 ? 'selected' : ''}>14 ${i18n.t('webview.days')}</option>
                <option value="30" ${configCacheDurationDays === 30 ? 'selected' : ''}>30 ${i18n.t('webview.days')}</option>
              </select>
              <p style="font-size:0.82em; opacity:0.65; margin:6px 0 0 0;">${i18n.t('webview.cacheDurationDescription')}</p>
            </div>

            <div style="border-top: 1px solid var(--border-color); padding-top: 16px; margin-bottom: 16px;">
              <div style="display:flex; align-items:center; justify-content:space-between; margin-bottom:8px;">
                <label for="autoRefreshToggle" style="font-weight:bold; cursor:pointer;">${i18n.t('webview.autoRefreshLabel')}</label>
                <label style="position:relative; display:inline-block; width:40px; height:22px; cursor:pointer;">
                  <input type="checkbox" id="autoRefreshToggle" ${configAutoRefresh ? 'checked' : ''} onchange="onAutoRefreshToggle()" style="opacity:0; width:0; height:0;">
                  <span id="autoRefreshTrack" style="position:absolute; inset:0; background:${configAutoRefresh ? '#4caf50' : 'var(--glass-border)'}; border-radius:11px; transition:background 0.3s, box-shadow 0.3s; ${configAutoRefresh ? 'box-shadow:0 0 6px rgba(76,175,80,0.4);' : ''}"></span>
                  <span id="autoRefreshSlider" style="position:absolute; top:2px; ${isRtl ? 'right' : 'left'}:2px; width:18px; height:18px; background:var(--text-primary); border-radius:50%; transition:0.3s; ${configAutoRefresh ? (isRtl ? 'right:20px' : 'left:20px') : ''}"></span>
                </label>
              </div>
              <p style="font-size:0.82em; opacity:0.65; margin:0 0 12px 0;">${i18n.t('webview.autoRefreshDescription')}</p>

              <div style="display:flex; align-items:center; justify-content:space-between; margin-bottom:8px; margin-top:12px;">
                <label for="autoRotateToggle" style="font-weight:bold; cursor:pointer;">${i18n.t('webview.autoRotateLabel')}</label>
                <label style="position:relative; display:inline-block; width:40px; height:22px; cursor:pointer;">
                  <input type="checkbox" id="autoRotateToggle" ${configAutoRotate ? 'checked' : ''} onchange="onAutoRotateToggle()" style="opacity:0; width:0; height:0;">
                  <span id="autoRotateTrack" style="position:absolute; inset:0; background:${configAutoRotate ? '#4caf50' : 'var(--glass-border)'}; border-radius:11px; transition:background 0.3s, box-shadow 0.3s; ${configAutoRotate ? 'box-shadow:0 0 6px rgba(76,175,80,0.4);' : ''}"></span>
                  <span id="autoRotateSlider" style="position:absolute; top:2px; ${isRtl ? 'right' : 'left'}:2px; width:18px; height:18px; background:var(--text-primary); border-radius:50%; transition:0.3s; ${configAutoRotate ? (isRtl ? 'right:20px' : 'left:20px') : ''}"></span>
                </label>
              </div>
              <p style="font-size:0.82em; opacity:0.65; margin:0 0 12px 0;">${i18n.t('webview.autoRotateDescription')}</p>

              <div style="display:flex; align-items:center; justify-content:space-between; margin-bottom:8px; margin-top:12px;">
                <label for="lowCreditNotificationsToggle" style="font-weight:bold; cursor:pointer;">${i18n.t('webview.lowCreditNotificationsLabel')}</label>
                <label style="position:relative; display:inline-block; width:40px; height:22px; cursor:pointer;">
                  <input type="checkbox" id="lowCreditNotificationsToggle" ${configLowCreditNotifications ? 'checked' : ''} onchange="onLowCreditNotificationsToggle()" style="opacity:0; width:0; height:0;">
                  <span id="lowCreditNotificationsTrack" style="position:absolute; inset:0; background:${configLowCreditNotifications ? '#4caf50' : 'var(--glass-border)'}; border-radius:11px; transition:background 0.3s, box-shadow 0.3s; ${configLowCreditNotifications ? 'box-shadow:0 0 6px rgba(76,175,80,0.4);' : ''}"></span>
                  <span id="lowCreditNotificationsSlider" style="position:absolute; top:2px; ${isRtl ? 'right' : 'left'}:2px; width:18px; height:18px; background:var(--text-primary); border-radius:50%; transition:0.3s; ${configLowCreditNotifications ? (isRtl ? 'right:20px' : 'left:20px') : ''}"></span>
                </label>
              </div>
              <p style="font-size:0.82em; opacity:0.65; margin:0 0 12px 0;">${i18n.t('webview.lowCreditNotificationsDescription')}</p>

              <div id="refreshIntervalGroup" style="${configAutoRefresh ? '' : 'opacity:0.4; pointer-events:none;'}">
                <label for="refreshIntervalSelect" style="display:block; margin-bottom:6px; font-weight:bold; font-size:0.9em;">${i18n.t('webview.refreshIntervalLabel')}</label>
                <select id="refreshIntervalSelect" style="width:100%; padding:8px; background:var(--vscode-dropdown-background); color:var(--vscode-dropdown-foreground); border:1px solid var(--vscode-dropdown-border); border-radius:4px;">
                  <option value="0" ${configRefreshInterval === 0 ? 'selected' : ''}>${i18n.t('webview.intervalImmediate')}</option>
                  <option value="5" ${configRefreshInterval === 5 ? 'selected' : ''}>${i18n.t('webview.interval5Min')}</option>
                  <option value="15" ${configRefreshInterval === 15 ? 'selected' : ''}>${i18n.t('webview.interval15Min')}</option>
                  <option value="30" ${configRefreshInterval === 30 ? 'selected' : ''}>${i18n.t('webview.interval30Min')}</option>
                  <option value="60" ${configRefreshInterval === 60 ? 'selected' : ''}>${i18n.t('webview.interval1Hour')}</option>
                  <option value="1440" ${configRefreshInterval === 1440 ? 'selected' : ''}>${i18n.t('webview.interval1Day')}</option>
                </select>
                <p style="font-size:0.82em; opacity:0.65; margin:6px 0 0 0;">${i18n.t('webview.refreshIntervalDescription')}</p>
              </div>
            </div>

            <!-- Immediate Mode Confirmation Dialog -->
            <div id="immediateConfirmOverlay" style="display:none; position:fixed; top:0; left:0; width:100%; height:100%; background:rgba(0,0,0,0.6); z-index:2000; align-items:center; justify-content:center;">
              <div style="background:var(--vscode-editor-background); border:1px solid var(--vscode-widget-border); border-radius:10px; width:85%; max-width:360px; padding:20px; box-shadow:0 8px 24px rgba(0,0,0,0.3); text-align:center;">
                <h4 style="margin:0 0 12px 0; color:var(--warning-color); font-size:1em;">${i18n.t('webview.immediateConfirmTitle')}</h4>
                <p style="font-size:0.85em; opacity:0.8; line-height:1.5; margin:0 0 16px 0;">${i18n.t('webview.immediateConfirmMessage')}</p>
                <div style="display:flex; justify-content:center; gap:10px;">
                  <button class="btn" style="background:var(--vscode-button-secondaryBackground); color:var(--vscode-button-secondaryForeground);" onclick="cancelImmediateMode()">${i18n.t('webview.immediateConfirmCancel')}</button>
                  <button class="btn" style="background:var(--warning-color); color:#000; font-weight:600;" onclick="confirmImmediateMode()">${i18n.t('webview.immediateConfirmYes')}</button>
                </div>
              </div>
            </div>

            <div style="display:flex; justify-content:flex-end; gap:8px;">
              <button class="btn" style="background:var(--vscode-button-secondaryBackground); color:var(--vscode-button-secondaryForeground);" onclick="closeSettings()">${i18n.t('common.cancel')}</button>
              <button class="btn btn-primary" onclick="saveSettings()">${i18n.t('common.save')}</button>
            </div>
          </div>
        </div>

        <script>
          const vscode = acquireVsCodeApi();
          
          window.onerror = function(message, source, lineno, colno, error) {
            vscode.postMessage({
              command: 'logError',
              message: message,
              source: source,
              lineno: lineno,
              colno: colno,
              stack: error ? error.stack : 'No stack'
            });
            return false;
          };

          // Redirect console logs to extension host for debugging
          const originalLog = console.log;
          const originalError = console.error;
          const originalWarn = console.warn;
          
          console.log = function(...args) {
            originalLog.apply(console, args);
            vscode.postMessage({ command: 'consoleLog', level: 'info', args: args.map(String) });
          };
          console.error = function(...args) {
            originalError.apply(console, args);
            vscode.postMessage({ command: 'consoleLog', level: 'error', args: args.map(String) });
          };
          console.warn = function(...args) {
            originalWarn.apply(console, args);
            vscode.postMessage({ command: 'consoleLog', level: 'warn', args: args.map(String) });
          };
        </script>
        <script>
          const availableModelKeys = ${JSON.stringify(availableModelKeys)};
          const currentPreferredModel = ${JSON.stringify(effectivePreferred)};
          const currentTheme = ${JSON.stringify(configTheme)};
          const currentLanguage = ${JSON.stringify(configLanguage)};
          const hasAccounts = ${accounts.length > 0};
          const currentAutoRefresh = ${configAutoRefresh};
          const currentAutoRotate = ${configAutoRotate};
          const currentLowCreditNotifications = ${configLowCreditNotifications};
          const currentRefreshInterval = ${configRefreshInterval};
          const currentSortBy = ${JSON.stringify(configSortBy)};
          const currentCacheDurationDays = ${configCacheDurationDays};
          const isRtlDir = ${isRtl};
          const savedSearchQuery = ${JSON.stringify(this._searchQuery)};
          
          // vscode is now defined in the first script tag globally to allow window.onerror logging before this script runs.
          let state = vscode.getState() || { activeModels: {} };
          if (!state) state = { activeModels: {} };
          if (!state.activeModels) state.activeModels = {};

          function applyLiveTheme(theme) {
            if (!theme) return;
            document.documentElement.setAttribute('data-theme', theme);
            document.body.setAttribute('data-theme', theme);
            document.body.className = 'theme-' + theme;
          }

          function toggleModels(headerElement, wrapperId) {
            const wrapper = document.getElementById(wrapperId);
            if (wrapper) {
              wrapper.classList.toggle('expanded');
              headerElement.classList.toggle('expanded');
            }
          }

          function handleSwitchAccount(btn, email) {
            if (btn.disabled) return;
            btn.disabled = true;
            const originalText = btn.innerText;
            btn.innerText = '${i18n.t('webview.activating')}';
            btn.style.opacity = '0.7';
            btn.style.cursor = 'not-allowed';
            btn.dataset.originalText = originalText;
            
            sendMessage('switchAccount', email);

            if (btn.dataset.timeoutId) {
              clearTimeout(parseInt(btn.dataset.timeoutId, 10));
            }
            const tId = setTimeout(() => {
              btn.disabled = false;
              btn.innerText = originalText;
              btn.style.opacity = '';
              btn.style.cursor = '';
              delete btn.dataset.timeoutId;
            }, 10000);
            btn.dataset.timeoutId = tId;
          }

          // ── Refresh button ──
          let isRefreshing = ${this._isRefreshingProgress.isRefreshing};
          if (isRefreshing) {
            setTimeout(() => {
              setActionsDisabled(true);
              setSearchDisabled(true);
            }, 0);
          }

          function handleRefresh() {
            if (isRefreshing) return;
            const searchInput = document.getElementById('searchInput');
            const query = searchInput ? searchInput.value.trim() : '';
            if (query) {
              // Flush any pending debounce and apply filter immediately
              if (searchDebounceTimer) {
                clearTimeout(searchDebounceTimer);
                searchDebounceTimer = null;
              }
              applySearchFilter(query);
              // Now collect visible (filtered) account emails
              const visibleCards = document.querySelectorAll('.account-card:not(.search-hidden)');
              if (visibleCards.length === 0) return; // No results, do nothing
              const filteredEmails = Array.from(visibleCards).map(c => c.dataset.email);
              vscode.postMessage({ command: 'refreshAccounts', filteredEmails });
            } else {
              sendMessage('refreshAccounts');
            }
          }

          function handleSortChange() {
            const select = document.getElementById('sortSelect');
            const sortBy = select.value;
            const labelDisplay = document.getElementById('sortLabelDisplay');
            if (labelDisplay) {
              const selectedText = select.options[select.selectedIndex].text;
              labelDisplay.innerHTML = '<span class="toolbar-label-prefix">${i18n.t('webview.sortBy')}: </span><span class="toolbar-value" style="color: var(--text-primary); font-size: 0.78rem; font-weight: 500; text-transform: none; margin-inline-start: 4px;">' + selectedText + '</span>';
            }
            vscode.postMessage({
              command: 'saveSettings',
              sortBy: sortBy
            });
            // Show loading overlay briefly
            vscode.postMessage({ command: 'showLoading' });
          }

          function handleScanChange() {
            const select = document.getElementById('scanSelect');
            const segment = select.value;
            if (!segment) return;

            // Reset select value to default placeholder immediately
            select.value = '';

            let targetEmails = [];
            const cards = document.querySelectorAll('.account-card');

            const getCheckModel = (card) => {
              const email = card.dataset.email;
              const activeModel = state.activeModels && state.activeModels[email];
              if (activeModel) return activeModel.toLowerCase();
              const globalPref = (typeof currentPreferredModel === 'string' ? currentPreferredModel : '').toLowerCase();
              if (globalPref) return globalPref;
              return null;
            };

            const hasQuota = (card) => {
              try {
                const balances = JSON.parse(card.dataset.modelBalances || '{}');
                const checkModel = getCheckModel(card);
                if (checkModel) {
                  if (balances[checkModel] !== undefined) {
                    return balances[checkModel] > 0;
                  }
                  const matchingKey = Object.keys(balances).find(k => k.toLowerCase() === checkModel.toLowerCase() || k.toLowerCase().includes(checkModel.toLowerCase()) || checkModel.toLowerCase().includes(k.toLowerCase()));
                  if (matchingKey !== undefined) {
                    return balances[matchingKey] > 0;
                  }
                }
                return Object.values(balances).some(val => typeof val === 'number' && val > 0);
              } catch (e) {
                return false;
              }
            };

            if (segment === 'all') {
              targetEmails = Array.from(cards).map(c => c.dataset.email);
            } else if (segment === 'with-quota') {
              targetEmails = Array.from(cards)
                .filter(c => {
                  const status = c.dataset.status;
                  const isAvailable = (status === 'active' || status === 'low_balance');
                  return isAvailable && hasQuota(c);
                })
                .map(c => c.dataset.email);
            } else if (segment === 'without-quota') {
              targetEmails = Array.from(cards)
                .filter(c => {
                  const status = c.dataset.status;
                  const isDepletedOrError = (status === 'depleted' || status === 'token_expired' || status === 'ineligible' || status === 'error');
                  return isDepletedOrError || !hasQuota(c);
                })
                .map(c => c.dataset.email);
            }

            if (targetEmails.length === 0) {
              vscode.postMessage({
                command: 'showWarning',
                text: '${i18n.t('webview.noAccountsInSegment')}'
              });
              return;
            }

            vscode.postMessage({
              command: 'refreshAccounts',
              filteredEmails: targetEmails
            });
          }

          function handleSingleRefresh(btn, email) {
            // Find the closest account-card element
            const card = btn.closest('.account-card');
            if (card) {
              card.classList.add('refreshing');
            }
            vscode.postMessage({
              command: 'refreshSingleAccount',
              email: email
            });
          }

          // ── Search ──
          let searchDebounceTimer = null;

          function applySearchFilter(query) {
            const cards = document.querySelectorAll('.account-card');
            const noResults = document.getElementById('searchNoResults');
            const clearBtn = document.getElementById('searchClearBtn');
            const q = query.toLowerCase().trim();

            if (clearBtn) clearBtn.style.display = q ? 'block' : 'none';

            if (!q) {
              // Show all cards, hide no-results
              cards.forEach(c => c.classList.remove('search-hidden'));
              if (noResults) noResults.style.display = 'none';
              return;
            }

            let visibleCount = 0;
            cards.forEach(card => {
              const email = (card.dataset.email || '').toLowerCase();
              const name = (card.dataset.name || '').toLowerCase();
              if (email.includes(q) || name.includes(q)) {
                card.classList.remove('search-hidden');
                visibleCount++;
              } else {
                card.classList.add('search-hidden');
              }
            });

            if (noResults) noResults.style.display = visibleCount === 0 ? 'block' : 'none';
          }

          function onSearchInput(e) {
            const query = e.target.value;
            // Notify provider to preserve query across re-renders
            vscode.postMessage({ command: 'searchChanged', query });
            if (searchDebounceTimer) clearTimeout(searchDebounceTimer);
            searchDebounceTimer = setTimeout(() => {
              applySearchFilter(query);
            }, 300);
          }

          function clearSearch() {
            const input = document.getElementById('searchInput');
            if (input) { input.value = ''; input.focus(); }
            if (searchDebounceTimer) clearTimeout(searchDebounceTimer);
            applySearchFilter('');
            vscode.postMessage({ command: 'searchChanged', query: '' });
          }

          function setSearchDisabled(disabled) {
            const input = document.getElementById('searchInput');
            const clearBtn = document.getElementById('searchClearBtn');
            if (input) input.disabled = disabled;
            if (clearBtn && disabled) clearBtn.style.display = 'none';
          }

          // Attach search listener and restore state
          (function initSearch() {
            const input = document.getElementById('searchInput');
            if (input) {
              input.addEventListener('input', onSearchInput);
              
              // Track focus state to restore it after re-renders
              input.addEventListener('focus', () => {
                const st = vscode.getState() || {};
                vscode.setState({ ...st, searchFocused: true });
              });
              input.addEventListener('blur', () => {
                const st = vscode.getState() || {};
                vscode.setState({ ...st, searchFocused: false });
              });

              // Restore search query from provider state
              if (savedSearchQuery) {
                input.value = savedSearchQuery;
                applySearchFilter(savedSearchQuery);
              }

              // Restore focus if it was focused before re-render
              const currentState = vscode.getState() || {};
              if (currentState.searchFocused && !input.disabled) {
                input.focus();
              }
            }
          })();

          // ── Cancel confirmation ──
          function showCancelConfirm() {
            document.getElementById('cancelConfirmOverlay').style.display = 'flex';
          }
          function dismissCancelConfirm() {
            document.getElementById('cancelConfirmOverlay').style.display = 'none';
          }
          function confirmCancel() {
            // Transform dialog to "cancelling" state with loading spinner
            const box = document.querySelector('.cancel-confirm-box');
            if (box) {
              box.innerHTML = '<div style="display:flex;flex-direction:column;align-items:center;gap:12px;padding:8px 0;">' +
                '<div style="width:22px;height:22px;border:2px solid var(--glass-border);border-top-color:var(--primary-color);border-radius:50%;animation:spin 0.7s linear infinite;"></div>' +
                '<span style="font-size:0.85rem;color:var(--text-secondary);">${i18n.t('accounts.cancellingRefresh')}</span>' +
                '</div>';
            }
            sendMessage('cancelRefresh');
          }

          function applyActiveModels() {
             document.querySelectorAll('.account-card').forEach(card => {
                const email = card.dataset?.email || card.querySelector('.user-info p').innerText.trim();
                const activeModelKey = state.activeModels[email];
                const container = card.querySelector('.models-container');
                
                if (activeModelKey && container) {
                   if (!container.originalOrder) {
                      container.originalOrder = Array.from(container.children);
                   }
                   
                   // Restore original sorted order first
                   container.innerHTML = '';
                   container.originalOrder.forEach(el => {
                      el.classList.remove('active-model');
                      container.appendChild(el);
                   });
                   
                   // Also remove active-model from preferred header if it exists
                   const preferredHeader = card.querySelector('.preferred-model-card');
                   if (preferredHeader) {
                      preferredHeader.classList.remove('active-model');
                   }
                   
                   // Find the active model inside the container and move it to top
                   const targetModel = container.querySelector('.model-card[data-model-key="' + activeModelKey + '"]');
                   if (targetModel) {
                      container.prepend(targetModel);
                      targetModel.classList.add('active-model');
                   } else if (preferredHeader && preferredHeader.dataset.modelKey === activeModelKey) {
                      // If the active model is the preferred model (which is in the header now)
                      preferredHeader.classList.add('active-model');
                   }
                }
             });
          }

          // Run immediately on load
          try {
             document.querySelectorAll('.models-container').forEach(container => {
                container.originalOrder = Array.from(container.children);
             });
             applyActiveModels();
          } catch (err) {
             console.error("Error on load:", err);
          }

          let pendingModelKey = null;

          function selectModel(element, email, modelKey) {
             if (pendingModelKey) return;
             pendingModelKey = modelKey;
             
             element.style.opacity = '0.5';
             element.style.pointerEvents = 'none';
             
             sendMessage('switchModel', email, modelKey);
             
             // Fallback timeout in case of no response
             setTimeout(() => {
                if (pendingModelKey === modelKey) {
                   pendingModelKey = null;
                   element.style.opacity = '1';
                   element.style.pointerEvents = 'auto';
                }
             }, 3000);
          }

          window.addEventListener('message', event => {
             const message = event.data;
             if (message.command === 'modelSwitched') {
                const email = message.email;
                const modelKey = message.modelKey;
                pendingModelKey = null;
                
                state.activeModels[email] = modelKey;
                vscode.setState(state);
                applyActiveModels();
                
                document.querySelectorAll('.model-card').forEach(c => {
                   c.style.opacity = '1';
                   c.style.pointerEvents = 'auto';
                });
             } else if (message.command === 'accountSwitchCancelled') {
                const card = document.querySelector('.account-card[data-email="' + message.email + '"]');
                const btn = card ? card.querySelector('.btn-primary') : null;
                if (btn) {
                   if (btn.dataset.timeoutId) {
                      clearTimeout(parseInt(btn.dataset.timeoutId, 10));
                      delete btn.dataset.timeoutId;
                   }
                   btn.disabled = false;
                   btn.innerText = btn.dataset.originalText || '${i18n.t('accounts.activate')}';
                   btn.style.opacity = '';
                   btn.style.cursor = '';
                 }
              }
           });

          // ── Dropdown Menu ──
          function toggleMenu(e) {
            e.stopPropagation();
            const menu = document.getElementById('dropdownMenu');
            menu.classList.toggle('show');
          }
          document.addEventListener('click', () => {
            const m = document.getElementById('dropdownMenu');
            if (m) m.classList.remove('show');
          });

          function handleMenuAction(action) {
            try {
              const m = document.getElementById('dropdownMenu');
              if (m) m.classList.remove('show');
              if (action === 'export') {
                sendMessage('exportAccounts');
              } else if (action === 'import') {
                sendMessage('importAccounts');
              } else if (action === 'settings') {
                openSettings();
              }
            } catch (err) {
              alert("Error in handleMenuAction: " + err.message + "\\nStack:\\n" + err.stack);
            }
          }

          // ── Settings Modal ──
          let _previousIntervalValue = String(currentRefreshInterval);

          function onAutoRefreshToggle() {
            const toggle = document.getElementById('autoRefreshToggle');
            const intervalGroup = document.getElementById('refreshIntervalGroup');
            const slider = document.getElementById('autoRefreshSlider');
            const track = document.getElementById('autoRefreshTrack');
            if (toggle.checked) {
              intervalGroup.style.opacity = '1';
              intervalGroup.style.pointerEvents = 'auto';
              slider.style[isRtlDir ? 'right' : 'left'] = '20px';
              track.style.background = '#4caf50';
              track.style.boxShadow = '0 0 6px rgba(76,175,80,0.4)';
            } else {
              intervalGroup.style.opacity = '0.4';
              intervalGroup.style.pointerEvents = 'none';
              slider.style[isRtlDir ? 'right' : 'left'] = '2px';
              track.style.background = 'var(--glass-border)';
              track.style.boxShadow = 'none';
            }
          }

          function onAutoRotateToggle() {
            const toggle = document.getElementById('autoRotateToggle');
            const slider = document.getElementById('autoRotateSlider');
            const track = document.getElementById('autoRotateTrack');
            if (toggle.checked) {
              slider.style[isRtlDir ? 'right' : 'left'] = '20px';
              track.style.background = '#4caf50';
              track.style.boxShadow = '0 0 6px rgba(76,175,80,0.4)';
            } else {
              slider.style[isRtlDir ? 'right' : 'left'] = '2px';
              track.style.background = 'var(--glass-border)';
              track.style.boxShadow = 'none';
            }
          }

          function onLowCreditNotificationsToggle() {
            const toggle = document.getElementById('lowCreditNotificationsToggle');
            const slider = document.getElementById('lowCreditNotificationsSlider');
            const track = document.getElementById('lowCreditNotificationsTrack');
            if (toggle.checked) {
              slider.style[isRtlDir ? 'right' : 'left'] = '20px';
              track.style.background = '#4caf50';
              track.style.boxShadow = '0 0 6px rgba(76,175,80,0.4)';
            } else {
              slider.style[isRtlDir ? 'right' : 'left'] = '2px';
              track.style.background = 'var(--glass-border)';
              track.style.boxShadow = 'none';
            }
          }

          function onIntervalChange() {
            const select = document.getElementById('refreshIntervalSelect');
            if (select.value === '0') {
              // Show confirmation dialog for immediate mode
              document.getElementById('immediateConfirmOverlay').style.display = 'flex';
            } else {
              _previousIntervalValue = select.value;
            }
          }

          function confirmImmediateMode() {
            document.getElementById('immediateConfirmOverlay').style.display = 'none';
            _previousIntervalValue = '0';
          }

          function cancelImmediateMode() {
            document.getElementById('immediateConfirmOverlay').style.display = 'none';
            const select = document.getElementById('refreshIntervalSelect');
            select.value = _previousIntervalValue;
          }

          // Attach change listener to interval dropdown after settings open
          function attachIntervalListener() {
            const select = document.getElementById('refreshIntervalSelect');
            if (select && !select._listenerAttached) {
              select.addEventListener('change', onIntervalChange);
              select._listenerAttached = true;
            }
          }

          function openSettings() {
            try {
              const modal = document.getElementById('settingsModal');
              const select = document.getElementById('preferredModelSelect');
              const helpText = document.getElementById('settingsHelpText');
              
              // Sync theme and language dropdowns
              const themeSelect = document.getElementById('themeSelect');
              if (themeSelect) {
                themeSelect.value = currentTheme;
              }
              const langSelect = document.getElementById('languageSelect');
              if (langSelect) {
                langSelect.value = currentLanguage;
              }

              // Populate preferred model options
              select.innerHTML = '<option value="">${i18n.t('webview.noSelectionDefault')}</option>';
            
            if (!hasAccounts || availableModelKeys.length === 0) {
              select.disabled = true;
              helpText.innerText = "${i18n.t('webview.loginRequired')}";
              helpText.style.color = "var(--vscode-errorForeground)";
            } else {
              select.disabled = false;
              helpText.innerText = "${i18n.t('webview.sortExplanation')}";
              helpText.style.color = "";
              
              availableModelKeys.forEach(key => {
                const option = document.createElement('option');
                option.value = key;
                option.innerText = key;
                if (key === currentPreferredModel) {
                  option.selected = true;
                }
                select.appendChild(option);
              });
            }
            
            // Reset interval dropdown to current value
            const intervalSelect = document.getElementById('refreshIntervalSelect');
            if (intervalSelect) {
              intervalSelect.value = String(currentRefreshInterval);
              _previousIntervalValue = String(currentRefreshInterval);
            }

            const autoRefreshToggle = document.getElementById('autoRefreshToggle');
            if (autoRefreshToggle) {
              autoRefreshToggle.checked = currentAutoRefresh;
              onAutoRefreshToggle();
            }

            const autoRotateToggle = document.getElementById('autoRotateToggle');
            if (autoRotateToggle) {
              autoRotateToggle.checked = currentAutoRotate;
              onAutoRotateToggle();
            }

            const lowCreditNotificationsToggle = document.getElementById('lowCreditNotificationsToggle');
            if (lowCreditNotificationsToggle) {
              lowCreditNotificationsToggle.checked = currentLowCreditNotifications;
              onLowCreditNotificationsToggle();
            }

            // Reset sort-by and cache-duration to current values
            const sortBySettingsSelect = document.getElementById('sortBySettingsSelect');
            if (sortBySettingsSelect) {
              sortBySettingsSelect.value = currentSortBy;
            }
            const cacheDurationSelect = document.getElementById('cacheDurationSelect');
            if (cacheDurationSelect) {
              cacheDurationSelect.value = String(currentCacheDurationDays);
            }

            modal.style.display = 'flex';
            attachIntervalListener();
            } catch (err) {
              alert("Error in openSettings: " + err.message + "\\nStack:\\n" + err.stack);
            }
          }

          function closeSettingsModalOnly() {
            document.getElementById('settingsModal').style.display = 'none';
            document.getElementById('immediateConfirmOverlay').style.display = 'none';
          }

          function closeSettings() {
            closeSettingsModalOnly();
            // Revert live preview back to current active theme if user cancelled
            applyLiveTheme(currentTheme);
            const themeSelect = document.getElementById('themeSelect');
            if (themeSelect) themeSelect.value = currentTheme;
          }

          function saveSettings() {
            const themeSelect = document.getElementById('themeSelect');
            const selectedTheme = themeSelect ? themeSelect.value : 'dark-purple';
            currentTheme = selectedTheme; // Update in-memory reference immediately!
            applyLiveTheme(selectedTheme);

            const select = document.getElementById('preferredModelSelect');
            const selectedModel = select.value;
            const langSelect = document.getElementById('languageSelect');
            const selectedLang = langSelect ? langSelect.value : 'auto';
            const autoRefreshToggle = document.getElementById('autoRefreshToggle');
            const autoRefreshEnabled = autoRefreshToggle ? autoRefreshToggle.checked : true;
            const autoRotateToggle = document.getElementById('autoRotateToggle');
            const autoRotateEnabled = autoRotateToggle ? autoRotateToggle.checked : false;
            const lowCreditNotificationsToggle = document.getElementById('lowCreditNotificationsToggle');
            const lowCreditNotificationsEnabled = lowCreditNotificationsToggle ? lowCreditNotificationsToggle.checked : true;
            const intervalSelect = document.getElementById('refreshIntervalSelect');
            const refreshInterval = intervalSelect ? parseInt(intervalSelect.value) : 15;
            
            const sortBySettingsSelect = document.getElementById('sortBySettingsSelect');
            const selectedSortBy = sortBySettingsSelect ? sortBySettingsSelect.value : 'default';
            const cacheDurationSelect = document.getElementById('cacheDurationSelect');
            const selectedCacheDuration = cacheDurationSelect ? parseInt(cacheDurationSelect.value) : 7;

            closeSettingsModalOnly();

            vscode.postMessage({
              command: 'saveSettings',
              theme: selectedTheme,
              language: selectedLang,
              preferredModel: selectedModel,
              autoRefreshEnabled: autoRefreshEnabled,
              autoRotateEnabled: autoRotateEnabled,
              lowCreditNotificationsEnabled: lowCreditNotificationsEnabled,
              refreshIntervalMinutes: refreshInterval,
              sortBy: selectedSortBy,
              cacheDurationDays: selectedCacheDuration
            });
          }
          
          // Modify sendMessage to handle additional payload if needed
          function sendMessage(command, email = null, modelKey = null) {
            vscode.postMessage({ command, email, modelKey });
          }

          function startEditAlias(email) {
            const safeId = email.replace(/[@.]/g, '-');
            const displayEl = document.getElementById('name-display-' + safeId);
            const inputEl = document.getElementById('name-input-' + safeId);
            const editBtn = document.getElementById('edit-btn-' + safeId);
            const refreshBtn = document.getElementById('refresh-btn-' + safeId);
            
            if (displayEl && inputEl && editBtn) {
              displayEl.style.display = 'none';
              editBtn.style.display = 'none';
              if (refreshBtn) refreshBtn.style.display = 'none';
              inputEl.style.display = 'inline-block';
              inputEl.focus();
              inputEl.select();
            }
          }

          function cancelEditAlias(email) {
            const safeId = email.replace(/[@.]/g, '-');
            const displayEl = document.getElementById('name-display-' + safeId);
            const inputEl = document.getElementById('name-input-' + safeId);
            const editBtn = document.getElementById('edit-btn-' + safeId);
            const refreshBtn = document.getElementById('refresh-btn-' + safeId);
            
            if (displayEl && inputEl && editBtn) {
              inputEl.style.display = 'none';
              displayEl.style.display = 'block';
              editBtn.style.display = 'inline-block';
              if (refreshBtn) refreshBtn.style.display = 'inline-block';
              const card = document.querySelector('.account-card[data-email="' + email + '"]');
              if (card) {
                inputEl.value = card.getAttribute('data-alias') || '';
              }
            }
          }

          function saveAlias(email) {
            const safeId = email.replace(/[@.]/g, '-');
            const displayEl = document.getElementById('name-display-' + safeId);
            const inputEl = document.getElementById('name-input-' + safeId);
            const editBtn = document.getElementById('edit-btn-' + safeId);
            const refreshBtn = document.getElementById('refresh-btn-' + safeId);
            
            if (inputEl && inputEl.style.display !== 'none') {
              const newValue = inputEl.value.trim();
              
              inputEl.style.display = 'none';
              if (displayEl) displayEl.style.display = 'block';
              if (editBtn) editBtn.style.display = 'inline-block';
              if (refreshBtn) refreshBtn.style.display = 'inline-block';
              
              vscode.postMessage({
                command: 'updateAlias',
                email: email,
                alias: newValue
              });
            }
          }

          function handleAliasKey(event, email) {
            if (event.key === 'Enter') {
              event.preventDefault();
              saveAlias(email);
            } else if (event.key === 'Escape') {
              event.preventDefault();
              cancelEditAlias(email);
            }
          }



          // ── Progressive refresh messages ──
          function setActionsDisabled(disabled) {
            const body = document.body;
            if (disabled) {
              body.classList.add('actions-disabled');
            } else {
              body.classList.remove('actions-disabled');
            }
            // Toggle cancel button visibility
            const cancelBtn = document.getElementById('cancelRefreshBtn');
            if (cancelBtn) cancelBtn.style.display = disabled ? 'inline-flex' : 'none';
            // Toggle refresh button visibility (hide when refreshing)
            const refreshBtn = document.getElementById('refreshBtn');
            if (refreshBtn) refreshBtn.style.display = disabled ? 'none' : 'inline-flex';
          }

          // ── Progress Banner Management ──
          let refreshToastTimeout = null;

          function showProgressBanner(totalAccounts = 0) {
            // Clear any existing toast
            const toast = document.getElementById('refreshToast');
            if (toast) { toast.classList.remove('visible'); }
            if (refreshToastTimeout) { clearTimeout(refreshToastTimeout); refreshToastTimeout = null; }
            
            // Initialize count display
            const countEl = document.getElementById('refreshProgressCount');
            if (countEl) countEl.textContent = '0 / ' + totalAccounts;
            
            const banner = document.getElementById('refreshProgressBanner');
            if (banner) banner.classList.add('visible');
          }

          function updateProgressBanner(email, currentIndex, totalAccounts) {
            const emailEl = document.getElementById('refreshProgressEmail');
            const percentEl = document.getElementById('refreshProgressPercent');
            const countEl = document.getElementById('refreshProgressCount');
            const barEl = document.getElementById('refreshProgressBar');
            
            const percent = totalAccounts > 0 ? Math.round((currentIndex / totalAccounts) * 100) : 0;
            
            if (emailEl) emailEl.innerHTML = '<span class="refresh-label">${i18n.t('accounts.refreshingAccount')}: </span>' + email;
            if (percentEl) percentEl.textContent = percent + '%';
            if (countEl) countEl.textContent = currentIndex + ' / ' + totalAccounts;
            if (barEl) barEl.style.width = percent + '%';
          }

          function hideProgressBanner(wasCancelled) {
            const banner = document.getElementById('refreshProgressBanner');
            if (banner) banner.classList.remove('visible');

            // Show success toast only if not cancelled
            if (!wasCancelled) {
              const toast = document.getElementById('refreshToast');
              if (toast) {
                toast.textContent = '${i18n.t('accounts.refreshSuccess')}';
                toast.classList.add('visible');
                refreshToastTimeout = setTimeout(() => {
                  toast.classList.remove('visible');
                  refreshToastTimeout = null;
                }, 4000);
              }
            }
          }

          window.addEventListener('message', event => {
            const msg = event.data;

            if (msg.command === 'refreshStarted') {
              isRefreshing = true;
              setActionsDisabled(true);
              setSearchDisabled(true);
              showProgressBanner(msg.totalAccounts);

            } else if (msg.command === 'accountRefreshStart') {
              updateProgressBanner(msg.email, msg.currentIndex, msg.totalAccounts);
              const card = document.querySelector('.account-card[data-email="' + msg.email + '"]');
              if (card) {
                card.classList.add('refreshing');
              }

            } else if (msg.command === 'accountRefreshDone') {
              const oldCard = document.querySelector('.account-card[data-email="' + msg.email + '"]');
              if (oldCard && msg.html) {
                const parser = new DOMParser();
                const doc = parser.parseFromString(msg.html, 'text/html');
                const newCard = doc.querySelector('.account-card');
                
                if (newCard) {
                  // Preserve collapse expanded state
                  const oldWrapper = oldCard.querySelector('.collapsible-wrapper');
                  const newWrapper = newCard.querySelector('.collapsible-wrapper');
                  if (oldWrapper && newWrapper && oldWrapper.classList.contains('expanded')) {
                    newWrapper.classList.add('expanded');
                  }
                  
                  const oldHeader = oldCard.querySelector('.collapse-header');
                  const newHeader = newCard.querySelector('.collapse-header');
                  if (oldHeader && newHeader && oldHeader.classList.contains('expanded')) {
                    newHeader.classList.add('expanded');
                  }

                  // Replace oldCard with newCard in the DOM
                  oldCard.replaceWith(newCard);
                  
                  // Initialize the model container's originalOrder on the new card
                  const container = newCard.querySelector('.models-container');
                  if (container) {
                    container.originalOrder = Array.from(container.children);
                  }
                  
                  // Apply active model styling to the new card
                  const email = newCard.dataset.email;
                  const activeModelKey = state.activeModels[email];
                  if (activeModelKey && container) {
                    container.innerHTML = '';
                    container.originalOrder.forEach(el => {
                       el.classList.remove('active-model');
                       container.appendChild(el);
                    });
                    
                    const preferredHeader = newCard.querySelector('.preferred-model-card');
                    if (preferredHeader) {
                       preferredHeader.classList.remove('active-model');
                    }
                    
                    const targetModel = container.querySelector('.model-card[data-model-key="' + activeModelKey + '"]');
                    if (targetModel) {
                       container.prepend(targetModel);
                       targetModel.classList.add('active-model');
                    } else if (preferredHeader && preferredHeader.dataset.modelKey === activeModelKey) {
                       preferredHeader.classList.add('active-model');
                    }
                  }
                }
              }

            } else if (msg.command === 'refreshFinished') {
              isRefreshing = false;
              setActionsDisabled(false);
              setSearchDisabled(false);
              // Dismiss cancel dialog if still open (refresh finished naturally)
              dismissCancelConfirm();
              hideProgressBanner(!!msg.wasCancelled);
              // Remove refreshing class from all cards
              document.querySelectorAll('.account-card').forEach(c => {
                c.classList.remove('refreshing');
              });

            } else if (msg.command === 'showLoading') {
              const overlay = document.getElementById('loadingOverlay');
              const text = document.getElementById('loadingText');
              if (overlay) overlay.style.display = 'flex';
              if (text && msg.text) text.innerText = msg.text;

            } else if (msg.command === 'hideLoading') {
              const overlay = document.getElementById('loadingOverlay');
              if (overlay) overlay.style.display = 'none';
            }
          });
        </script>
      </body>
      </html>
    `;
  }

  // ── Helper Methods for Preferred Model Resolution & Sorting ──

  /**
   * Applies the exact same filtering/merging pipeline as the UI to extract the final model keys.
   */
  private extractFilteredModelKeys(balances: Record<string, any> | undefined): string[] {
    if (!balances) return [];

    const allModelEntries: Array<{ key: string, lowerKey: string, value: number, resetTime?: string }> = [];

    for (const [k, rawV] of Object.entries(balances)) {
      if (!k) continue;
      const lowerKey = k.toLowerCase();
      let value: number;
      let resetTime: string | undefined;

      if (typeof rawV === 'object' && rawV !== null && 'value' in rawV) {
        const obj = rawV as any;
        value = typeof obj.value === 'number' ? obj.value : Number(obj.value);
        resetTime = obj.resetTime;
      } else {
        continue; // Skip credits
      }
      allModelEntries.push({ key: k, lowerKey, value, resetTime });
    }

    // Phase 1: Exclude by prefix (chat*, tap*, tab*)
    const afterPrefixFilter = allModelEntries.filter(m => {
      return !m.lowerKey.startsWith('chat')
          && !m.lowerKey.startsWith('tap')
          && !m.lowerKey.startsWith('tab');
    });

    // Phase 2: Exclude gemini-2.5
    const afterGeminiFilter = afterPrefixFilter.filter(m => !m.lowerKey.includes('gemini-2.5'));

    // Phase 3: Unconditional exclusion of "lite" models
    const afterLiteFilter = afterGeminiFilter.filter(m => !m.lowerKey.match(/[-_\s]?lite$/i));

    // Phase 4: Apply friendly names, filter out deprecated keys, and deduplicate by friendly name
    const friendlyKeys = new Set<string>();
    for (const entry of afterLiteFilter) {
      const friendlyName = getFriendlyModelName(entry.key);
      if (friendlyName) {
        friendlyKeys.add(friendlyName);
      }
    }
    return Array.from(friendlyKeys);
  }

  /**
   * Finds the newest Claude model key from a list of keys.
   */
  private findNewestClaudeKey(keys: string[]): string | undefined {
    const claudeKeys = keys.filter(k => k.toLowerCase().includes('claude'));
    if (claudeKeys.length === 0) return undefined;

    return claudeKeys.sort((a, b) => {
      // Extract numbers to compare versions (e.g. 4-6 vs 3-5)
      const aMatch = a.match(/\d+(?:[.-]\d+)*/);
      const bMatch = b.match(/\d+(?:[.-]\d+)*/);
      
      if (!aMatch && !bMatch) return a.localeCompare(b);
      if (!aMatch) return 1;
      if (!bMatch) return -1;
      
      // Basic string comparison of versions works well enough for X-Y format
      return bMatch[0].localeCompare(aMatch[0]);
    })[0];
  }

  /**
   * Extracts the balance value of a specific model from the raw balances object.
   * Handles "claude-{version}-All" mapping by finding a matching base version.
   */
  private getModelBalanceValue(balances: Record<string, any> | undefined, targetKey: string): number {
    if (!balances) return -1; // -1 ensures accounts without the model are sorted last
    
    const lowerTarget = targetKey.toLowerCase();
    
    // Direct match check by comparing friendly names
    for (const [k, v] of Object.entries(balances)) {
      if (!k) continue;
      const friendlyName = getFriendlyModelName(k);
      if (friendlyName && friendlyName.toLowerCase() === lowerTarget) {
        return typeof v === 'object' && v !== null && 'value' in v ? v.value : -1;
      }
    }

    // Handle Claude version match (e.g. Claude 4.6 (Thinking))
    if (lowerTarget.startsWith('claude ') && lowerTarget.endsWith(' (thinking)')) {
      const targetVersion = lowerTarget.replace('claude ', '').replace(' (thinking)', '');
      for (const [k, v] of Object.entries(balances)) {
        if (!k || !k.toLowerCase().includes('claude')) continue;
        const friendlyName = getFriendlyModelName(k);
        if (friendlyName && friendlyName.toLowerCase().includes(` ${targetVersion} `)) {
          return typeof v === 'object' && v !== null && 'value' in v ? v.value : -1;
        }
      }
    }

    return -1; // Model not found
  }

  /**
   * Sorts the accounts array based on active status, preferred model balance, renewal countdown, and alphabetical name.
   */
  private sortAccounts(accounts: any[], effectivePreferred: string, pinnedEmailLower: string | null): void {
    const sortBy = ExtensionConfig.getInstance().getSortBy();

    // Helper: compute remaining usable quota percentage (0-100)
    const getAccountQuotaValue = (acc: any): number => {
      if (!acc.balances) return 0;
      if (acc.status === AccountStatus.DEPLETED || acc.status === AccountStatus.TOKEN_EXPIRED || acc.status === AccountStatus.ERROR || acc.status === AccountStatus.INELIGIBLE) {
        return 0;
      }

      // 1. If preferred model is set and matches an active model, return its value
      if (effectivePreferred) {
        for (const [k, rawV] of Object.entries(acc.balances)) {
          const lower = k.toLowerCase();
          if (lower.startsWith('chat') || lower.startsWith('tab') || lower.startsWith('tap')) continue;
          if (lower.includes(effectivePreferred.toLowerCase()) || effectivePreferred.toLowerCase().includes(lower)) {
            const val = typeof rawV === 'object' && rawV !== null ? Number((rawV as any).value) : Number(rawV);
            if (!isNaN(val)) return val;
          }
        }
      }

      // 2. Primary Gemini model keys
      const primaryKeys = [
        'gemini-3.7-flash-tiered',
        'gemini-3.7-flash',
        'gemini-3.5-flash-high',
        'gemini-3.6-flash-high',
        'gemini-3.5-flash-medium',
        'gemini-3.5-flash-low',
        'gemini-3.1-pro-high',
        'gemini-3.1-pro-low'
      ];

      for (const pk of primaryKeys) {
        if (acc.balances[pk] !== undefined) {
          const rawV = acc.balances[pk];
          const val = typeof rawV === 'object' && rawV !== null ? Number((rawV as any).value) : Number(rawV);
          if (!isNaN(val)) return val;
        }
      }

      return 0;
    };

    // Helper: compute soonest remaining time until renewal in ms (0 = ready now or already passed)
    const getAccountNextRegenTime = (acc: any): number => {
      if (!acc.balances) return Infinity;
      const primaryKeys = [
        'gemini-3.7-flash-tiered',
        'gemini-3.7-flash',
        'gemini-3.5-flash-high',
        'gemini-3.6-flash-high',
        'gemini-3.5-flash-medium',
        'gemini-3.5-flash-low',
        'gemini-3.1-pro-high',
        'gemini-3.1-pro-low'
      ];

      let minTime = Infinity;
      for (const pk of primaryKeys) {
        const rawV = acc.balances[pk];
        if (typeof rawV === 'object' && rawV !== null && (rawV as any).resetTime) {
          const resetTimeStr = (rawV as any).resetTime;
          const date = new Date(resetTimeStr);
          const time = date.getTime();
          if (!isNaN(time)) {
            const diffMs = time - Date.now();
            const effectiveDiff = diffMs <= 0 ? 0 : diffMs;
            if (effectiveDiff < minTime) {
              minTime = effectiveDiff;
            }
          }
        }
      }

      if (minTime !== Infinity) return minTime;

      for (const [k, rawV] of Object.entries(acc.balances)) {
        const lower = k.toLowerCase();
        if (lower.startsWith('chat') || lower.startsWith('tab') || lower.startsWith('tap') || lower.includes('claude') || lower.includes('gpt')) continue;
        if (typeof rawV === 'object' && rawV !== null && (rawV as any).resetTime) {
          const resetTimeStr = (rawV as any).resetTime;
          const date = new Date(resetTimeStr);
          const time = date.getTime();
          if (!isNaN(time)) {
            const diffMs = time - Date.now();
            const effectiveDiff = diffMs <= 0 ? 0 : diffMs;
            if (effectiveDiff < minTime) {
              minTime = effectiveDiff;
            }
          }
        }
      }
      return minTime;
    };

    // Status weight: Active/Low balance first, Depleted next, Expired/Error last
    const getStatusWeight = (status: AccountStatus) => {
      switch (status) {
        case AccountStatus.ACTIVE: return 0;
        case AccountStatus.LOW_BALANCE: return 1;
        case AccountStatus.DEPLETED: return 2;
        case AccountStatus.TOKEN_EXPIRED: return 3;
        case AccountStatus.ERROR: return 4;
        case AccountStatus.INELIGIBLE: return 5;
        default: return 6;
      }
    };

    accounts.sort((a, b) => {
      // 1. Pinned active account always goes first
      const aActive = pinnedEmailLower !== null && a.email.toLowerCase() === pinnedEmailLower;
      const bActive = pinnedEmailLower !== null && b.email.toLowerCase() === pinnedEmailLower;
      if (aActive && !bActive) return -1;
      if (!aActive && bActive) return 1;

      switch (sortBy) {
        case 'name-asc': {
          const nameA = a.displayName || a.alias || a.name || a.email || '';
          const nameB = b.displayName || b.alias || b.name || b.email || '';
          return nameA.localeCompare(nameB, undefined, { numeric: true, sensitivity: 'base' });
        }
        case 'name-desc': {
          const nameA = a.displayName || a.alias || a.name || a.email || '';
          const nameB = b.displayName || b.alias || b.name || b.email || '';
          return nameB.localeCompare(nameA, undefined, { numeric: true, sensitivity: 'base' });
        }
        case 'email-asc': {
          const emailA = a.email || '';
          const emailB = b.email || '';
          return emailA.localeCompare(emailB, undefined, { numeric: true, sensitivity: 'base' });
        }
        case 'email-desc': {
          const emailA = a.email || '';
          const emailB = b.email || '';
          return emailB.localeCompare(emailA, undefined, { numeric: true, sensitivity: 'base' });
        }
        case 'date-added': {
          const dateA = a.addedAt ? new Date(a.addedAt).getTime() : 0;
          const dateB = b.addedAt ? new Date(b.addedAt).getTime() : 0;
          if (dateA !== dateB) return dateB - dateA; // Newest first
          break;
        }
        case 'quota': {
          const aQuota = getAccountQuotaValue(a);
          const bQuota = getAccountQuotaValue(b);
          if (aQuota !== bQuota) {
            return bQuota - aQuota; // Descending (highest remaining quota first)
          }
          // On tie (e.g. both 0% or both 100%), sort by soonest renewal time
          const aTime = getAccountNextRegenTime(a);
          const bTime = getAccountNextRegenTime(b);
          if (aTime !== bTime) {
            return aTime - bTime; // Ascending (soonest first)
          }
          break;
        }
        case 'quota-regen': {
          const aTime = getAccountNextRegenTime(a);
          const bTime = getAccountNextRegenTime(b);
          if (aTime !== bTime) {
            return aTime - bTime; // Ascending (soonest first)
          }
          // On tie, sort by highest remaining quota
          const aQuota = getAccountQuotaValue(a);
          const bQuota = getAccountQuotaValue(b);
          if (aQuota !== bQuota) {
            return bQuota - aQuota;
          }
          break;
        }
        case 'default':
        default: {
          // 1. Separate accounts with available quota (> 0%) from accounts with 0% / depleted
          const aQuota = getAccountQuotaValue(a);
          const bQuota = getAccountQuotaValue(b);
          const aHasQuota = aQuota > 0 && (a.status === AccountStatus.ACTIVE || a.status === AccountStatus.LOW_BALANCE);
          const bHasQuota = bQuota > 0 && (b.status === AccountStatus.ACTIVE || b.status === AccountStatus.LOW_BALANCE);

          if (aHasQuota && !bHasQuota) return -1;
          if (!aHasQuota && bHasQuota) return 1;

          // If BOTH have quota > 0: sort by quota descending (highest first)
          if (aHasQuota && bHasQuota) {
            if (aQuota !== bQuota) {
              return bQuota - aQuota;
            }
            // On tie with same quota (e.g. both 100%), sort by renewal time ascending (soonest to recharge first)
            const aTime = getAccountNextRegenTime(a);
            const bTime = getAccountNextRegenTime(b);
            if (aTime !== bTime) {
              return aTime - bTime;
            }
          }

          // If BOTH have 0% / depleted quota:
          // Check if either is an expired / error / ineligible account vs just depleted
          const aWeight = getStatusWeight(a.status);
          const bWeight = getStatusWeight(b.status);
          const aIsBroken = aWeight >= 3;
          const bIsBroken = bWeight >= 3;

          if (!aIsBroken && bIsBroken) return -1;
          if (aIsBroken && !bIsBroken) return 1;

          // For normal depleted accounts (0%): sort strictly by renewal countdown ascending (soonest to recharge first!)
          if (!aIsBroken && !bIsBroken) {
            const aTime = getAccountNextRegenTime(a);
            const bTime = getAccountNextRegenTime(b);
            if (aTime !== bTime) {
              return aTime - bTime; // Soonest to recharge first
            }
          }

          if (aWeight !== bWeight) {
            return aWeight - bWeight;
          }
          break;
        }
      }

      // Final tie-breaker: Alphabetical by display name / email
      const nameA = a.displayName || a.alias || a.name || a.email || '';
      const nameB = b.displayName || b.alias || b.name || b.email || '';
      return nameA.localeCompare(nameB, undefined, { numeric: true, sensitivity: 'base' });
    });
  }

  /**
   * Renders the HTML template for a single account card.
   */
  private renderAccountCard(acc: any, effectivePreferred: string): string {
    const i18n = I18nService.getInstance();
    const displayName = acc.alias || acc.name || acc.displayName || acc.email;
    
    const formatTime = (resetTimeStr?: string) => {
       if (!resetTimeStr) return i18n.t('webview.unspecified');
       const date = new Date(resetTimeStr);
       const diffMs = date.getTime() - Date.now();
       if (diffMs <= 0) return i18n.t('webview.availableNow');
       
       const totalHours = Math.floor(diffMs / (1000 * 60 * 60));
       const mins = Math.floor((diffMs % (1000 * 60 * 60)) / (1000 * 60));
       
       if (totalHours >= 24) {
         const days = Math.floor(totalHours / 24);
         const remainingHours = totalHours % 24;
         if (remainingHours === 0) {
           return i18n.t('webview.renewsInDaysMins', { days, mins });
         }
         return i18n.t('webview.renewsInDaysHoursMins', { days, hours: remainingHours, mins });
       }
       
       return i18n.t('webview.renewsInHoursMins', { hours: totalHours, mins });
    };

    // Find the next reset time among primary models (Gemini Flash/Pro)
    let nextResetTime: string | undefined = undefined;
    let minDiffMs = Infinity;

    if (acc.balances) {
      const primaryKeys = [
        'gemini-3.7-flash-tiered',
        'gemini-3.7-flash',
        'gemini-3.5-flash-high',
        'gemini-3.6-flash-high',
        'gemini-3.5-flash-medium',
        'gemini-3.5-flash-low',
        'gemini-3.1-pro-high',
        'gemini-3.1-pro-low'
      ];

      for (const pk of primaryKeys) {
        const rawV = acc.balances[pk];
        if (typeof rawV === 'object' && rawV !== null && (rawV as any).resetTime) {
          const resetTimeStr = (rawV as any).resetTime as string;
          if (resetTimeStr) {
            const date = new Date(resetTimeStr);
            const time = date.getTime();
            if (!isNaN(time)) {
              const diffMs = time - Date.now();
              const effDiff = diffMs <= 0 ? 0 : diffMs;
              if (effDiff < minDiffMs) {
                minDiffMs = effDiff;
                nextResetTime = resetTimeStr;
              }
            }
          }
        }
      }

      if (!nextResetTime) {
        for (const [k, rawV] of Object.entries(acc.balances)) {
          const lower = k.toLowerCase();
          if (lower.startsWith('chat') || lower.startsWith('tab') || lower.startsWith('tap') || lower.includes('claude') || lower.includes('gpt')) continue;
          if (typeof rawV === 'object' && rawV !== null && 'resetTime' in rawV) {
            const resetTimeStr = (rawV as any).resetTime as string;
            if (resetTimeStr) {
              const date = new Date(resetTimeStr);
              const time = date.getTime();
              if (!isNaN(time)) {
                const diffMs = time - Date.now();
                const effDiff = diffMs <= 0 ? 0 : diffMs;
                if (effDiff < minDiffMs) {
                  minDiffMs = effDiff;
                  nextResetTime = resetTimeStr;
                }
              }
            }
          }
        }
      }
    }

    const nextResetHtml = nextResetTime 
      ? `<div class="quota-countdown" style="font-size:0.75rem; color:var(--text-secondary); opacity:0.85; margin-top:3px; display:flex; align-items:center; gap:4px;">
           <svg class="icon-svg" style="width:11px; height:11px; stroke-width:2.5;" viewBox="0 0 24 24" fill="none" stroke="currentColor"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
           <span>${formatTime(nextResetTime)}</span>
         </div>`
      : '';

    // Process balances according to display rules
    let processedModels: Array<{ key: string, value: number, resetTime?: string }> = [];
    let creditBalances: Array<{ key: string, value: number }> = [];
    
    if (acc.balances) {
      // ── Collect all model entries, separate credits from models ──
      const allModelEntries: Array<{ key: string, lowerKey: string, value: number, resetTime?: string }> = [];

      for (const [k, rawV] of Object.entries(acc.balances)) {
        if (!k) continue;
        const lowerKey = k.toLowerCase();
        
        let value: number;
        let resetTime: string | undefined;
        
        if (typeof rawV === 'object' && rawV !== null && 'value' in rawV) {
           const obj = rawV as any;
           value = typeof obj.value === 'number' ? obj.value : Number(obj.value);
           resetTime = obj.resetTime;
        } else {
           value = typeof rawV === 'number' ? rawV : Number(rawV);
           if (value > 0) {
             creditBalances.push({ key: k, value });
           }
           continue;
        }

        allModelEntries.push({ key: k, lowerKey, value, resetTime });
      }

      // ── Phase 1 (FIRST exclusion): Remove models by prefix ──
      const afterPrefixFilter = allModelEntries.filter(m => {
        return !m.lowerKey.startsWith('chat')
            && !m.lowerKey.startsWith('tap')
            && !m.lowerKey.startsWith('tab');
      });

      // ── Phase 2: Exclude gemini-2.5 ──
      const afterGeminiFilter = afterPrefixFilter.filter(m => !m.lowerKey.includes('gemini-2.5'));

      // ── Phase 3: Unconditional exclusion of "lite" models ──
      const afterLiteFilter = afterGeminiFilter.filter(m => !m.lowerKey.match(/[-_\s]?lite$/i));

      // ── Phase 4: Apply friendly names, filter out deprecated keys, and deduplicate by friendly name ──
      const friendlyModelMap = new Map<string, { key: string, value: number, resetTime?: string }>();
      for (const entry of afterLiteFilter) {
        const friendlyName = getFriendlyModelName(entry.key);
        if (friendlyName) {
          if (!friendlyModelMap.has(friendlyName)) {
            friendlyModelMap.set(friendlyName, { key: friendlyName, value: entry.value, resetTime: entry.resetTime });
          }
        }
      }
      processedModels = Array.from(friendlyModelMap.values());
    }

    // Sort processedModels
    processedModels.sort((a, b) => {
       const aCritical = a.value < 20;
       const bCritical = b.value < 20;
       
       const timeA = a.resetTime ? new Date(a.resetTime).getTime() : 0;
       const timeB = b.resetTime ? new Date(b.resetTime).getTime() : 0;
       
       if (aCritical && !bCritical) return 1; // b is better (>= 20%), put a lower
       if (!aCritical && bCritical) return -1;
       
       if (aCritical && bCritical) {
          if (timeA && timeB && timeA !== timeB) return timeA - timeB;
          return a.value - b.value;
       }
       
       if (a.value !== b.value) return b.value - a.value;
       if (timeA && timeB) return timeA - timeB;
       return 0;
    });

    // Move preferred model to top of the list if set
    let preferredModelData: { key: string, value: number, resetTime?: string } | null = null;
    if (effectivePreferred) {
      const normalizedPref = normalizeModelKey(effectivePreferred).toLowerCase();
      let prefIdx = processedModels.findIndex(m =>
        m.key.toLowerCase() === normalizedPref ||
        m.key.toLowerCase() === effectivePreferred.toLowerCase()
      );
      if (prefIdx === -1) {
        prefIdx = processedModels.findIndex(m => {
          const k = m.key.toLowerCase();
          return k.includes(normalizedPref) || normalizedPref.includes(k) ||
                 k.replace(/\s+/g, '') === normalizedPref.replace(/\s+/g, '');
        });
      }
      if (prefIdx > -1) {
        const [prefModel] = processedModels.splice(prefIdx, 1);
        preferredModelData = prefModel;
      } else if (processedModels.length > 0) {
        preferredModelData = processedModels[0];
      }
    } else if (processedModels.length > 0) {
      preferredModelData = processedModels[0];
    }

    // Generate Credits HTML
    const creditsHtml = creditBalances.length > 0 
      ? `<div class="credits-container">` + creditBalances.map(c => `
        <div class="credit-badge">
          <span class="credit-name">${c.key.replace(/_/g, ' ').toUpperCase()}</span>
          <span class="credit-value">${c.value.toLocaleString()}</span>
        </div>
      `).join('') + `</div>`
      : '';

    // Generate Models HTML
    const modelsHtml = processedModels.length > 0
      ? processedModels.map(m => {
          const displayKey = m.key.endsWith('image')
            ? `${m.key} <svg class="icon-svg icon-image" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>`
            : m.key;
          const timeStr = formatTime(m.resetTime);
          
          let colorClass = 'bg-high';
          let alertIcon = '';
          
          if (m.value < 20) {
              colorClass = 'bg-low';
              alertIcon = ` <svg class="icon-svg icon-warning" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" title="${i18n.t('webview.veryLowBalance')}"><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>`;
          } else if (m.value < 32) {
              colorClass = 'bg-low';
          } else if (m.value < 60) {
              colorClass = 'bg-med';
          }

          return `
          <div class="model-card" data-model-key="${m.key}" onclick="selectModel(this, '${acc.email}', '${m.key}')" style="cursor: pointer;" title="${i18n.t('webview.selectThisModel')}">
            <div class="model-header">
              <span class="model-name">${displayKey}</span>
              <span class="model-reset">${timeStr}</span>
            </div>
            <div class="progress-bar-container">
              <div class="progress-bar ${colorClass}" style="width: ${m.value}%"></div>
            </div>
            <div class="model-percentage ${colorClass}-text">${m.value}%${alertIcon}</div>
          </div>
          `;
        }).join('')
      : `<div class="empty-models">${i18n.t('accounts.noAvailableModels')}</div>`;

    // Generate Collapse Header HTML
    let collapseHeaderHtml = '';
    const wrapperId = `collapse-${acc.email.replace(/[@.]/g, '-')}`;
    
    if (preferredModelData) {
       const displayKey = preferredModelData.key.endsWith('image')
         ? `${preferredModelData.key} <svg class="icon-svg icon-image" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>`
         : preferredModelData.key;
       const timeStr = formatTime(preferredModelData.resetTime);
       
       let colorClass = 'bg-high';
       let alertIcon = '';
       
       if (preferredModelData.value < 20) {
           colorClass = 'bg-low';
           alertIcon = ` <svg class="icon-svg icon-warning" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" title="${i18n.t('webview.veryLowBalance')}"><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>`;
       } else if (preferredModelData.value < 32) {
           colorClass = 'bg-low';
       } else if (preferredModelData.value < 60) {
           colorClass = 'bg-med';
       }

       collapseHeaderHtml = `
       <div class="collapse-header unified-collapse" onclick="toggleModels(this, '${wrapperId}')" title="${i18n.t('webview.showAvailableModels')}">
          <span class="collapse-title">${i18n.t('accounts.models')}</span>
          <div class="collapse-header-right">
             <div class="pref-badge preferred-model-card" data-model-key="${preferredModelData.key}" onclick="event.stopPropagation(); selectModel(this, '${acc.email}', '${preferredModelData.key}')" title="${i18n.t('webview.activatePreferredModel')}">
               <span class="pref-badge-name">${displayKey}</span>
               <div class="pref-badge-bar"><div class="progress-bar ${colorClass}" style="width: ${preferredModelData.value}%"></div></div>
               <span class="pref-badge-val ${colorClass}-text">${preferredModelData.value}%${alertIcon}</span>
             </div>
             <svg class="chevron-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>
          </div>
       </div>
       `;
    } else {
       collapseHeaderHtml = `
       <div class="collapse-header normal-collapse" onclick="toggleModels(this, '${wrapperId}')" title="${i18n.t('webview.showAvailableModels')}">
          <span class="collapse-title">${i18n.t('accounts.availableModels', { count: processedModels.length })}</span>
          <svg class="chevron-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>
       </div>
       `;
    }

    const isExpired = acc.status === AccountStatus.TOKEN_EXPIRED;
    const isIneligible = acc.status === AccountStatus.INELIGIBLE;
    const activeBadge = acc.isActive
      ? `<div class="badge active-badge">${i18n.t('accounts.active')}</div>`
      : isExpired
        ? `<div class="badge expired-badge">${i18n.t('accounts.expired')}</div>`
        : isIneligible
          ? `<div class="badge ineligible-badge">${i18n.t('accounts.status.ineligible')}</div>`
          : '';

    const expiredBannerHtml = isExpired ? `
      <div class="expired-banner">
        <span class="expired-banner-icon"><svg class="icon-svg icon-warning" style="width: 16px; height: 16px;" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg></span>
        <span class="expired-banner-text">${i18n.t('accounts.expiredBanner')}</span>
      </div>
    ` : '';

    const ineligibleBannerHtml = isIneligible ? `
      <div class="ineligible-banner">
        <span class="ineligible-banner-icon"><svg class="icon-svg icon-error" style="width: 16px; height: 16px;" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="4.93" y1="4.93" x2="19.07" y2="19.07"/></svg></span>
        <span class="ineligible-banner-text">${i18n.t('accounts.ineligibleBanner')}</span>
      </div>
    ` : '';

    const cardBody = isExpired
      ? expiredBannerHtml
      : isIneligible
        ? ineligibleBannerHtml
        : `
        ${creditsHtml}
        
        <div class="models-section">
          ${collapseHeaderHtml}
          <div class="collapsible-wrapper" id="${wrapperId}">
            <div class="collapsible-inner">
              <div class="models-container">
                ${modelsHtml}
              </div>
            </div>
          </div>
        </div>
    `;

    let actionsHtml = '';
    if (isExpired) {
      actionsHtml = `
        <button class="btn btn-warning" onclick="sendMessage('reAuthenticate', '${acc.email}')">${i18n.t('accounts.reAuthenticate')}</button>
        <button class="btn btn-danger" onclick="sendMessage('deleteAccount', '${acc.email}')">${i18n.t('accounts.remove')}</button>
      `;
    } else if (isIneligible) {
      actionsHtml = `
        <button class="btn btn-danger" onclick="sendMessage('deleteAccount', '${acc.email}')">${i18n.t('accounts.remove')}</button>
      `;
    } else {
      actionsHtml = `
        ${!acc.isActive ? `<button class="btn btn-primary" onclick="handleSwitchAccount(this, '${acc.email}')">${i18n.t('accounts.activate')}</button>` : ''}
        <button class="btn btn-danger" onclick="sendMessage('deleteAccount', '${acc.email}')">${i18n.t('accounts.remove')}</button>
      `;
    }

    const avatarClass = isExpired ? 'avatar-expired' : isIneligible ? 'avatar-ineligible' : '';
    const safeEmailId = acc.email.replace(/[@.]/g, '-');

    const modelBalancesMap: Record<string, number> = {};
    if (processedModels) {
      processedModels.forEach(m => {
        modelBalancesMap[m.key.toLowerCase()] = m.value;
      });
    }
    if (preferredModelData) {
      modelBalancesMap[preferredModelData.key.toLowerCase()] = preferredModelData.value;
    }
    const modelBalancesStr = JSON.stringify(modelBalancesMap).replace(/'/g, '&apos;');

    return `
      <div class="account-card ${acc.isActive ? 'active' : ''} ${isExpired ? 'expired' : ''} ${isIneligible ? 'ineligible' : ''} ${acc.status === AccountStatus.DEPLETED ? 'depleted' : ''}" data-email="${acc.email}" data-name="${displayName}" data-alias="${acc.alias || ''}" data-status="${acc.status}" data-model-balances='${modelBalancesStr}'>
        <div class="card-header">
          ${acc.avatarUrl ? `<img class="avatar ${avatarClass}" src="${acc.avatarUrl}" alt="${displayName}" />` : `<div class="avatar ${avatarClass}">${displayName.charAt(0).toUpperCase()}</div>`}
          <div class="user-info">
            <div class="name-container" style="display:flex; align-items:center; gap:6px;">
              <h4 class="display-name-text" id="name-display-${safeEmailId}" style="margin: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 150px;">${displayName}</h4>
              <input type="text" class="edit-alias-input" id="name-input-${safeEmailId}" value="${acc.alias || ''}" placeholder="${i18n.t('webview.editAliasPlaceholder')}" style="display:none; padding:2px 6px; font-size:0.9em; font-family:inherit; background:var(--vscode-input-background); color:var(--vscode-input-foreground); border:1px solid var(--vscode-input-border); border-radius:3px; max-width:130px;" onkeydown="handleAliasKey(event, '${acc.email}')" onblur="saveAlias('${acc.email}')" />
              <button class="edit-alias-btn" id="edit-btn-${safeEmailId}" onclick="startEditAlias('${acc.email}')" title="${i18n.t('webview.editAliasTooltip')}" style="background:none; border:none; padding:2px; cursor:pointer; color:var(--text-secondary); opacity:0.6; display:flex; align-items:center;">
                <svg class="icon-svg" style="width:13px; height:13px;" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>
              </button>
              <button class="btn-card-refresh" id="refresh-btn-${safeEmailId}" onclick="event.stopPropagation(); handleSingleRefresh(this, '${acc.email}')" title="${i18n.t('accounts.refreshThisAccount')}">
                <svg class="icon-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21.5 2v6h-6"/><path d="M21.34 15.57a10 10 0 1 1-.57-8.38l5.67-5.67"/></svg>
              </button>
            </div>
            <p>${acc.email}</p>
            ${nextResetHtml}
          </div>
          ${activeBadge}
        </div>
        
        ${cardBody}

        <div class="card-actions">
          ${actionsHtml}
        </div>
      </div>
    `;
  }
}
