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
import { getFriendlyModelName } from '../../core/utils/model.utils';
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
  public static readonly viewType = 'antigravity-hub.accountsView';
  private _view?: vscode.WebviewView;

  /**
   * Cached email of the account pinned by detectAndPinActiveAccount().
   * null = no account is pinned (either list is empty, logged out, or email not in list).
   * Once set, the post-refresh re-sort will respect this pin and not re-order this account.
   */
  private _pinnedActiveEmail: string | null = null;

  /** Current search query preserved across webview re-renders */
  private _searchQuery: string = '';

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly accountRepo: IAccountRepository,
    private readonly accountService: AccountService
  ) {
    // Automatically re-detect active account and re-render when data changes
    this.accountService.onAccountsChanged(() => {
      this.detectAndPinActiveAccount().then(() => this.refresh());
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
      switch (message.command) {
        case 'addAccount':
          vscode.commands.executeCommand('antigravity-hub.addAccount');
          break;
        case 'switchAccount':
          if (message.email) {
            const confirm = await vscode.window.showWarningMessage(
              i18n.t('accounts.confirmSwitch', { email: message.email }),
              { modal: true },
              i18n.t('common.yes'), i18n.t('common.cancel')
            );
            if (confirm === i18n.t('common.yes')) {
              await this.accountService.switchAccountWorkflow(message.email);
            } else {
              this._view?.webview.postMessage({ command: 'accountSwitchCancelled', email: message.email });
            }
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
          await this.handleProgressiveRefresh(true, message.filteredEmails || undefined);
          break;
        case 'searchChanged':
          this._searchQuery = message.query || '';
          break;
        case 'cancelRefresh':
          if (this._refreshAbortController) {
            this._refreshAbortController.abort();
            this._refreshAbortController = null;
            Logger.getInstance().info('Refresh abort signal sent by user.');
          }
          break;
        case 'switchModel':
          if (message.email && message.modelKey) {
            this._view?.webview.postMessage({ command: 'modelSwitched', email: message.email, modelKey: message.modelKey });
          }
          break;
        case 'exportAccounts':
          await this.handleExport();
          break;
        case 'importAccounts':
          await this.handleImport();
          break;
        case 'saveSettings':
          if (message.preferredModel !== undefined) {
            await this.accountRepo.setPreferredModel(message.preferredModel);
          }
          if (message.autoRefreshEnabled !== undefined) {
            await vscode.workspace.getConfiguration('antigravityHub').update('autoRefreshEnabled', message.autoRefreshEnabled, vscode.ConfigurationTarget.Global);
          }
          if (message.autoRotateEnabled !== undefined) {
            await vscode.workspace.getConfiguration('antigravityHub').update('autoRotateEnabled', message.autoRotateEnabled, vscode.ConfigurationTarget.Global);
          }
          if (message.refreshIntervalMinutes !== undefined) {
            await vscode.workspace.getConfiguration('antigravityHub').update('refreshIntervalMinutes', message.refreshIntervalMinutes, vscode.ConfigurationTarget.Global);
          }
          if (message.language !== undefined) {
            const currentLang = vscode.workspace.getConfiguration('antigravityHub').get<string>('language');
            if (currentLang !== message.language) {
              await vscode.workspace.getConfiguration('antigravityHub').update('language', message.language, vscode.ConfigurationTarget.Global);
              // Give VS Code a moment to apply the config change and trigger the listener
              setTimeout(() => {
                this.refresh();
              }, 150);
            } else {
              this.refresh();
            }
          } else {
            this.refresh();
          }
          break;
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
      this._view.webview.html = await this._getHtmlForWebview(this._view.webview);
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
  private async handleProgressiveRefresh(notify: boolean = true, onlyEmails?: string[]): Promise<void> {
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

    // Create abort controller for this refresh cycle
    this._refreshAbortController = new AbortController();
    const signal = this._refreshAbortController.signal;

    // Tell webview to disable all buttons and show progress banner
    this._view?.webview.postMessage({ command: 'refreshStarted', totalAccounts });

    try {
      await this.accountService.refreshBalancesWorkflow(notify, {
        signal,
        orderedEmails,
        onlyEmails,
        onAccountStart: (email: string) => {
          currentIndex++;
          this._view?.webview.postMessage({ command: 'accountRefreshStart', email, currentIndex, totalAccounts });
        },
        onAccountDone: (email: string, updatedBalances?: Record<string, any>, updatedStatus?: string) => {
          this._view?.webview.postMessage({ command: 'accountRefreshDone', email, balances: updatedBalances, status: updatedStatus });
        },
        onComplete: () => {
          this.refresh();
        }
      });
    } finally {
      this._refreshAbortController = null;
      const wasCancelled = !!signal.aborted;
      this._view?.webview.postMessage({ command: 'refreshFinished', wasCancelled });
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

    const configLanguage = vscode.workspace.getConfiguration('antigravityHub').get<string>('language', 'auto');
    const configAutoRefresh = vscode.workspace.getConfiguration('antigravityHub').get<boolean>('autoRefreshEnabled', true);
    const configAutoRotate = vscode.workspace.getConfiguration('antigravityHub').get<boolean>('autoRotateEnabled', false);
    const configRefreshInterval = vscode.workspace.getConfiguration('antigravityHub').get<number>('refreshIntervalMinutes', 15);
    const accounts = await this.accountRepo.getAccountSummaries();

    // ── Preferred Model Resolution ──
    // Extract available model keys from all accounts with balances (after filtering)
    // and guarantee that standard IDE models are always present in the list.
    const availableModelKeysSet = new Set<string>([
      'Sonnet 4.6',
      'Opus 4.6',
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

    // Normalize legacy names to the new shortened names
    if (preferredModel) {
      const legacyMap: Record<string, string> = {
        'Gemini 3.5 Flash (Low)': '3.5 Flash (Med)',
        'Gemini 3.5 Flash (Medium)': '3.5 Flash (High)',
        'Gemini 3.5 Flash (High)': '3.5 Flash (High)',
        'Gemini 3.1 Pro (Low)': '3.1 Pro (Low)',
        'Gemini 3.1 Pro (High)': '3.1 Pro (High)',
        'GPT-OSS 120B (Medium)': 'GPT-OSS 120B',
        'Claude Sonnet 4.6 (Thinking)': 'Sonnet 4.6',
        'Claude Opus 4.6 (Thinking)': 'Opus 4.6'
      };
      
      const normalized = legacyMap[preferredModel];
      if (normalized) {
        preferredModel = normalized;
        await this.accountRepo.setPreferredModel(normalized); // Migrate in storage
      }
    }

    if (preferredModel === null && availableModelKeys.length > 0) {
      // Auto-detect: find newest Claude model
      preferredModel = this.findNewestClaudeKey(availableModelKeys) || '';
      await this.accountRepo.setPreferredModel(preferredModel);
    }
    const effectivePreferred = preferredModel || '';

    // ── Sort accounts ──
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
      // Process balances according to display rules
      let processedModels: Array<{ key: string, value: number, resetTime?: string }> = [];
      let creditBalances: Array<{ key: string, value: number }> = [];
      
      if (acc.balances) {
        // ── Phase 0: Collect all model entries, separate credits from models ──
        const allModelEntries: Array<{ key: string, lowerKey: string, value: number, resetTime?: string }> = [];

        for (const [k, rawV] of Object.entries(acc.balances)) {
          if (!k) continue;
          const lowerKey = k.toLowerCase();
          
          let value: number;
          let resetTime: string | undefined;
          
          // Structural detection: objects with 'value' property are models (from fetchAvailableModels)
          // Plain numbers are credits (from codeAssist/fetchCredits)
          if (typeof rawV === 'object' && rawV !== null && 'value' in rawV) {
             value = rawV.value;
             resetTime = rawV.resetTime;
          } else {
             // Plain number = credit
             value = typeof rawV === 'number' ? rawV : Number(rawV);
             creditBalances.push({ key: k, value });
             continue;
          }

          allModelEntries.push({ key: k, lowerKey, value, resetTime });
        }

        // ── Phase 1 (FIRST exclusion): Remove models by prefix ──
        // Excludes: chat*, tap*, tab* (but NOT gpt*)
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
            // both < 20%, sort by reset time (shortest first)
            if (timeA && timeB && timeA !== timeB) return timeA - timeB;
            return a.value - b.value; // tie breaker
         }
         
         // both >= 20%, sort by value descending
         if (a.value !== b.value) return b.value - a.value;
         
         // equal value, sort by reset time (shortest first)
         if (timeA && timeB) return timeA - timeB;
         return 0;
      });

      // Move preferred model to top of the list if set, and extract it for the collapse header
      let preferredModelData: { key: string, value: number, resetTime?: string } | null = null;
      if (effectivePreferred) {
        const prefIdx = processedModels.findIndex(m =>
          m.key.toLowerCase() === effectivePreferred.toLowerCase()
        );
        if (prefIdx > -1) {
          const [prefModel] = processedModels.splice(prefIdx, 1);
          preferredModelData = prefModel;
        } else {
          // Preferred model is not present in this account's balances list.
          // Render a placeholder with 0% to represent it at-a-glance.
          preferredModelData = {
            key: effectivePreferred,
            value: 0,
            resetTime: undefined
          };
        }
      }

      // Generate Credits HTML (google_one_ai)
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
            const displayKey = m.key.endsWith('image') ? `${m.key} 🖼️` : m.key;
            const timeStr = formatTime(m.resetTime);
            
            // Determine progress bar color class and alert
            let colorClass = 'bg-high';
            let alertIcon = '';
            
            if (m.value < 20) {
                colorClass = 'bg-low';
                alertIcon = ` <span title="${i18n.t('webview.veryLowBalance')}">❗</span>`;
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
         const displayKey = preferredModelData.key.endsWith('image') ? `${preferredModelData.key} 🖼️` : preferredModelData.key;
         const timeStr = formatTime(preferredModelData.resetTime);
         
         let colorClass = 'bg-high';
         let alertIcon = '';
         
         if (preferredModelData.value < 20) {
             colorClass = 'bg-low';
             alertIcon = ` <span title="${i18n.t('webview.veryLowBalance')}">❗</span>`;
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
               <span class="collapse-icon">▼</span>
            </div>
         </div>
         `;
      } else {
         collapseHeaderHtml = `
         <div class="collapse-header normal-collapse" onclick="toggleModels(this, '${wrapperId}')" title="${i18n.t('webview.showAvailableModels')}">
            <span class="collapse-title">${i18n.t('accounts.availableModels', { count: processedModels.length })}</span>
            <span class="collapse-icon">▼</span>
         </div>
         `;
      }

      const isExpired = acc.status === AccountStatus.TOKEN_EXPIRED;
      const activeBadge = acc.isActive
        ? `<div class="badge active-badge">${i18n.t('accounts.active')}</div>`
        : isExpired
          ? `<div class="badge expired-badge">${i18n.t('accounts.expired')}</div>`
          : '';

      // For expired accounts, show a warning banner instead of models
      const expiredBannerHtml = isExpired ? `
        <div class="expired-banner">
          <span class="expired-banner-icon">⚠️</span>
          <span class="expired-banner-text">${i18n.t('accounts.expiredBanner')}</span>
        </div>
      ` : '';

      // Build card body: models section only for non-expired accounts
      const cardBody = isExpired ? expiredBannerHtml : `
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

      // Build card actions: re-authenticate for expired, activate for normal
      let actionsHtml = '';
      if (isExpired) {
        actionsHtml = `
          <button class="btn btn-warning" onclick="sendMessage('reAuthenticate', '${acc.email}')">${i18n.t('accounts.reAuthenticate')}</button>
          <button class="btn btn-danger" onclick="sendMessage('deleteAccount', '${acc.email}')">${i18n.t('accounts.remove')}</button>
        `;
      } else {
        actionsHtml = `
          ${!acc.isActive ? `<button class="btn btn-primary" onclick="handleSwitchAccount(this, '${acc.email}')">${i18n.t('accounts.activate')}</button>` : ''}
          <button class="btn btn-danger" onclick="sendMessage('deleteAccount', '${acc.email}')">${i18n.t('accounts.remove')}</button>
        `;
      }

      return `
        <div class="account-card ${acc.isActive ? 'active' : ''} ${isExpired ? 'expired' : ''}" data-email="${acc.email}" data-name="${acc.displayName}">
          <div class="card-header">
            ${acc.avatarUrl ? `<img class="avatar ${isExpired ? 'avatar-expired' : ''}" src="${acc.avatarUrl}" alt="${acc.displayName}" />` : `<div class="avatar ${isExpired ? 'avatar-expired' : ''}">${acc.displayName.charAt(0).toUpperCase()}</div>`}
            <div class="user-info">
              <h4>${acc.displayName}</h4>
              <p>${acc.email}</p>
            </div>
            ${activeBadge}
          </div>
          
          ${cardBody}

          <div class="card-actions">
            ${actionsHtml}
          </div>
        </div>
      `;
    }).join('') : `
      <div class="empty-state">
        <div class="empty-icon">📭</div>
        <p>${i18n.t('accounts.noAccountsRegistered')}</p>
        <button class="btn btn-primary main-btn" onclick="sendMessage('addAccount')">${i18n.t('accounts.addNewAccount')}</button>
      </div>
    `;

    return `
      <!DOCTYPE html>
      <html lang="${isRtl ? 'ar' : 'en'}" dir="${isRtl ? 'rtl' : 'ltr'}">
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Antigravity Accounts</title>
        <style>
          :root {
            /* ── VS Code Theme Integration ── */
            --background-dark: transparent;
            --surface-color: var(--vscode-editor-background, var(--vscode-sideBar-background));
            --surface-light: var(--vscode-list-hoverBackground, rgba(128, 128, 128, 0.08));
            
            --primary-color: var(--vscode-button-background, #7c3aed);
            --primary-dark: var(--vscode-button-hoverBackground, #6d28d9);
            --primary-light: var(--vscode-textLink-foreground, #a78bfa);
            --secondary-color: var(--vscode-button-secondaryBackground, #4b5563);
            
            --text-primary: var(--vscode-foreground, #e5e7eb);
            --text-secondary: var(--vscode-descriptionForeground, #9ca3af);
            
            --border-color: var(--vscode-widget-border, var(--vscode-panel-border, rgba(255, 255, 255, 0.08)));
            
            --danger-color: var(--vscode-errorForeground, #ef4444);
            --success-color: var(--vscode-testing-iconPassed, #10b981);
            --warning-color: var(--vscode-editorWarning-foreground, #f59e0b);
            
            /* Responsive neutral alphas for light/dark mode */
            --glass-bg: rgba(255, 255, 255, 0.02);
            --glass-border: rgba(255, 255, 255, 0.06);
            --shadow-color: var(--vscode-widget-shadow, rgba(0, 0, 0, 0.25));
            --focus-border: var(--vscode-focusBorder, #7c3aed);
            --hover-bg: var(--vscode-list-hoverBackground, rgba(255, 255, 255, 0.04));
            
            /* Curated premium gradients */
            --active-glow: 0 0 20px rgba(124, 58, 237, 0.25);
            --primary-gradient: linear-gradient(135deg, #7c3aed, #3b82f6);
            --primary-gradient-hover: linear-gradient(135deg, #8b5cf6, #60a5fa);
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
            background: rgba(255, 255, 255, 0.12);
            border-radius: 4px;
          }
          ::-webkit-scrollbar-thumb:hover {
            background: rgba(255, 255, 255, 0.24);
          }

          body {
            padding: 16px;
            background-color: var(--background-dark);
            color: var(--text-primary);
            font-family: var(--vscode-font-family, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif);
            margin: 0;
            container-type: inline-size;
          }
          
          .header-actions {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 20px;
            padding-bottom: 12px;
            border-bottom: 1px solid var(--border-color);
          }

          .header-actions h2 { 
            margin: 0; 
            font-size: 1.15rem; 
            color: var(--text-primary); 
            font-weight: 700;
            letter-spacing: -0.02em;
          }
          
          .btn-icon {
            background: var(--surface-light);
            border: 1px solid var(--glass-border);
            color: var(--text-primary);
            cursor: pointer;
            padding: 8px 12px;
            border-radius: 8px;
            transition: all 0.2s cubic-bezier(0.16, 1, 0.3, 1);
            display: inline-flex;
            align-items: center;
            justify-content: center;
            font-size: 0.95rem;
            margin-inline-start: 6px;
          }
          .btn-icon:hover {
            background: var(--primary-color);
            color: var(--vscode-button-foreground, #ffffff);
            border-color: var(--primary-color);
            transform: translateY(-1px);
            box-shadow: 0 4px 12px rgba(124, 58, 237, 0.2);
          }
          .btn-icon:active {
            transform: translateY(0);
          }

          .account-card {
            background: var(--glass-bg);
            border: 1px solid var(--glass-border);
            border-radius: 14px;
            padding: 16px;
            margin-bottom: 16px;
            transition: all 0.3s cubic-bezier(0.16, 1, 0.3, 1);
            position: relative;
            box-shadow: 0 4px 12px var(--shadow-color);
            backdrop-filter: blur(10px);
          }

          .account-card:hover {
            transform: translateY(-2px);
            box-shadow: 0 12px 24px var(--shadow-color);
            border-color: rgba(124, 58, 237, 0.3);
          }

          .account-card.active {
            border: 1px solid var(--success-color);
            box-shadow: 0 0 10px rgba(16, 185, 129, 0.15), 0 4px 12px var(--shadow-color);
          }

          .card-header {
            display: flex;
            align-items: center;
            gap: 14px;
            margin-bottom: 16px;
            min-width: 0;
          }

          .avatar {
            width: 44px;
            height: 44px;
            border-radius: 12px;
            background: var(--primary-gradient);
            display: flex;
            align-items: center;
            justify-content: center;
            font-weight: 700;
            font-size: 1.25rem;
            color: white;
            box-shadow: 0 4px 12px rgba(124, 58, 237, 0.25);
            object-fit: cover;
            border: 1.5px solid rgba(255, 255, 255, 0.1);
          }

          .user-info { flex: 1; overflow: hidden; min-width: 0; }
          .user-info h4 { 
            margin: 0 0 3px 0; 
            font-size: 0.98rem; 
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
            padding: 4px 10px;
            border-radius: 20px;
            font-weight: 600;
            text-transform: uppercase;
            letter-spacing: 0.05em;
          }
          
          .active-badge {
            background: rgba(16, 185, 129, 0.1);
            color: #34d399;
            border: 1px solid rgba(16, 185, 129, 0.2);
            box-shadow: 0 0 10px rgba(16, 185, 129, 0.15);
            position: relative;
            padding-inline-start: 22px;
          }
          
          .active-badge::before {
            content: '';
            position: absolute;
            left: 8px;
            top: 50%;
            transform: translateY(-50%);
            width: 6px;
            height: 6px;
            border-radius: 50%;
            background: #10b981;
            box-shadow: 0 0 8px #10b981;
            animation: badgePulse 2s infinite;
          }
          [dir="rtl"] .active-badge {
            padding-inline-start: 10px;
            padding-inline-end: 22px;
          }
          [dir="rtl"] .active-badge::before {
            left: auto;
            right: 8px;
          }

          @keyframes badgePulse {
            0% { transform: translateY(-50%) scale(0.9); opacity: 0.6; }
            50% { transform: translateY(-50%) scale(1.2); opacity: 1; }
            100% { transform: translateY(-50%) scale(0.9); opacity: 0.6; }
          }

          .balances-container {
            display: flex;
            flex-wrap: wrap;
            gap: 8px;
            margin-bottom: 16px;
            padding: 12px;
            background: rgba(255, 255, 255, 0.01);
            border-radius: 10px;
            border: 1px solid var(--glass-border);
          }

          .balance-badge {
            display: flex;
            flex-direction: column;
            background: var(--glass-bg);
            padding: 8px 10px;
            border-radius: 8px;
            flex: 1;
            min-width: 75px;
            text-align: center;
            border: 1px solid var(--glass-border);
          }

          .balance-name { 
            font-size: 0.65rem; 
            color: var(--text-secondary); 
            margin-bottom: 4px; 
            text-transform: uppercase; 
            letter-spacing: 0.5px;
            font-weight: 600;
          }
          .balance-value { 
            font-size: 1.1rem; 
            font-weight: 700; 
            color: var(--primary-light); 
          }

          .card-actions {
            display: flex;
            gap: 8px;
            justify-content: flex-end;
            margin-top: 14px;
            padding-top: 12px;
            border-top: 1px solid rgba(255, 255, 255, 0.04);
          }

          .credits-container {
            display: flex;
            margin-bottom: 16px;
            padding: 12px;
            background: rgba(255, 255, 255, 0.01);
            border-radius: 10px;
            border: 1px solid var(--glass-border);
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
            font-size: 1.15rem;
            color: var(--primary-light);
            font-weight: 800;
            letter-spacing: -0.01em;
          }

          .models-section {
            margin-bottom: 14px;
          }

          .collapse-header {
            display: flex;
            align-items: center;
            justify-content: space-between;
            background: rgba(255, 255, 255, 0.02);
            border: 1px solid var(--glass-border);
            border-radius: 10px;
            cursor: pointer;
            user-select: none;
            transition: all 0.2s cubic-bezier(0.16, 1, 0.3, 1);
            min-width: 0;
            gap: 6px;
          }
          
          .normal-collapse {
            padding: 10px 14px;
          }
          
          .normal-collapse:hover {
            background: var(--hover-bg);
            border-color: rgba(255, 255, 255, 0.1);
          }

          .collapse-title {
            font-size: 0.82rem;
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
            border-color: rgba(255, 255, 255, 0.1);
          }
          
          .collapse-header-right {
            display: flex;
            align-items: center;
            gap: 8px;
            min-width: 0;
            flex-shrink: 1;
            overflow: hidden;
          }

          .pref-badge {
            display: flex;
            align-items: center;
            gap: 6px;
            background: rgba(255, 255, 255, 0.02);
            padding: 4px 8px;
            border-radius: 8px;
            border: 1px solid var(--glass-border);
            font-size: 0.72rem;
            transition: all 0.2s cubic-bezier(0.16, 1, 0.3, 1);
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
            box-shadow: 0 2px 8px rgba(124, 58, 237, 0.25);
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
            width: 36px;
            min-width: 24px;
            height: 4px;
            background: rgba(255,255,255,0.1);
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
            transition: transform 0.3s cubic-bezier(0.16, 1, 0.3, 1);
            margin-inline-end: 4px;
          }
          
          .collapse-header.expanded .collapse-icon {
            transform: rotate(180deg);
          }

          .collapsible-wrapper {
            display: grid;
            grid-template-rows: 0fr;
            transition: grid-template-rows 0.3s cubic-bezier(0.16, 1, 0.3, 1);
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
            gap: 8px;
            padding-top: 10px;
          }

          .model-card {
            background: rgba(255, 255, 255, 0.01);
            padding: 10px 12px;
            border-radius: 10px;
            border: 1px solid var(--glass-border);
            display: flex;
            flex-direction: column;
            transition: all 0.2s cubic-bezier(0.16, 1, 0.3, 1);
          }

          .model-card.active-model {
            border-color: var(--focus-border);
            background: rgba(124, 58, 237, 0.05);
            box-shadow: 0 0 12px rgba(124, 58, 237, 0.15);
          }

          .model-card:hover {
            background: var(--surface-light);
            border-color: rgba(255, 255, 255, 0.15);
            transform: translateX(2px);
          }
          [dir="rtl"] .model-card:hover {
            transform: translateX(-2px);
          }

          .model-header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 6px;
            gap: 6px;
            min-width: 0;
          }

          .model-name {
            font-size: 0.82rem;
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
            background: rgba(255,255,255,0.06);
            border-radius: 3px;
            overflow: hidden;
            margin-bottom: 4px;
          }

          .progress-bar {
            height: 100%;
            border-radius: 3px;
            transition: width 0.4s cubic-bezier(0.16, 1, 0.3, 1);
          }

          .bg-high { background: var(--success-color); }
          .bg-med { background: var(--warning-color); }
          .bg-low { background: var(--danger-color); }
          
          .bg-high-text { color: var(--success-color); }
          .bg-med-text { color: var(--warning-color); }
          .bg-low-text { color: var(--danger-color); }

          .model-percentage {
            font-size: 0.72rem;
            align-self: flex-end;
            font-weight: 700;
          }

          .empty-models {
            font-size: 0.78rem;
            color: var(--text-secondary);
            text-align: center;
            padding: 12px;
          }

          .btn {
            padding: 8px 16px;
            border-radius: 8px;
            font-size: 0.82rem;
            cursor: pointer;
            font-weight: 600;
            transition: all 0.2s cubic-bezier(0.16, 1, 0.3, 1);
            border: none;
            color: white;
            display: inline-flex;
            align-items: center;
            justify-content: center;
            gap: 6px;
          }
          .btn:active {
            transform: scale(0.97);
          }

          .btn-primary {
            background: var(--primary-gradient);
            box-shadow: 0 2px 8px rgba(124, 58, 237, 0.25);
          }
          .btn-primary:hover { 
            background: var(--primary-gradient-hover); 
            box-shadow: 0 4px 12px rgba(124, 58, 237, 0.35);
          }

          .btn-danger {
            background: rgba(239, 68, 68, 0.08);
            color: #ef4444;
            border: 1px solid rgba(239, 68, 68, 0.15);
          }
          .btn-danger:hover {
            background: #ef4444;
            color: white;
            border-color: transparent;
            box-shadow: 0 4px 12px rgba(239, 68, 68, 0.2);
          }

          .btn-warning {
            background: var(--warning-gradient);
            color: white;
            box-shadow: 0 2px 8px rgba(245, 158, 11, 0.25);
          }
          .btn-warning:hover {
            filter: brightness(1.1);
            box-shadow: 0 4px 12px rgba(245, 158, 11, 0.35);
          }

          .account-card.expired {
            border: 1px dashed var(--warning-color);
            opacity: 0.9;
          }
          .account-card.expired:hover {
            border-color: var(--warning-color);
          }

          .avatar-expired {
            opacity: 0.4;
            filter: grayscale(80%);
          }

          .expired-badge {
            background: rgba(245, 158, 11, 0.1);
            color: var(--warning-color);
            border: 1px solid rgba(245, 158, 11, 0.2);
            white-space: nowrap;
          }

          .expired-banner {
            display: flex;
            align-items: center;
            gap: 10px;
            padding: 10px 12px;
            margin-bottom: 14px;
            background: rgba(245, 158, 11, 0.05);
            border: 1px solid rgba(245, 158, 11, 0.15);
            border-radius: 8px;
            animation: subtlePulse 3s ease-in-out infinite;
          }
          .expired-banner-icon {
            font-size: 1.25rem;
            flex-shrink: 0;
          }
          .expired-banner-text {
            font-size: 0.78rem;
            color: var(--warning-color);
            line-height: 1.4;
            font-weight: 500;
          }

          @keyframes subtlePulse {
            0%, 100% { border-color: rgba(245, 158, 11, 0.15); }
            50% { border-color: rgba(245, 158, 11, 0.4); }
          }

          .empty-state {
            text-align: center;
            padding: 40px 20px;
            color: var(--text-secondary);
            background: var(--surface-color);
            border-radius: 12px;
            border: 1px dashed var(--border-color);
          }
          .empty-icon { font-size: 3rem; margin-bottom: 16px; opacity: 0.7; }
          .main-btn { margin-top: 16px; padding: 10px 24px; font-size: 0.95rem; width: 100%;}

          /* ── Responsive: Container Queries for narrow sidebar ── */
          @container (max-width: 280px) {
            body { padding: 10px; }
            .account-card { padding: 12px; }
            .card-header { gap: 8px; }
            .avatar { width: 34px; height: 34px; font-size: 1rem; }
            .user-info h4 { font-size: 0.85rem; }
            .user-info p { font-size: 0.7rem; }
            .collapse-header { padding: 6px 8px; }
            .collapse-title { font-size: 0.78rem; }
            .pref-badge { gap: 4px; padding: 3px 5px; font-size: 0.7rem; }
            .pref-badge-bar { display: none; }
            .model-card { padding: 8px; }
            .model-name { font-size: 0.78rem; }
            .model-reset { font-size: 0.65rem; }
            .model-percentage { font-size: 0.7rem; }
            .btn { padding: 6px 10px; font-size: 0.75rem; }
            .header-actions h2 { font-size: 0.95rem; }
            .btn-icon { padding: 6px 8px; font-size: 0.8rem; }
          }

          @container (max-width: 220px) {
            .pref-badge-name { max-width: 40px; }
            .collapse-title { font-size: 0.72rem; }
            .avatar { width: 28px; height: 28px; font-size: 0.85rem; border-radius: 7px; }
            .card-header { gap: 6px; }
            .badge { font-size: 0.6rem; padding: 3px 6px; }
          }

          /* ── Search ── */
          .search-container {
            position: relative;
            margin-bottom: 16px;
          }
          .search-input {
            width: 100%;
            padding: 9px 34px 9px 12px;
            background: rgba(255, 255, 255, 0.01);
            border: 1px solid var(--border-color);
            border-radius: 8px;
            color: var(--text-primary);
            font-size: 0.82rem;
            font-family: inherit;
            outline: none;
            transition: all 0.2s cubic-bezier(0.16, 1, 0.3, 1);
            box-sizing: border-box;
          }
          [dir="rtl"] .search-input {
            padding: 9px 12px 9px 34px;
          }
          .search-input:focus {
            border-color: var(--focus-border);
            background: var(--surface-color);
            box-shadow: 0 0 8px rgba(124, 58, 237, 0.15);
          }
          .search-input::placeholder {
            color: var(--text-secondary);
            opacity: 0.6;
          }
          .search-input:disabled {
            opacity: 0.4;
            cursor: not-allowed;
          }
          .search-clear-btn {
            position: absolute;
            top: 50%;
            right: 8px;
            transform: translateY(-50%);
            background: none;
            border: none;
            color: var(--text-secondary);
            cursor: pointer;
            font-size: 0.85rem;
            padding: 2px 6px;
            border-radius: 4px;
            transition: all 0.15s;
            line-height: 1;
            display: none;
          }
          [dir="rtl"] .search-clear-btn {
            right: auto;
            left: 8px;
          }
          .search-clear-btn:hover {
            color: var(--text-primary);
            background: var(--surface-light);
          }
          .search-no-results {
            text-align: center;
            padding: 30px 20px;
            color: var(--text-secondary);
            display: none;
          }
          .search-no-results-icon {
            font-size: 2rem;
            margin-bottom: 10px;
            opacity: 0.5;
          }
          .search-no-results p {
            font-size: 0.85rem;
            margin: 0;
          }

          .account-card.search-hidden {
            display: none !important;
          }

          /* ── Top progress banner for refresh ── */
          .refresh-progress-banner {
            display: none;
            flex-direction: column;
            gap: 8px;
            padding: 12px 14px;
            margin-bottom: 16px;
            background: rgba(124, 58, 237, 0.05);
            border: 1px solid rgba(124, 58, 237, 0.3);
            border-radius: 10px;
            animation: fadeIn 0.25s ease;
            position: relative;
          }
          .refresh-progress-banner.visible {
            display: flex;
          }
          .refresh-progress-info {
            display: flex;
            justify-content: space-between;
            align-items: center;
            gap: 12px;
            min-width: 0;
          }
          .refresh-progress-stats {
            display: flex;
            align-items: center;
            gap: 10px;
            flex-shrink: 0;
          }
          .refresh-progress-count {
            font-size: 0.72rem;
            color: var(--text-secondary);
            font-weight: 600;
            background: rgba(255, 255, 255, 0.05);
            padding: 2px 8px;
            border-radius: 6px;
            border: 1px solid var(--glass-border);
            white-space: nowrap;
          }
          .refresh-progress-email {
            font-size: 0.82rem;
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
            font-size: 0.82rem;
            font-weight: 700;
            color: var(--primary-light);
            flex-shrink: 0;
          }
          .refresh-progress-bar-track {
            width: 100%;
            height: 6px;
            background: rgba(255,255,255,0.06);
            border-radius: 3px;
            overflow: hidden;
          }
          .refresh-progress-bar-fill {
            height: 100%;
            border-radius: 3px;
            background: var(--primary-gradient);
            transition: width 0.4s cubic-bezier(0.16, 1, 0.3, 1);
            width: 0%;
          }

          /* Toast notification */
          .refresh-toast {
            display: none;
            padding: 10px 14px;
            margin-bottom: 16px;
            background: rgba(16, 185, 129, 0.08);
            border: 1px solid var(--success-color);
            border-radius: 10px;
            font-size: 0.82rem;
            color: var(--success-color);
            font-weight: 600;
            text-align: center;
            animation: fadeIn 0.25s ease;
          }
          .refresh-toast.visible {
            display: block;
          }
          @keyframes spin { to { transform: rotate(360deg); } }

          /* ── Cancel / Loading bar in header ── */
          .btn-cancel-refresh {
            background: rgba(239, 68, 68, 0.15);
            color: #ef4444;
            border: 1px solid rgba(239, 68, 68, 0.25);
            cursor: pointer;
            padding: 6px 12px;
            border-radius: 8px;
            font-size: 0.78rem;
            font-weight: 600;
            display: none;
            align-items: center;
            gap: 4px;
            animation: fadeIn 0.15s ease;
            transition: all 0.2s;
          }
          .btn-cancel-refresh:hover { background: #ef4444; color: white; border-color: transparent; }

          /* ── Cancel Confirmation Dialog ── */
          .cancel-confirm-overlay {
            position: fixed;
            inset: 0;
            background: rgba(0,0,0,0.6);
            z-index: 1100;
            display: none;
            align-items: center;
            justify-content: center;
            animation: fadeIn 0.15s ease;
            backdrop-filter: blur(8px);
          }
          .cancel-confirm-box {
            background: var(--vscode-editor-background);
            border: 1px solid var(--border-color);
            border-radius: 12px;
            padding: 20px 24px;
            min-width: 240px;
            max-width: 320px;
            box-shadow: 0 12px 32px rgba(0,0,0,0.4);
            text-align: center;
          }
          .cancel-confirm-box h4 {
            margin: 0 0 8px 0;
            font-size: 0.98rem;
            font-weight: 700;
            color: var(--text-primary);
          }
          .cancel-confirm-box p {
            margin: 0 0 18px 0;
            font-size: 0.82rem;
            color: var(--text-secondary);
            line-height: 1.4;
          }
          .cancel-confirm-actions {
            display: flex;
            gap: 8px;
            justify-content: center;
          }
          .cancel-confirm-actions .btn { min-width: 80px; }

          /* Disabled state for all action buttons during refresh */
          .actions-disabled .btn,
          .actions-disabled .btn-icon,
          .actions-disabled .dropdown-item {
            opacity: 0.4;
            pointer-events: none;
            cursor: not-allowed;
          }
          /* Keep cancel confirmation dialog buttons active during refresh */
          .actions-disabled .cancel-confirm-actions .btn {
            opacity: 1;
            pointer-events: auto;
            cursor: pointer;
          }

          /* Loading overlay for export/import only */
          .loading-overlay {
            position: fixed;
            inset: 0;
            background: rgba(0,0,0,0.6);
            z-index: 1000;
            display: flex;
            flex-direction: column;
            align-items: center;
            justify-content: center;
            gap: 16px;
            backdrop-filter: blur(8px);
          }
          .loading-spinner {
            width: 36px; height: 36px;
            border: 3.5px solid rgba(255, 255, 255, 0.1);
            border-top-color: var(--primary-color);
            border-radius: 50%;
            animation: spin 0.8s linear infinite;
          }
          .loading-text {
            color: var(--text-secondary);
            font-size: 0.85rem;
            font-weight: 600;
          }

          /* ── Dropdown Menu ── */
          .menu-wrapper { position: relative; }
          .dropdown-menu {
            display: none;
            position: absolute;
            top: calc(100% + 6px);
            right: 0;
            min-width: 180px;
            background: var(--vscode-dropdown-background, var(--surface-color));
            border: 1px solid var(--vscode-dropdown-border, var(--border-color));
            border-radius: 8px;
            box-shadow: 0 8px 24px rgba(0,0,0,0.3);
            z-index: 100;
            overflow: hidden;
            animation: fadeIn 0.15s ease;
            backdrop-filter: blur(10px);
          }
          .dropdown-menu.show { display: block; }
          @keyframes fadeIn { from { opacity: 0; transform: translateY(-4px); } to { opacity: 1; transform: translateY(0); } }
          .dropdown-item {
            display: flex;
            align-items: center;
            gap: 10px;
            width: 100%;
            padding: 10px 14px;
            background: none;
            border: none;
            color: var(--vscode-dropdown-foreground, var(--text-primary));
            font-size: 0.82rem;
            cursor: pointer;
            text-align: start;
            transition: background 0.15s;
            font-weight: 500;
          }
          .dropdown-item:hover { background: var(--vscode-list-hoverBackground, var(--surface-light)); }
          .dropdown-item:disabled {
            opacity: 0.4;
            cursor: not-allowed;
          }
          .dropdown-item:disabled:hover { background: none; }
          .dropdown-icon { font-size: 1rem; display: inline-flex; align-items: center; justify-content: center; }
        </style>
      </head>
      <body>
        <!-- Loading Overlay -->
        <div id="loadingOverlay" class="loading-overlay" style="display:none;">
          <div class="loading-spinner"></div>
          <div class="loading-text" id="loadingText">${i18n.t('common.loading')}</div>
        </div>

        <div class="header-actions">
          <h2>${i18n.t('accounts.title')}</h2>
          <div style="display:flex;align-items:center;gap:4px;">
            <button id="cancelRefreshBtn" class="btn-cancel-refresh" onclick="showCancelConfirm()" title="${i18n.t('accounts.cancelRefresh')}">✖ ${i18n.t('accounts.cancelRefresh')}</button>
            <button id="refreshBtn" class="btn-icon" onclick="handleRefresh()" title="${i18n.t('commands.refreshBalances.title')}">🔄</button>
            <button id="addBtn" class="btn-icon" onclick="sendMessage('addAccount')" title="${i18n.t('commands.addAccount.title')}">➕</button>
            <div class="menu-wrapper">
              <button class="btn-icon" onclick="toggleMenu(event)" title="${i18n.t('accounts.more')}" id="menuBtn">⋮</button>
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
          <button class="search-clear-btn" id="searchClearBtn" onclick="clearSearch()">✕</button>
        </div>` : ''}

        <div id="accounts-list">
          <!-- Refresh Progress Banner -->
          <div id="refreshProgressBanner" class="refresh-progress-banner">
            <div class="refresh-progress-info">
              <span class="refresh-progress-email" id="refreshProgressEmail"></span>
              <div class="refresh-progress-stats">
                <span class="refresh-progress-count" id="refreshProgressCount">0/0</span>
                <span class="refresh-progress-percent" id="refreshProgressPercent">0%</span>
              </div>
            </div>
            <div class="refresh-progress-bar-track">
              <div class="refresh-progress-bar-fill" id="refreshProgressBar"></div>
            </div>
          </div>
          <!-- Refresh Toast -->
          <div id="refreshToast" class="refresh-toast"></div>
          ${accountCardsHtml}
          <!-- Search No Results -->
          <div id="searchNoResults" class="search-no-results">
            <div class="search-no-results-icon">🔍</div>
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
        <div id="settingsModal" class="modal-overlay" style="display:none; position:fixed; top:0; left:0; width:100%; height:100%; background:rgba(0,0,0,0.5); z-index:1000; align-items:center; justify-content:center;">
          <div class="modal-content" style="background:var(--vscode-editor-background); border:1px solid var(--vscode-widget-border); border-radius:8px; width:90%; max-width:400px; padding:20px; box-shadow:0 4px 12px rgba(0,0,0,0.2); max-height:90vh; overflow-y:auto;">
            <h3 style="margin-top:0; margin-bottom:16px;">${i18n.t('accounts.settings')}</h3>
            
            <div style="margin-bottom: 16px;">
              <label for="languageSelect" style="display:block; margin-bottom:8px; font-weight:bold;">${i18n.t('webview.language')}</label>
              <select id="languageSelect" style="width:100%; padding:8px; background:var(--vscode-dropdown-background); color:var(--vscode-dropdown-foreground); border:1px solid var(--vscode-dropdown-border); border-radius:4px;">
                <option value="auto" ${configLanguage === 'auto' ? 'selected' : ''}>${i18n.t('webview.languageAuto')}</option>
                <option value="en" ${configLanguage === 'en' ? 'selected' : ''}>English</option>
                <option value="ar" ${configLanguage === 'ar' ? 'selected' : ''}>العربية</option>
                <option value="es" ${configLanguage === 'es' ? 'selected' : ''}>Español</option>
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
          const availableModelKeys = ${JSON.stringify(availableModelKeys)};
          const currentPreferredModel = ${JSON.stringify(effectivePreferred)};
          const hasAccounts = ${accounts.length > 0};
          const currentAutoRefresh = ${configAutoRefresh};
          const currentAutoRotate = ${configAutoRotate};
          const currentRefreshInterval = ${configRefreshInterval};
          const isRtlDir = ${isRtl};
          const savedSearchQuery = ${JSON.stringify(this._searchQuery)};
          
          const vscode = acquireVsCodeApi();

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
          }

          // ── Refresh button ──
          let isRefreshing = false;
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

          let state = vscode.getState() || { activeModels: {} };
          
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
          document.querySelectorAll('.models-container').forEach(container => {
             container.originalOrder = Array.from(container.children);
          });
          applyActiveModels();

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
                const btn = document.querySelector('button[onclick*="\\'' + message.email + '\\'"]');
                if (btn) {
                   btn.disabled = false;
                   btn.innerText = btn.dataset.originalText || '${i18n.t('accounts.activate')}';
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
            const m = document.getElementById('dropdownMenu');
            if (m) m.classList.remove('show');
            if (action === 'export') {
              sendMessage('exportAccounts');
            } else if (action === 'import') {
              sendMessage('importAccounts');
            } else if (action === 'settings') {
              openSettings();
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
            const modal = document.getElementById('settingsModal');
            const select = document.getElementById('preferredModelSelect');
            const helpText = document.getElementById('settingsHelpText');
            
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

            modal.style.display = 'flex';
            attachIntervalListener();
          }

          function closeSettings() {
            document.getElementById('settingsModal').style.display = 'none';
            // Also close the immediate confirm overlay if open
            document.getElementById('immediateConfirmOverlay').style.display = 'none';
          }

          function saveSettings() {
            const select = document.getElementById('preferredModelSelect');
            const selectedModel = select.value;
            const langSelect = document.getElementById('languageSelect');
            const selectedLang = langSelect ? langSelect.value : 'auto';
            const autoRefreshToggle = document.getElementById('autoRefreshToggle');
            const autoRefreshEnabled = autoRefreshToggle ? autoRefreshToggle.checked : true;
            const autoRotateToggle = document.getElementById('autoRotateToggle');
            const autoRotateEnabled = autoRotateToggle ? autoRotateToggle.checked : false;
            const intervalSelect = document.getElementById('refreshIntervalSelect');
            const refreshInterval = intervalSelect ? parseInt(intervalSelect.value) : 15;
            
            vscode.postMessage({
              command: 'saveSettings',
              language: selectedLang,
              preferredModel: selectedModel,
              autoRefreshEnabled: autoRefreshEnabled,
              autoRotateEnabled: autoRotateEnabled,
              refreshIntervalMinutes: refreshInterval
            });
            closeSettings();
            // Show loading overlay briefly since the webview will be re-rendered
            vscode.postMessage({ command: 'showLoading' });
          }
          
          // Modify sendMessage to handle additional payload if needed
          function sendMessage(command, email = null, modelKey = null) {
            vscode.postMessage({ command, email, modelKey });
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

            } else if (msg.command === 'accountRefreshDone') {
              // No per-card UI updates needed; progress banner is updated on accountRefreshStart

            } else if (msg.command === 'refreshFinished') {
              isRefreshing = false;
              setActionsDisabled(false);
              setSearchDisabled(false);
              // Dismiss cancel dialog if still open (refresh finished naturally)
              dismissCancelConfirm();
              hideProgressBanner(!!msg.wasCancelled);

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
        value = rawV.value;
        resetTime = rawV.resetTime;
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
   * Sorts the accounts array based on active status, preferred model balance, account status hierarchy, and alphabetical name.
   */
  private sortAccounts(accounts: any[], effectivePreferred: string, pinnedEmailLower: string | null): void {
    accounts.sort((a, b) => {
      // 1. Pinned active account always goes first
      const aActive = pinnedEmailLower !== null && a.email.toLowerCase() === pinnedEmailLower;
      const bActive = pinnedEmailLower !== null && b.email.toLowerCase() === pinnedEmailLower;
      if (aActive && !bActive) return -1;
      if (!aActive && bActive) return 1;

      // 2. Sorting by preferred model balance if selected
      if (effectivePreferred) {
        const aVal = this.getModelBalanceValue(a.balances, effectivePreferred);
        const bVal = this.getModelBalanceValue(b.balances, effectivePreferred);
        if (aVal !== bVal) {
          return bVal - aVal; // Descending (highest first)
        }
      } else {
        // 3. Fallback: Sort by account status hierarchy (accounts with quota first)
        const getStatusWeight = (status: AccountStatus) => {
          switch (status) {
            case AccountStatus.ACTIVE: return 0;
            case AccountStatus.LOW_BALANCE: return 1;
            case AccountStatus.DEPLETED: return 2;
            case AccountStatus.TOKEN_EXPIRED: return 3;
            case AccountStatus.ERROR: return 4;
            default: return 5;
          }
        };
        const aWeight = getStatusWeight(a.status);
        const bWeight = getStatusWeight(b.status);
        if (aWeight !== bWeight) {
          return aWeight - bWeight;
        }
      }

      // 4. Tie-breaker: Alphabetical by display name
      const nameA = a.displayName || a.alias || a.name || a.email || '';
      const nameB = b.displayName || b.alias || b.name || b.email || '';
      return nameA.localeCompare(nameB, undefined, { numeric: true, sensitivity: 'base' });
    });
  }
}
