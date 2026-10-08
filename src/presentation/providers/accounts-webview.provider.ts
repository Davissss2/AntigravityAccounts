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
import { Workflow } from '../../core/domain/models/workflow.model';
import { CryptoUtils } from '../../core/utils/crypto.utils';
import { ExtensionConfig } from '../../core/config/extension.config';
import { getFriendlyModelName, normalizeModelKey, getModelBalanceValue, getModelBalanceEntry } from '../../core/utils/model.utils';
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

  /** Cached list of workflows */
  private _workflows: Workflow[] = [];

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

  /** Cached native auth email for the mismatch banner, avoids blocking HTML generation */
  private _cachedNativeAuthEmail: string | null = null;

  /** Guard flags to prevent full HTML re-render from kicking the user out of active UI modals or input fields */
  private _isSettingsOpen: boolean = false;
  private _isEditingAlias: boolean = false;
  private _pendingRefreshAfterInteraction: boolean = false;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly accountRepo: IAccountRepository,
    private readonly accountService: AccountService
  ) {
    // Pre-seed cached active account from repository so first render has active pin ready
    this.accountRepo.getActiveAccountEmail().then(email => {
      if (email && !this._pinnedActiveEmail) {
        this._pinnedActiveEmail = email.toLowerCase();
      }
    }).catch(() => {});

    // Automatically re-detect active account and re-render when data changes
    this.accountService.onAccountsChanged(() => {
      // Do not recreate full HTML DOM during active scan since cards update individually
      if (!this._isRefreshingProgress.isRefreshing) {
        this.detectAndPinActiveAccount().then(() => this.refresh());
      }
    });
  }

  /**
   * Asynchronously checks if the native IDE auth session differs from the pinned active account,
   * without blocking HTML generation or causing black screen delays.
   */
  private checkNativeAuthMismatch(): void {
    this.accountService.getNativeAuthEmail().then(email => {
      if (email !== this._cachedNativeAuthEmail) {
        this._cachedNativeAuthEmail = email;
        if (this._view && this._pinnedActiveEmail && email && !isEmailMatch(email, this._pinnedActiveEmail)) {
          this.refresh();
        }
      }
    }).catch(err => {
      Logger.getInstance().debug('Error checking native auth mismatch in background', err);
    });
  }

  /** AbortController for the current refresh cycle (null = not refreshing) */
  private _refreshAbortController: AbortController | null = null;

  /** Queue of pending account emails remaining in the active refresh cycle */
  private _pendingQueueEmails: string[] = [];

  public isRefreshing(): boolean {
    return this._isRefreshingProgress.isRefreshing;
  }

  public getPendingQueueEmails(): string[] {
    return [...this._pendingQueueEmails];
  }

  public cancelRefresh(): void {
    this._refreshAbortController?.abort();
  }

  public async resolveWebviewView(
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
            // If a refresh is running, save remaining pending emails to repository so we resume on relaunch!
            if (this._isRefreshingProgress.isRefreshing && this._pendingQueueEmails.length > 0) {
              Logger.getInstance().info(`Account switch requested during refresh. Saving ${this._pendingQueueEmails.length} pending accounts to resume upon reload.`);
              await this.accountRepo.setPendingRefreshEmails(this._pendingQueueEmails);
              this._refreshAbortController?.abort();
            }
            const confirm = await vscode.window.showWarningMessage(
              i18n.t('accounts.confirmSwitch', { email: message.email }),
              { modal: true },
              i18n.t('common.yes')
            );
            if (confirm === i18n.t('common.yes')) {
              try {
                const result = await this.accountService.switchAccountWorkflow(message.email);
                if (result !== 'success') {
                  await this.accountRepo.setPendingRefreshEmails([]);
                  this._view?.webview.postMessage({ command: 'accountSwitchCancelled', email: message.email });
                }
              } catch (err) {
                await this.accountRepo.setPendingRefreshEmails([]);
                this._view?.webview.postMessage({ command: 'accountSwitchCancelled', email: message.email });
              }
            } else {
              await this.accountRepo.setPendingRefreshEmails([]);
              this._view?.webview.postMessage({ command: 'accountSwitchCancelled', email: message.email });
            }
          }
          break;
        case 'settingsOpened':
          this._isSettingsOpen = true;
          break;
        case 'settingsClosed':
          this._isSettingsOpen = false;
          if (this._pendingRefreshAfterInteraction) {
            this._pendingRefreshAfterInteraction = false;
            await this.refresh();
          }
          break;
        case 'aliasEditingStarted':
          this._isEditingAlias = true;
          break;
        case 'aliasEditingFinished':
          this._isEditingAlias = false;
          if (this._pendingRefreshAfterInteraction) {
            this._pendingRefreshAfterInteraction = false;
            await this.refresh();
          }
          break;
        case 'updateAlias':
          this._isEditingAlias = false;
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
        case 'toggleAutoSwitch': {
          const config = vscode.workspace.getConfiguration('antigravityAccount');
          const current = config.get<boolean>('autoRotateEnabled', false);
          const nextVal = !current;
          await config.update('autoRotateEnabled', nextVal, vscode.ConfigurationTarget.Global);
          Logger.getInstance().info(`Auto-switch toggled to: ${nextVal}`);
          vscode.window.showInformationMessage(
            nextVal ? i18n.t('settings.autoSwitchEnabled') : i18n.t('settings.autoSwitchDisabled')
          );
          await this.refresh();
          break;
        }
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
        case 'createWorkflow': {
          let name = message.name;
          if (!name) {
            name = await vscode.window.showInputBox({
              prompt: i18n.t('workflows.createPrompt'),
              placeHolder: i18n.t('workflows.createPlaceholder'),
              validateInput: (val) => {
                if (!val || !val.trim()) return i18n.t('workflows.createPlaceholder');
                return undefined;
              }
            });
          }
          if (name && name.trim()) {
            const workflowId = 'wf_' + Date.now();
            await this.accountRepo.saveWorkflow({
              id: workflowId,
              name: name.trim(),
              createdAt: new Date().toISOString(),
            });
            await this.accountRepo.setActiveWorkflowId(workflowId);
            await this.refresh();
          }
          break;
        }
        case 'deleteWorkflow': {
          if (message.workflowId) {
            const workflows = await this.accountRepo.getWorkflows();
            const target = workflows.find(w => w.id === message.workflowId);
            const wfName = target ? target.name : message.workflowId;
            const confirm = await vscode.window.showWarningMessage(
              i18n.t('workflows.confirmDelete', { name: wfName }),
              { modal: true },
              i18n.t('workflows.delete')
            );
            if (confirm === i18n.t('workflows.delete')) {
              await this.accountRepo.deleteWorkflow(message.workflowId);
              await this.refresh();
            }
          }
          break;
        }
        case 'renameWorkflow': {
          if (message.workflowId) {
            const workflows = await this.accountRepo.getWorkflows();
            const target = workflows.find(w => w.id === message.workflowId);
            const currentName = target ? target.name : '';
            const newName = await vscode.window.showInputBox({
              prompt: i18n.t('workflows.renamePrompt', { name: currentName }),
              value: currentName,
              validateInput: (val) => {
                if (!val || !val.trim()) return i18n.t('workflows.createPlaceholder');
                return undefined;
              }
            });
            if (newName && newName.trim() && newName.trim() !== currentName) {
              await this.accountRepo.renameWorkflow(message.workflowId, newName.trim());
              await this.refresh();
            }
          }
          break;
        }
        case 'workflowOptions': {
          if (message.workflowId) {
            const workflows = await this.accountRepo.getWorkflows();
            const target = workflows.find(w => w.id === message.workflowId);
            const wfName = target ? target.name : (message.workflowName || message.workflowId);
            const allAccounts = await this.accountRepo.getAllAccounts();
            const wfAccounts = allAccounts.filter(a => a.workflow === message.workflowId);
            const uncategorizedAccounts = allAccounts.filter(a => !a.workflow);

            const picked = await vscode.window.showQuickPick([
              {
                label: `$(check-all) ${i18n.t('workflows.manageAccounts')}`,
                description: `(${wfAccounts.length} / ${allAccounts.length})`,
                detail: i18n.t('workflows.manageAccountsDetail'),
                action: 'manage',
              },
              {
                label: `$(add) ${i18n.t('workflows.addAllAccounts')}`,
                description: `(${allAccounts.length})`,
                detail: i18n.t('workflows.addAllAccountsDetail', { count: allAccounts.length, name: wfName }),
                action: 'addAll',
              },
              {
                label: `$(diff-added) ${i18n.t('workflows.addUncategorized')}`,
                description: `(${uncategorizedAccounts.length})`,
                detail: i18n.t('workflows.addUncategorizedDetail', { count: uncategorizedAccounts.length, name: wfName }),
                action: 'addUncategorized',
              },
              {
                label: `$(export) ${i18n.t('workflows.exportThisWorkflow')}`,
                description: `(${wfAccounts.length})`,
                detail: i18n.t('workflows.exportThisWorkflowDetail', { count: wfAccounts.length, name: wfName }),
                action: 'export',
              },
              {
                label: `$(clear-all) ${i18n.t('workflows.clearAccounts')}`,
                description: `(${wfAccounts.length})`,
                detail: i18n.t('workflows.clearAccountsDetail', { count: wfAccounts.length, name: wfName }),
                action: 'clear',
              },
              {
                label: `$(edit) ${i18n.t('workflows.rename')}`,
                action: 'rename',
              },
              {
                label: `$(trash) ${i18n.t('workflows.delete')}`,
                action: 'delete',
              }
            ], {
              placeHolder: `Workflow: ${wfName}`,
            });

            if (picked) {
              if (picked.action === 'manage') {
                interface AccountPickItem extends vscode.QuickPickItem {
                  email: string;
                }
                const pickItems: AccountPickItem[] = allAccounts.map(acc => {
                  const displayName = acc.alias ? `${acc.alias} (${acc.email})` : acc.email;
                  return {
                    label: displayName,
                    description: acc.workflow && acc.workflow !== message.workflowId
                      ? `[${workflows.find(w => w.id === acc.workflow)?.name || acc.workflow}]`
                      : '',
                    email: acc.email,
                    picked: acc.workflow === message.workflowId,
                  };
                });

                const selected = await vscode.window.showQuickPick(pickItems, {
                  canPickMany: true,
                  placeHolder: i18n.t('workflows.selectAccountsPrompt', { name: wfName }),
                  title: `Workflow: ${wfName}`,
                });

                if (selected !== undefined) {
                  const selectedSet = new Set(selected.map(s => s.email.toLowerCase()));
                  const toAssign: string[] = [];
                  const toUnassign: string[] = [];
                  for (const acc of allAccounts) {
                    if (selectedSet.has(acc.email.toLowerCase())) {
                      if (acc.workflow !== message.workflowId) {
                        toAssign.push(acc.email);
                      }
                    } else if (acc.workflow === message.workflowId) {
                      toUnassign.push(acc.email);
                    }
                  }
                  if (toAssign.length > 0) {
                    await this.accountRepo.assignAccountsToWorkflow(toAssign, message.workflowId);
                  }
                  if (toUnassign.length > 0) {
                    await this.accountRepo.assignAccountsToWorkflow(toUnassign, undefined);
                  }
                  await this.refresh();
                  vscode.window.showInformationMessage(i18n.t('workflows.manageSuccess', { name: wfName }));
                }
              } else if (picked.action === 'addAll') {
                await this.accountRepo.assignAccountsToWorkflow(allAccounts.map(a => a.email), message.workflowId);
                await this.refresh();
                vscode.window.showInformationMessage(i18n.t('workflows.addAllSuccess', { count: allAccounts.length, name: wfName }));
              } else if (picked.action === 'addUncategorized') {
                if (uncategorizedAccounts.length === 0) {
                  vscode.window.showInformationMessage(i18n.t('workflows.noUncategorized'));
                } else {
                  await this.accountRepo.assignAccountsToWorkflow(uncategorizedAccounts.map(a => a.email), message.workflowId);
                  await this.refresh();
                  vscode.window.showInformationMessage(i18n.t('workflows.addUncategorizedSuccess', { count: uncategorizedAccounts.length, name: wfName }));
                }
              } else if (picked.action === 'clear') {
                if (wfAccounts.length === 0) {
                  vscode.window.showInformationMessage(i18n.t('workflows.emptyWorkflow'));
                } else {
                  await this.accountRepo.assignAccountsToWorkflow(wfAccounts.map(a => a.email), undefined);
                  await this.refresh();
                  vscode.window.showInformationMessage(i18n.t('workflows.clearSuccess', { name: wfName }));
                }
              } else if (picked.action === 'export') {
                if (wfAccounts.length === 0) {
                  vscode.window.showWarningMessage(i18n.t('workflows.exportEmpty', { name: wfName }));
                } else {
                  await this.handleExport(message.workflowId);
                }
              } else if (picked.action === 'rename') {
                const newName = await vscode.window.showInputBox({
                  prompt: i18n.t('workflows.renamePrompt', { name: wfName }),
                  value: wfName,
                  validateInput: (val) => {
                    if (!val || !val.trim()) return i18n.t('workflows.createPlaceholder');
                    return undefined;
                  }
                });
                if (newName && newName.trim() && newName.trim() !== wfName) {
                  await this.accountRepo.renameWorkflow(message.workflowId, newName.trim());
                  await this.refresh();
                }
              } else if (picked.action === 'delete') {
                const confirm = await vscode.window.showWarningMessage(
                  i18n.t('workflows.confirmDelete', { name: wfName }),
                  { modal: true },
                  i18n.t('workflows.delete')
                );
                if (confirm === i18n.t('workflows.delete')) {
                  await this.accountRepo.deleteWorkflow(message.workflowId);
                  await this.refresh();
                }
              }
            }
          }
          break;
        }
        case 'setActiveWorkflow': {
          await this.accountRepo.setActiveWorkflowId(message.workflowId || null);
          break;
        }
        case 'assignAccountWorkflow': {
          if (message.email) {
            const workflows = await this.accountRepo.getWorkflows();
            const currentAcc = await this.accountRepo.getAccount(message.email);
            
            interface AssignItem extends vscode.QuickPickItem {
              workflowId?: string | null;
              isCreate?: boolean;
            }

            const items: AssignItem[] = [
              {
                label: `$(close) ${i18n.t('workflows.unassign')}`,
                description: !currentAcc?.workflow ? '✓' : '',
                workflowId: null,
              },
              ...workflows.map(w => ({
                label: `$(folder) ${w.name}`,
                description: currentAcc?.workflow === w.id ? '✓' : '',
                workflowId: w.id,
              })),
              {
                label: `$(plus) ${i18n.t('workflows.newWorkflow')}`,
                isCreate: true,
              }
            ];

            const picked = await vscode.window.showQuickPick(items, {
              placeHolder: i18n.t('workflows.assignPrompt', { email: message.email }),
            });

            if (picked) {
              if (picked.isCreate) {
                const name = await vscode.window.showInputBox({
                  prompt: i18n.t('workflows.createPrompt'),
                  placeHolder: i18n.t('workflows.createPlaceholder'),
                  validateInput: (val) => {
                    if (!val || !val.trim()) return i18n.t('workflows.createPlaceholder');
                    return undefined;
                  }
                });
                if (name && name.trim()) {
                  const newWfId = 'wf_' + Date.now();
                  await this.accountRepo.saveWorkflow({
                    id: newWfId,
                    name: name.trim(),
                    createdAt: new Date().toISOString(),
                  });
                  await this.accountRepo.updateAccount(message.email, { workflow: newWfId });
                  await this.refresh();
                }
              } else {
                await this.accountRepo.updateAccount(message.email, { workflow: picked.workflowId || undefined });
                await this.refresh();
              }
            }
          }
          break;
        }
        case 'bulkAssignWorkflow': {
          if (message.emails && Array.isArray(message.emails) && message.emails.length > 0) {
            const workflows = await this.accountRepo.getWorkflows();
            interface BulkAssignItem extends vscode.QuickPickItem {
              workflowId?: string | null;
              isCreate?: boolean;
            }

            const items: BulkAssignItem[] = [
              {
                label: `$(close) ${i18n.t('workflows.unassign')}`,
                workflowId: null,
              },
              ...workflows.map(w => ({
                label: `$(folder) ${w.name}`,
                workflowId: w.id,
              })),
              {
                label: `$(plus) ${i18n.t('workflows.newWorkflow')}`,
                isCreate: true,
              }
            ];

            const picked = await vscode.window.showQuickPick(items, {
              placeHolder: i18n.t('workflows.bulkAssignPrompt', { count: message.emails.length }),
            });

            if (picked) {
              let targetWfId = picked.workflowId;
              let targetWfName = '';
              if (picked.isCreate) {
                const name = await vscode.window.showInputBox({
                  prompt: i18n.t('workflows.createPrompt'),
                  placeHolder: i18n.t('workflows.createPlaceholder'),
                  validateInput: (val) => {
                    if (!val || !val.trim()) return i18n.t('workflows.createPlaceholder');
                    return undefined;
                  }
                });
                if (name && name.trim()) {
                  targetWfId = 'wf_' + Date.now();
                  targetWfName = name.trim();
                  await this.accountRepo.saveWorkflow({
                    id: targetWfId,
                    name: targetWfName,
                    createdAt: new Date().toISOString(),
                  });
                } else {
                  break;
                }
              } else if (picked.workflowId) {
                const found = workflows.find(w => w.id === picked.workflowId);
                targetWfName = found ? found.name : picked.workflowId;
              }

              await this.accountRepo.assignAccountsToWorkflow(message.emails, targetWfId || undefined);
              await this.refresh();
              vscode.window.showInformationMessage(i18n.t('workflows.bulkSuccess', { count: message.emails.length, name: targetWfName || i18n.t('workflows.uncategorized') }));
            }
          }
          break;
        }
        case 'bulkExportAccounts': {
          if (message.emails && Array.isArray(message.emails) && message.emails.length > 0) {
            await this.handleExport(undefined, message.emails);
          }
          break;
        }
        case 'saveSettings': {
          try {
            const config = vscode.workspace.getConfiguration('antigravityAccount');

            if (message.preferredModel !== undefined) {
              await this.accountRepo.setPreferredModel(message.preferredModel);
            }

            if (message.language !== undefined) {
              await config.update('language', message.language, vscode.ConfigurationTarget.Global);
              // Update i18n instance immediately so refresh renders with the selected language
              const i18nService = I18nService.getInstance();
              let lang = message.language;
              if (lang === 'auto') {
                const fullLang = (vscode.env.language || '').toLowerCase();
                const editorLang = fullLang.split('-')[0];
                if (fullLang.startsWith('zh')) {
                  lang = 'zh-CN';
                } else if (fullLang.startsWith('pt')) {
                  lang = 'pt-BR';
                } else if (['ar', 'es', 'fr', 'de', 'ja', 'ru', 'ko'].includes(editorLang)) {
                  lang = editorLang;
                } else {
                  lang = 'en';
                }
              }
              i18nService.setLocale(lang);
            }

            if (message.theme !== undefined) {
              await config.update('theme', message.theme, vscode.ConfigurationTarget.Global);
            }
            if (message.sortBy !== undefined) {
              await config.update('sortBy', message.sortBy, vscode.ConfigurationTarget.Global);
            }
            if (message.cacheDurationDays !== undefined) {
              await config.update('cacheDurationDays', message.cacheDurationDays, vscode.ConfigurationTarget.Global);
            }
            if (message.autoRefreshEnabled !== undefined) {
              await config.update('autoRefreshEnabled', message.autoRefreshEnabled, vscode.ConfigurationTarget.Global);
            }
            if (message.autoRotateEnabled !== undefined) {
              await config.update('autoRotateEnabled', message.autoRotateEnabled, vscode.ConfigurationTarget.Global);
            }
            if (message.lowCreditNotificationsEnabled !== undefined) {
              await config.update('lowCreditNotificationsEnabled', message.lowCreditNotificationsEnabled, vscode.ConfigurationTarget.Global);
            }
            if (message.refreshIntervalMinutes !== undefined) {
              await config.update('refreshIntervalMinutes', message.refreshIntervalMinutes, vscode.ConfigurationTarget.Global);
            }
            if (message.autoCaptureAccounts !== undefined) {
              await config.update('autoCaptureAccounts', message.autoCaptureAccounts, vscode.ConfigurationTarget.Global);
            }
            if (message.autoResumeChat !== undefined) {
              await config.update('autoResumeChat', message.autoResumeChat, vscode.ConfigurationTarget.Global);
            }
            if (message.autoResumePrompt !== undefined) {
              await config.update('autoResumePrompt', message.autoResumePrompt, vscode.ConfigurationTarget.Global);
            }
            if (message.adaptiveQuotaPolling !== undefined) {
              await config.update('adaptiveQuotaPolling', message.adaptiveQuotaPolling, vscode.ConfigurationTarget.Global);
            }
            if (message.noticeDurationSeconds !== undefined) {
              await config.update('noticeDurationSeconds', message.noticeDurationSeconds, vscode.ConfigurationTarget.Global);
            }
            if (message.confirmOnSwitch !== undefined) {
              await config.update('confirmOnSwitch', message.confirmOnSwitch, vscode.ConfigurationTarget.Global);
            }
            if (message.showNotifications !== undefined) {
              await config.update('showNotifications', message.showNotifications, vscode.ConfigurationTarget.Global);
            }

            Logger.getInstance().info('Settings saved successfully.');
            this.accountService.emitAccountsChanged();

            // Only show toast if user saved from the settings modal (message has multiple fields), avoid popping up toast on toolbar sort dropdown change
            if (message.theme !== undefined || message.language !== undefined || message.preferredModel !== undefined) {
              const currentI18n = I18nService.getInstance();
              vscode.window.showInformationMessage(currentI18n.t('settings.saved'));
            }
          } catch (err: any) {
            Logger.getInstance().error('Failed to save settings', err);
            vscode.window.showErrorMessage(`Failed to save settings: ${err?.message || err}`);
          } finally {
            this._isSettingsOpen = false;
            this._pendingRefreshAfterInteraction = false;
            await this.refresh();
            this._view?.webview.postMessage({ command: 'hideLoading' });
            this._view?.webview.postMessage({ command: 'settingsSavedToast' });
          }
          break;
        }
      }
    });

    // Skip all account operations if not running in Antigravity editor
    if (!this.isAntigravityEditor()) {
      await this.refresh();
      return;
    }

    // Step 0: Pre-seed pinned active account from repository cache (in-memory globalState)
    if (!this._pinnedActiveEmail) {
      try {
        const cachedActive = await this.accountRepo.getActiveAccountEmail();
        if (cachedActive && !this._pinnedActiveEmail) {
          this._pinnedActiveEmail = cachedActive.toLowerCase();
        }
      } catch {}
    }

    // Step 1: IMMEDIATE RENDER — Render the full UI in Frame 0 (0ms latency, ZERO black screen!)
    await this.refresh();

    // Step 2: Background asynchronous active account detection & pinning from state.vscdb
    this.detectAndPinActiveAccount().then(async () => {
      // Re-render only if pinned account changed or to ensure active state is crisp
      await this.refresh();

      const accounts = await this.accountRepo.getAllAccounts();
      if (accounts.length === 0) return;

      // Resume pending refresh if saved before an account switch
      const pendingToResume = await this.accountRepo.getPendingRefreshEmails();
      if (pendingToResume && pendingToResume.length > 0) {
        Logger.getInstance().info(`Found ${pendingToResume.length} pending accounts to resume refresh after account switch.`);
        await this.accountRepo.setPendingRefreshEmails([]);
        setTimeout(() => {
          vscode.window.showInformationMessage(
            `Reanudando la actualización de ${pendingToResume.length} cuentas pendientes tras el cambio de cuenta...`
          );
          this.handleProgressiveRefresh(false, pendingToResume);
        }, 1500);
        return;
      }

      const config = ExtensionConfig.getInstance();

      if (config.isAutoRefreshEnabled()) {
        // Auto-refresh ENABLED:
        // 1. Refresh the active account if it hasn't been refreshed in the last 5 minutes (300 seconds)
        await this.handleActiveAccountRefresh(5 * 60 * 1000);

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
    }).catch(err => {
      Logger.getInstance().error('Error during background active account detection', err);
    });

    // Step 3: Background non-blocking check for native auth session mismatch
    this.checkNativeAuthMismatch();
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
    if (this._isSettingsOpen || this._isEditingAlias) {
      this._pendingRefreshAfterInteraction = true;
      Logger.getInstance().debug('Skipping full webview HTML re-render because user is interacting with settings or editing alias.');
      return;
    }
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
    // Step 1: Check if active email is logged into Antigravity
    const activeEmail = await this.accountService.getActiveAntigravityEmail();

    // Step 1.5: If error reading database, preserve current pin
    if (activeEmail === undefined) {
      Logger.getInstance().info('Failed to read active email, preserving current pin.');
      return;
    }

    // Step 2: If no account (Antigravity is logged out) → clear pin and stop
    if (!activeEmail) {
      this._pinnedActiveEmail = null;
      return;
    }

    let accounts = await this.accountRepo.getAllAccounts();
    let matchedAccount = accounts.find(a => isEmailMatch(a.email, activeEmail));

    // Step 3: If not in repository, auto-capture it immediately!
    if (!matchedAccount) {
      Logger.getInstance().info(`[Auto-Capture] Active Antigravity account "${activeEmail}" not in repository. Auto-capturing...`);
      const captured = await this.accountService.syncActiveAccountFromDb(true);
      if (captured) {
        matchedAccount = captured;
        this._pinnedActiveEmail = captured.email.toLowerCase();
        await this.accountRepo.setActiveAccountEmail(captured.email.toLowerCase());
        Logger.getInstance().info(`Pinned newly auto-captured account: ${captured.email}`);
        return;
      }
    }

    try {
      const nativeAuthEmail = await this.accountService.getNativeAuthEmail();
      if (nativeAuthEmail) {
        this._cachedNativeAuthEmail = nativeAuthEmail;
      }
    } catch {}

    if (matchedAccount) {
      // Step 4: Pin this account — it will be moved to the top of the list
      this._pinnedActiveEmail = matchedAccount.email.toLowerCase();
      await this.accountRepo.setActiveAccountEmail(matchedAccount.email.toLowerCase());
      Logger.getInstance().info(`Pinned active account: ${matchedAccount.email}`);
    } else {
      this._pinnedActiveEmail = null;
      await this.accountRepo.setActiveAccountEmail(null);
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
    this._pendingQueueEmails = [...orderedEmails];

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
          const doneEmailLower = email.toLowerCase();
          const qIdx = this._pendingQueueEmails.findIndex(e => e.toLowerCase() === doneEmailLower);
          if (qIdx !== -1) {
            this._pendingQueueEmails.splice(qIdx, 1);
          }
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
      this._pendingQueueEmails = [];
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
    const activeAccount = accounts.find(a => isEmailMatch(a.email, this._pinnedActiveEmail));
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
      }, { force: true });
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
      }, { force: true });
    } catch (e: any) {
      Logger.getInstance().error(`Error during manual single account refresh for ${email}`, e);
    }
  }

  private async getDisplayOrderEmails(): Promise<string[]> {
    const accounts = await this.accountRepo.getAllAccounts();
    const pinnedEmailLower = this._pinnedActiveEmail;

    accounts.forEach(acc => {
      acc.isActive = (pinnedEmailLower !== null && isEmailMatch(acc.email, pinnedEmailLower));
    });

    const preferredModel = await this.accountRepo.getPreferredModel();
    const effectivePreferred = preferredModel || '';

    this.sortAccounts(accounts, effectivePreferred, pinnedEmailLower);

    return accounts.map(a => a.email);
  }

  // ─── Export Handler ──────────────────────────────────────────────────────

  private async handleExport(targetWorkflowId?: string | null, customEmails?: string[]): Promise<void> {
    const logger = Logger.getInstance();
    const i18n = I18nService.getInstance();
    try {
      const accounts = await this.accountRepo.getAllAccounts();
      if (accounts.length === 0) {
        vscode.window.showWarningMessage(i18n.t('accounts.noExportAccounts'));
        return;
      }

      // ── Step 1: Select workflow filter if workflows exist ──
      const workflows = await this.accountRepo.getWorkflows();
      const activeWorkflowId = await this.accountRepo.getActiveWorkflowId();
      let accountsToExport = accounts;

      if (customEmails && customEmails.length > 0) {
        const emailSet = new Set(customEmails.map(e => e.toLowerCase()));
        accountsToExport = accounts.filter(a => emailSet.has(a.email.toLowerCase()));
      } else if (targetWorkflowId !== undefined) {
        if (targetWorkflowId === null) {
          accountsToExport = accounts;
        } else if (targetWorkflowId === 'uncategorized') {
          accountsToExport = accounts.filter(a => !a.workflow);
        } else {
          accountsToExport = accounts.filter(a => a.workflow === targetWorkflowId);
        }
      } else if (workflows.length > 0) {
        interface ExportOption extends vscode.QuickPickItem {
          targetWorkflowId?: string | null;
        }

        const options: ExportOption[] = [
          {
            label: `$(archive) ${i18n.t('workflows.exportAll', { count: accounts.length })}`,
            targetWorkflowId: null,
          }
        ];

        // Active workflow if any
        if (activeWorkflowId && activeWorkflowId !== 'all') {
          if (activeWorkflowId === 'uncategorized') {
            const count = accounts.filter(a => !a.workflow).length;
            options.push({
              label: `$(file) ${i18n.t('workflows.exportUncategorized', { count })}`,
              description: i18n.t('webview.active') || 'Activo',
              targetWorkflowId: 'uncategorized',
            });
          } else {
            const activeWf = workflows.find(w => w.id === activeWorkflowId);
            if (activeWf) {
              const count = accounts.filter(a => a.workflow === activeWorkflowId).length;
              options.push({
                label: `$(folder-active) ${i18n.t('workflows.exportWorkflow', { name: activeWf.name, count })}`,
                description: i18n.t('webview.active') || 'Activo',
                targetWorkflowId: activeWorkflowId,
              });
            }
          }
        }

        // Other workflows
        for (const wf of workflows) {
          if (wf.id === activeWorkflowId) continue;
          const count = accounts.filter(a => a.workflow === wf.id).length;
          options.push({
            label: `$(folder) ${i18n.t('workflows.exportWorkflow', { name: wf.name, count })}`,
            targetWorkflowId: wf.id,
          });
        }

        // Uncategorized if not already added
        if (activeWorkflowId !== 'uncategorized') {
          const uncategorizedCount = accounts.filter(a => !a.workflow).length;
          if (uncategorizedCount > 0) {
            options.push({
              label: `$(file) ${i18n.t('workflows.exportUncategorized', { count: uncategorizedCount })}`,
              targetWorkflowId: 'uncategorized',
            });
          }
        }

        const picked = await vscode.window.showQuickPick(options, {
          placeHolder: i18n.t('workflows.exportTitle'),
        });

        if (!picked) return; // User cancelled

        if (picked.targetWorkflowId === 'uncategorized') {
          accountsToExport = accounts.filter(a => !a.workflow);
        } else if (picked.targetWorkflowId) {
          accountsToExport = accounts.filter(a => a.workflow === picked.targetWorkflowId);
        }
      }

      if (accountsToExport.length === 0) {
        vscode.window.showWarningMessage(i18n.t('accounts.noValidExportData'));
        return;
      }

      // ── Step 2: Ask user for an encryption password ──
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

      // ── Step 3: Confirm password ──
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

      // ── Step 4: Collect account data ──
      const exportedAccounts: ExportedAccount[] = [];
      for (const acc of accountsToExport) {
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
      let backupFileName = 'antigravity-backup.json';
      if (targetWorkflowId && targetWorkflowId !== 'uncategorized') {
        const wf = workflows.find(w => w.id === targetWorkflowId);
        if (wf) {
          backupFileName = `antigravity-backup-${wf.name.replace(/[^a-zA-Z0-9_-]/g, '_')}.json`;
        }
      } else if (customEmails && customEmails.length > 0) {
        backupFileName = `antigravity-backup-selected-${customEmails.length}.json`;
      }
      const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri;
      const defaultUri = workspaceFolder
        ? vscode.Uri.joinPath(workspaceFolder, backupFileName)
        : vscode.Uri.file(path.join(os.homedir(), 'Desktop', backupFileName));

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

      this._view?.webview.postMessage({ command: 'hideLoading' });

      // ── Step: Ask user where to import these accounts ──
      const existingWorkflows = await this.accountRepo.getWorkflows();
      let targetWorkflowId: string | undefined | null = null; // null = preserve / default, undefined = uncategorized, string = specific wf

      interface ImportOption extends vscode.QuickPickItem {
        action: 'keep' | 'workflow' | 'create';
        workflowId?: string;
      }

      const importOptions: ImportOption[] = [
        {
          label: `$(archive) ${i18n.t('workflows.importKeep')}`,
          description: i18n.t('webview.sortDefault') || 'Original',
          action: 'keep',
        },
      ];

      for (const wf of existingWorkflows) {
        importOptions.push({
          label: `$(folder) ${i18n.t('workflows.importToWorkflow', { name: wf.name })}`,
          action: 'workflow',
          workflowId: wf.id,
        });
      }

      importOptions.push({
        label: `$(plus) ${i18n.t('workflows.importCreateNew')}`,
        action: 'create',
      });

      const selectedImportOption = await vscode.window.showQuickPick(importOptions, {
        placeHolder: i18n.t('workflows.importTitle'),
      });

      if (!selectedImportOption) {
        return; // User cancelled import
      }

      if (selectedImportOption.action === 'create') {
        const newWfName = await vscode.window.showInputBox({
          prompt: i18n.t('workflows.createPrompt'),
          placeHolder: i18n.t('workflows.createPlaceholder'),
          validateInput: (val) => {
            if (!val || !val.trim()) return i18n.t('workflows.createPlaceholder');
            return undefined;
          }
        });
        if (!newWfName) {
          return; // User cancelled
        }
        const newWfId = 'wf_' + Date.now();
        await this.accountRepo.saveWorkflow({
          id: newWfId,
          name: newWfName.trim(),
          createdAt: new Date().toISOString(),
        });
        targetWorkflowId = newWfId;
      } else if (selectedImportOption.action === 'workflow') {
        targetWorkflowId = selectedImportOption.workflowId;
      } else {
        targetWorkflowId = null; // keep
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

        const finalWorkflow = (targetWorkflowId === null)
          ? entry.account.workflow
          : targetWorkflowId;

        // Save the account
        await this.accountRepo.saveAccount({
          email: entry.account.email,
          name: entry.account.name,
          avatarUrl: entry.account.avatarUrl,
          projectId: entry.account.projectId,
          accessToken: entry.tokens.accessToken,
          refreshToken: entry.tokens.refreshToken,
          expiresAt: entry.tokens.expiresAt,
          workflow: finalWorkflow,
        });

        // Restore balances and other metadata
        await this.accountRepo.updateAccount(entry.email, {
          balances: entry.account.balances || {},
          plan: entry.account.plan,
          status: entry.account.status,
          alias: entry.account.alias,
          hasDeviceProfile: !!entry.deviceProfile,
          workflow: finalWorkflow,
        });

        // Restore device profile if available
        if (entry.deviceProfile) {
          await this.accountRepo.storeDeviceProfile(entry.email, entry.deviceProfile);
        }

        importedCount++;
        logger.info(`Import: Added ${entry.email}.`);
      }

      if (targetWorkflowId) {
        await this.accountRepo.setActiveWorkflowId(targetWorkflowId);
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
    let effectiveLang = configLanguage;
    if (effectiveLang === 'auto') {
      const fullLang = (vscode.env.language || '').toLowerCase();
      const editorLang = fullLang.split('-')[0];
      if (fullLang.startsWith('zh')) {
        effectiveLang = 'zh-CN';
      } else if (fullLang.startsWith('pt')) {
        effectiveLang = 'pt-BR';
      } else if (['ar', 'es', 'fr', 'de', 'ja', 'ru', 'ko'].includes(editorLang)) {
        effectiveLang = editorLang;
      } else {
        effectiveLang = 'en';
      }
    }
    i18n.setLocale(effectiveLang);

    const configTheme = vscode.workspace.getConfiguration('antigravityAccount').get<string>('theme', 'dark-purple');
    const configAutoRefresh = vscode.workspace.getConfiguration('antigravityAccount').get<boolean>('autoRefreshEnabled', false);
    const configAutoRotate = vscode.workspace.getConfiguration('antigravityAccount').get<boolean>('autoRotateEnabled', false);
    const configLowCreditNotifications = vscode.workspace.getConfiguration('antigravityAccount').get<boolean>('lowCreditNotificationsEnabled', true);
    const configRefreshInterval = vscode.workspace.getConfiguration('antigravityAccount').get<number>('refreshIntervalMinutes', 0);
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
    const configAutoCapture = vscode.workspace.getConfiguration('antigravityAccount').get<boolean>('autoCaptureAccounts', true);
    const configAutoResumeChat = vscode.workspace.getConfiguration('antigravityAccount').get<boolean>('autoResumeChat', true);
    const configAutoResumePrompt = vscode.workspace.getConfiguration('antigravityAccount').get<string>('autoResumePrompt', 'continua');
    const configAdaptivePolling = vscode.workspace.getConfiguration('antigravityAccount').get<boolean>('adaptiveQuotaPolling', true);
    const configNoticeDuration = vscode.workspace.getConfiguration('antigravityAccount').get<number>('noticeDurationSeconds', 0);
    const configConfirmOnSwitch = vscode.workspace.getConfiguration('antigravityAccount').get<boolean>('confirmOnSwitch', false);
    const configShowNotifications = vscode.workspace.getConfiguration('antigravityAccount').get<boolean>('showNotifications', false);
    const nativeAuthEmail = this._cachedNativeAuthEmail;
    const accounts = await this.accountRepo.getAccountSummaries();
    this._workflows = await this.accountRepo.getWorkflows();
    const activeWorkflowId = await this.accountRepo.getActiveWorkflowId();

    let sessionMismatchBannerHtml = '';
    if (nativeAuthEmail && this._pinnedActiveEmail && !isEmailMatch(nativeAuthEmail, this._pinnedActiveEmail)) {
      sessionMismatchBannerHtml = `
        <div class="session-mismatch-banner" style="background:rgba(234, 179, 8, 0.12); border:1px solid rgba(234, 179, 8, 0.35); border-radius:8px; padding:10px 12px; margin:0 0 12px 0; display:flex; align-items:center; justify-content:space-between; gap:8px;">
          <div style="display:flex; align-items:center; gap:8px; font-size:0.82rem; line-height:1.35; color:var(--text-primary);">
            <svg style="width:16px; height:16px; color:#eab308; flex-shrink:0;" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
            <span>${i18n.t('accounts.nativeSessionMismatch', { nativeEmail: nativeAuthEmail, activeEmail: this._pinnedActiveEmail })}</span>
          </div>
          <button class="btn btn-primary" onclick="sendMessage('switchAccount', '${nativeAuthEmail}')" style="padding:4px 10px; font-size:0.78rem; white-space:nowrap; flex-shrink:0;">
            ${i18n.t('accounts.activate')}
          </button>
        </div>
      `;
    }

    // ── Preferred Model Resolution ──
    // Extract available model keys from all accounts with balances (after filtering)
    // and guarantee that standard IDE models are always present in the list.
    const availableModelKeysSet = new Set<string>([
      'Sonnet 5.5',
      'Opus 5.5',
      'Sonnet 4.6',
      'Opus 4.6',
      '3.8 Flash (High)',
      '3.8 Flash (Med)',
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
    if (!this._pinnedActiveEmail) {
      try {
        const liveActive = await this.accountService.getActiveAntigravityEmail();
        if (liveActive) {
          this._pinnedActiveEmail = liveActive.toLowerCase();
        }
      } catch {}
    }
    const pinnedEmailLower = this._pinnedActiveEmail;
    
    // Set isActive flag based on the pinned email
    accounts.forEach(acc => {
      acc.isActive = (pinnedEmailLower !== null && isEmailMatch(acc.email, pinnedEmailLower));
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
      acc.isActive = (this._pinnedActiveEmail !== null && isEmailMatch(acc.email, this._pinnedActiveEmail));
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

    // Generate Workflows Navigation Bar HTML
    const totalAccounts = accounts.length;
    const uncategorizedCount = accounts.filter(a => !a.workflow).length;

    let workflowChipsHtml = `
      <button class="workflow-chip ${!activeWorkflowId || activeWorkflowId === 'all' ? 'active' : ''}" data-workflow-id="all" onclick="selectWorkflowFilter('all')">
        <span>${i18n.t('workflows.all')}</span>
        <span class="workflow-chip-count">${totalAccounts}</span>
      </button>
    `;

    for (const wf of this._workflows) {
      const count = accounts.filter(a => a.workflow === wf.id).length;
      const isActive = activeWorkflowId === wf.id;
      workflowChipsHtml += `
        <div class="workflow-chip ${isActive ? 'active' : ''}" data-workflow-id="${wf.id}" onclick="selectWorkflowFilter('${wf.id}')">
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>
          <span>${wf.name}</span>
          <span class="workflow-chip-count">${count}</span>
          <span class="workflow-chip-btn" onclick="showWorkflowActions(event, '${wf.id}', '${wf.name.replace(/'/g, "\\'")}')" title="${i18n.t('accounts.more')}">
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="12" cy="12" r="1.5"/><circle cx="12" cy="5" r="1.5"/><circle cx="12" cy="19" r="1.5"/></svg>
          </span>
        </div>
      `;
    }

    if (uncategorizedCount > 0 && this._workflows.length > 0) {
      const isActive = activeWorkflowId === 'uncategorized';
      workflowChipsHtml += `
        <button class="workflow-chip ${isActive ? 'active' : ''}" data-workflow-id="uncategorized" onclick="selectWorkflowFilter('uncategorized')">
          <span>${i18n.t('workflows.uncategorized')}</span>
          <span class="workflow-chip-count">${uncategorizedCount}</span>
        </button>
      `;
    }

    workflowChipsHtml += `
      <button class="btn-new-workflow" onclick="handleCreateWorkflow()" title="${i18n.t('workflows.newWorkflow')}">
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
        <span>${i18n.t('workflows.newWorkflow')}</span>
      </button>
    `;

    const workflowBarHtml = `
      <div class="workflow-bar" id="workflowBar">
        ${workflowChipsHtml}
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
          .toolbar-bulk-btn, .toolbar-autoswitch-btn {
            display: inline-flex;
            align-items: center;
            justify-content: center;
            gap: 4px;
            background: var(--surface-subtle);
            border: 1px solid var(--border-color);
            border-radius: 8px;
            padding: 6px 9px;
            color: var(--text-secondary);
            font-size: 0.72rem;
            font-weight: 600;
            cursor: pointer;
            transition: all 0.15s ease;
            white-space: nowrap;
            user-select: none;
          }
          .toolbar-bulk-btn:hover, .toolbar-autoswitch-btn:hover {
            border-color: var(--focus-border);
            color: var(--text-primary);
            background: var(--surface-light);
          }
          .toolbar-autoswitch-btn.active {
            border-color: rgba(16, 185, 129, 0.4);
            color: var(--success-color);
            background: rgba(16, 185, 129, 0.12);
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
          .actions-disabled .btn-activate {
            opacity: 1 !important;
            pointer-events: auto !important;
            cursor: pointer !important;
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

          /* ── Workflows Bar ── */
          .workflow-bar {
            display: flex;
            align-items: center;
            gap: 6px;
            padding: 4px 2px 8px 2px;
            margin-bottom: 6px;
            overflow-x: auto;
            scrollbar-width: thin;
            scrollbar-color: var(--border-color) transparent;
          }
          .workflow-bar::-webkit-scrollbar {
            height: 3px;
          }
          .workflow-bar::-webkit-scrollbar-thumb {
            background: var(--border-color);
            border-radius: 3px;
          }
          .workflow-chip {
            display: inline-flex;
            align-items: center;
            gap: 5px;
            padding: 4px 10px;
            border-radius: 12px;
            font-size: 0.74rem;
            font-weight: 500;
            background: var(--surface-light);
            color: var(--text-secondary);
            border: 1px solid var(--border-color);
            cursor: pointer;
            white-space: nowrap;
            transition: all 0.15s ease;
            user-select: none;
            outline: none;
          }
          .workflow-chip:hover {
            background: var(--hover-bg);
            color: var(--text-primary);
            border-color: var(--focus-border);
          }
          .workflow-chip.active {
            background: var(--primary-gradient);
            color: #fff;
            border-color: transparent;
            box-shadow: 0 2px 8px rgba(124, 58, 237, 0.35);
            font-weight: 600;
          }
          .workflow-chip-count {
            font-size: 0.68rem;
            opacity: 0.85;
            background: rgba(255, 255, 255, 0.12);
            padding: 1px 5px;
            border-radius: 8px;
            margin-inline-start: 2px;
          }
          .workflow-chip.active .workflow-chip-count {
            background: rgba(0, 0, 0, 0.25);
            color: #fff;
          }
          .workflow-chip-btn {
            display: inline-flex;
            align-items: center;
            justify-content: center;
            padding: 2px;
            margin-inline-start: 2px;
            border-radius: 4px;
            opacity: 0.65;
            transition: opacity 0.12s, background 0.12s;
            cursor: pointer;
          }
          .workflow-chip-btn:hover {
            opacity: 1;
            background: rgba(255, 255, 255, 0.15);
          }
          .btn-new-workflow {
            display: inline-flex;
            align-items: center;
            gap: 4px;
            padding: 4px 10px;
            border-radius: 12px;
            font-size: 0.74rem;
            font-weight: 500;
            background: transparent;
            color: var(--primary-light, #a78bfa);
            border: 1px dashed var(--focus-border);
            cursor: pointer;
            white-space: nowrap;
            transition: all 0.15s ease;
            outline: none;
          }
          .btn-new-workflow:hover {
            background: rgba(124, 58, 237, 0.12);
            color: #fff;
            border-style: solid;
          }

          /* ── Card Workflow Badge & Bulk Selection ── */
          .card-wf-tag {
            display: inline-flex;
            align-items: center;
            gap: 3px;
            padding: 1px 5px;
            border-radius: 4px;
            font-size: 0.65rem;
            font-weight: 500;
            line-height: 1.2;
            background: rgba(124, 58, 237, 0.15);
            color: #c4b5fd;
            border: 1px solid rgba(124, 58, 237, 0.35);
            cursor: pointer;
            max-width: 95px;
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
            user-select: none;
            transition: all 0.15s ease;
            flex-shrink: 0;
          }
          .card-wf-tag:hover {
            background: rgba(124, 58, 237, 0.3);
            border-color: var(--focus-border);
            color: #fff;
          }
          .card-wf-add-btn {
            display: inline-flex;
            align-items: center;
            justify-content: center;
            background: transparent;
            border: none;
            padding: 1px 3px;
            cursor: pointer;
            color: var(--text-muted);
            opacity: 0.45;
            transition: opacity 0.15s ease, color 0.15s ease;
            flex-shrink: 0;
          }
          .card-wf-add-btn:hover {
            opacity: 1;
            color: var(--primary-light);
          }
          .account-card:hover .card-wf-add-btn {
            opacity: 0.85;
          }
          .card-bulk-check {
            display: none;
            width: 15px;
            height: 15px;
            cursor: pointer;
            accent-color: var(--primary-color);
            align-self: center;
            flex-shrink: 0;
            margin-inline-end: 6px;
          }
          body.bulk-mode .card-bulk-check {
            display: block;
          }
          body.bulk-mode .account-card {
            cursor: pointer;
          }
          body.bulk-mode .account-card.selected-for-bulk {
            border-color: var(--primary-light) !important;
            background: rgba(124, 58, 237, 0.08) !important;
          }
          .toolbar-bulk-btn {
            display: inline-flex;
            align-items: center;
            gap: 4px;
            padding: 4px 8px;
            font-size: 0.74rem;
            font-weight: 500;
            background: var(--surface-light);
            color: var(--text-secondary);
            border: 1px solid var(--border-color);
            border-radius: 6px;
            cursor: pointer;
            transition: all 0.15s ease;
            white-space: nowrap;
          }
          .toolbar-bulk-btn:hover, body.bulk-mode .toolbar-bulk-btn {
            background: var(--primary-color);
            color: #fff;
            border-color: var(--primary-color);
          }
          .bulk-action-bar {
            position: sticky;
            bottom: 10px;
            margin-top: 10px;
            padding: 8px 12px;
            background: var(--surface-color);
            border: 1px solid var(--focus-border);
            box-shadow: 0 4px 20px rgba(0, 0, 0, 0.45);
            border-radius: 10px;
            display: flex;
            align-items: center;
            justify-content: space-between;
            gap: 8px;
            z-index: 999;
            backdrop-filter: blur(8px);
            animation: slideUp 0.2s ease-out;
          }
          @keyframes slideUp {
            from { transform: translateY(20px); opacity: 0; }
            to { transform: translateY(0); opacity: 1; }
          }
          .bulk-info {
            font-size: 0.78rem;
            font-weight: 600;
            color: var(--text-primary);
          }
          .bulk-buttons {
            display: flex;
            align-items: center;
            gap: 6px;
          }
          .btn-bulk-action {
            padding: 3px 8px;
            font-size: 0.72rem;
            font-weight: 500;
            background: var(--surface-light);
            color: var(--text-primary);
            border: 1px solid var(--border-color);
            border-radius: 5px;
            cursor: pointer;
          }
          .btn-bulk-action:hover {
            background: var(--surface-color);
            border-color: var(--text-secondary);
          }
          .btn-bulk-primary {
            background: var(--primary-color) !important;
            color: #fff !important;
            border-color: var(--primary-color) !important;
          }
          .btn-bulk-primary:hover {
            background: var(--primary-light) !important;
          }
          .btn-bulk-export {
            display: inline-flex;
            align-items: center;
            justify-content: center;
            padding: 3px 7px;
          }
          .workflow-hidden {
            display: none !important;
          }
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
          <button type="button" class="toolbar-autoswitch-btn ${configAutoRotate ? 'active' : ''}" id="btnToggleAutoSwitch" onclick="sendMessage('toggleAutoSwitch')" title="${configAutoRotate ? i18n.t('settings.autoSwitchEnabled') : i18n.t('settings.autoSwitchDisabled')}">
            <svg class="icon-svg" style="width:11px; height:11px;" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="17 1 21 5 17 9"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><polyline points="7 23 3 19 7 15"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/></svg>
            <span class="autoswitch-btn-text">Auto: ${configAutoRotate ? 'ON' : 'OFF'}</span>
          </button>
          <button type="button" class="toolbar-bulk-btn" id="btnToggleBulk" onclick="toggleBulkSelectMode()" title="${i18n.t('workflows.bulkSelect')}">
            <svg class="icon-svg" style="width:12px; height:12px;" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="m9 11 3 3L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/></svg>
            <span class="bulk-btn-text">${i18n.t('workflows.bulkSelect')}</span>
          </button>
        </div>` : ''}

        ${accounts.length > 0 || this._workflows.length > 0 ? workflowBarHtml : ''}

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
          <!-- Session Mismatch Banner -->
          ${sessionMismatchBannerHtml}
          ${accountCardsHtml}
          <!-- Search No Results -->
          <div id="searchNoResults" class="search-no-results">
            <div class="search-no-results-icon">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="width:48px; height:48px; opacity:0.4; color:var(--text-secondary); margin-bottom: 8px;"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
            </div>
            <p>${i18n.t('accounts.noSearchResults')}</p>
        </div>

        <!-- Bulk Action Bar -->
        <div id="bulkActionBar" class="bulk-action-bar" style="display:none;">
          <div class="bulk-info">
            <span id="bulkSelectedText">0 ${i18n.t('workflows.bulkSelected')}</span>
          </div>
          <div class="bulk-buttons">
            <button type="button" class="btn-bulk-action" onclick="selectAllBulk(true)">${i18n.t('workflows.all')}</button>
            <button type="button" class="btn-bulk-action" onclick="selectAllBulk(false)">✕</button>
            <button type="button" class="btn-bulk-action btn-bulk-primary" onclick="bulkAssignWorkflow()">${i18n.t('workflows.bulkAssign')}</button>
            <button type="button" class="btn-bulk-action btn-bulk-export" onclick="bulkExportSelected()" title="${i18n.t('workflows.bulkExport')}">
              <svg style="width:12px; height:12px;" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
            </button>
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

              <!-- Auto-Capture Native Logins -->
              <div style="display:flex; align-items:center; justify-content:space-between; margin-bottom:8px; margin-top:14px;">
                <label for="autoCaptureToggle" style="font-weight:bold; cursor:pointer;">${i18n.t('webview.autoCaptureLabel')}</label>
                <label style="position:relative; display:inline-block; width:40px; height:22px; cursor:pointer;">
                  <input type="checkbox" id="autoCaptureToggle" ${configAutoCapture ? 'checked' : ''} onchange="onAutoCaptureToggle()" style="opacity:0; width:0; height:0;">
                  <span id="autoCaptureTrack" style="position:absolute; inset:0; background:${configAutoCapture ? '#4caf50' : 'var(--glass-border)'}; border-radius:11px; transition:background 0.3s, box-shadow 0.3s; ${configAutoCapture ? 'box-shadow:0 0 6px rgba(76,175,80,0.4);' : ''}"></span>
                  <span id="autoCaptureSlider" style="position:absolute; top:2px; ${isRtl ? 'right' : 'left'}:2px; width:18px; height:18px; background:var(--text-primary); border-radius:50%; transition:0.3s; ${configAutoCapture ? (isRtl ? 'right:20px' : 'left:20px') : ''}"></span>
                </label>
              </div>
              <p style="font-size:0.82em; opacity:0.65; margin:0 0 12px 0;">${i18n.t('webview.autoCaptureDescription')}</p>

              <!-- Dynamic Adaptive Quota Polling (< 10%) -->
              <div style="display:flex; align-items:center; justify-content:space-between; margin-bottom:8px; margin-top:14px;">
                <label for="adaptivePollingToggle" style="font-weight:bold; cursor:pointer;">${i18n.t('webview.adaptiveQuotaPollingLabel')}</label>
                <label style="position:relative; display:inline-block; width:40px; height:22px; cursor:pointer;">
                  <input type="checkbox" id="adaptivePollingToggle" ${configAdaptivePolling ? 'checked' : ''} onchange="onAdaptivePollingToggle()" style="opacity:0; width:0; height:0;">
                  <span id="adaptivePollingTrack" style="position:absolute; inset:0; background:${configAdaptivePolling ? '#4caf50' : 'var(--glass-border)'}; border-radius:11px; transition:background 0.3s, box-shadow 0.3s; ${configAdaptivePolling ? 'box-shadow:0 0 6px rgba(76,175,80,0.4);' : ''}"></span>
                  <span id="adaptivePollingSlider" style="position:absolute; top:2px; ${isRtl ? 'right' : 'left'}:2px; width:18px; height:18px; background:var(--text-primary); border-radius:50%; transition:0.3s; ${configAdaptivePolling ? (isRtl ? 'right:20px' : 'left:20px') : ''}"></span>
                </label>
              </div>
              <p style="font-size:0.82em; opacity:0.65; margin:0 0 12px 0;">${i18n.t('webview.adaptiveQuotaPollingDescription')}</p>

              <!-- Chat Auto-Resume on Depletion -->
              <div style="display:flex; align-items:center; justify-content:space-between; margin-bottom:8px; margin-top:14px;">
                <label for="autoResumeChatToggle" style="font-weight:bold; cursor:pointer;">${i18n.t('webview.autoResumeChatLabel')}</label>
                <label style="position:relative; display:inline-block; width:40px; height:22px; cursor:pointer;">
                  <input type="checkbox" id="autoResumeChatToggle" ${configAutoResumeChat ? 'checked' : ''} onchange="onAutoResumeChatToggle()" style="opacity:0; width:0; height:0;">
                  <span id="autoResumeChatTrack" style="position:absolute; inset:0; background:${configAutoResumeChat ? '#4caf50' : 'var(--glass-border)'}; border-radius:11px; transition:background 0.3s, box-shadow 0.3s; ${configAutoResumeChat ? 'box-shadow:0 0 6px rgba(76,175,80,0.4);' : ''}"></span>
                  <span id="autoResumeChatSlider" style="position:absolute; top:2px; ${isRtl ? 'right' : 'left'}:2px; width:18px; height:18px; background:var(--text-primary); border-radius:50%; transition:0.3s; ${configAutoResumeChat ? (isRtl ? 'right:20px' : 'left:20px') : ''}"></span>
                </label>
              </div>
              <p style="font-size:0.82em; opacity:0.65; margin:0 0 12px 0;">${i18n.t('webview.autoResumeChatDescription')}</p>

              <!-- Auto-Resume Prompt -->
              <div id="autoResumePromptGroup" style="margin-bottom: 14px; ${configAutoResumeChat ? '' : 'opacity:0.4; pointer-events:none;'}">
                <label for="autoResumePromptInput" style="display:block; margin-bottom:6px; font-weight:bold; font-size:0.9em;">${i18n.t('webview.autoResumePromptLabel')}</label>
                <input type="text" id="autoResumePromptInput" value="${(configAutoResumePrompt || '').replace(/"/g, '&quot;')}" style="width:100%; box-sizing:border-box; padding:8px; background:var(--vscode-input-background); color:var(--vscode-input-foreground); border:1px solid var(--vscode-input-border); border-radius:4px;" placeholder="continua">
                <p style="font-size:0.82em; opacity:0.65; margin:6px 0 0 0;">${i18n.t('webview.autoResumePromptDescription')}</p>
              </div>

              <!-- Notice Duration Before Switch -->
              <div style="margin-bottom: 14px; margin-top:14px;">
                <label for="noticeDurationSelect" style="display:block; margin-bottom:6px; font-weight:bold; font-size:0.9em;">${i18n.t('webview.noticeDurationLabel')}</label>
                <select id="noticeDurationSelect" style="width:100%; padding:8px; background:var(--vscode-dropdown-background); color:var(--vscode-dropdown-foreground); border:1px solid var(--vscode-dropdown-border); border-radius:4px;">
                  <option value="0" ${configNoticeDuration === 0 ? 'selected' : ''}>0s (${i18n.t('webview.intervalImmediate')})</option>
                  <option value="3" ${configNoticeDuration === 3 ? 'selected' : ''}>3s</option>
                  <option value="5" ${configNoticeDuration === 5 ? 'selected' : ''}>5s</option>
                  <option value="10" ${configNoticeDuration === 10 ? 'selected' : ''}>10s</option>
                </select>
                <p style="font-size:0.82em; opacity:0.65; margin:6px 0 0 0;">${i18n.t('webview.noticeDurationDescription')}</p>
              </div>

              <!-- Confirm Before Account Switch -->
              <div style="display:flex; align-items:center; justify-content:space-between; margin-bottom:8px; margin-top:14px;">
                <label for="confirmOnSwitchToggle" style="font-weight:bold; cursor:pointer;">${i18n.t('webview.confirmOnSwitchLabel')}</label>
                <label style="position:relative; display:inline-block; width:40px; height:22px; cursor:pointer;">
                  <input type="checkbox" id="confirmOnSwitchToggle" ${configConfirmOnSwitch ? 'checked' : ''} onchange="onConfirmOnSwitchToggle()" style="opacity:0; width:0; height:0;">
                  <span id="confirmOnSwitchTrack" style="position:absolute; inset:0; background:${configConfirmOnSwitch ? '#4caf50' : 'var(--glass-border)'}; border-radius:11px; transition:background 0.3s, box-shadow 0.3s; ${configConfirmOnSwitch ? 'box-shadow:0 0 6px rgba(76,175,80,0.4);' : ''}"></span>
                  <span id="confirmOnSwitchSlider" style="position:absolute; top:2px; ${isRtl ? 'right' : 'left'}:2px; width:18px; height:18px; background:var(--text-primary); border-radius:50%; transition:0.3s; ${configConfirmOnSwitch ? (isRtl ? 'right:20px' : 'left:20px') : ''}"></span>
                </label>
              </div>
              <p style="font-size:0.82em; opacity:0.65; margin:0 0 12px 0;">${i18n.t('webview.confirmOnSwitchDescription')}</p>

              <!-- Verbose Notifications Toggle -->
              <div style="display:flex; align-items:center; justify-content:space-between; margin-bottom:8px; margin-top:14px;">
                <label for="showNotificationsToggle" style="font-weight:bold; cursor:pointer;">${i18n.t('webview.showNotificationsLabel')}</label>
                <label style="position:relative; display:inline-block; width:40px; height:22px; cursor:pointer;">
                  <input type="checkbox" id="showNotificationsToggle" ${configShowNotifications ? 'checked' : ''} onchange="onShowNotificationsToggle()" style="opacity:0; width:0; height:0;">
                  <span id="showNotificationsTrack" style="position:absolute; inset:0; background:${configShowNotifications ? '#4caf50' : 'var(--glass-border)'}; border-radius:11px; transition:background 0.3s, box-shadow 0.3s; ${configShowNotifications ? 'box-shadow:0 0 6px rgba(76,175,80,0.4);' : ''}"></span>
                  <span id="showNotificationsSlider" style="position:absolute; top:2px; ${isRtl ? 'right' : 'left'}:2px; width:18px; height:18px; background:var(--text-primary); border-radius:50%; transition:0.3s; ${configShowNotifications ? (isRtl ? 'right:20px' : 'left:20px') : ''}"></span>
                </label>
              </div>
              <p style="font-size:0.82em; opacity:0.65; margin:0 0 12px 0;">${i18n.t('webview.showNotificationsDescription')}</p>
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
          let currentPreferredModel = ${JSON.stringify(effectivePreferred)};
          let currentTheme = ${JSON.stringify(configTheme)};
          let currentLanguage = ${JSON.stringify(configLanguage)};
          let hasAccounts = ${accounts.length > 0};
          let currentAutoRefresh = ${configAutoRefresh};
          let currentAutoRotate = ${configAutoRotate};
          let currentLowCreditNotifications = ${configLowCreditNotifications};
          let currentRefreshInterval = ${configRefreshInterval};
          let currentSortBy = ${JSON.stringify(configSortBy)};
          let currentCacheDurationDays = ${configCacheDurationDays};
          let currentAutoCapture = ${configAutoCapture};
          let currentAdaptivePolling = ${configAdaptivePolling};
          let currentAutoResumeChat = ${configAutoResumeChat};
          let currentAutoResumePrompt = ${JSON.stringify(configAutoResumePrompt)};
          let currentNoticeDuration = ${configNoticeDuration};
          let currentConfirmOnSwitch = ${configConfirmOnSwitch};
          let currentShowNotifications = ${configShowNotifications};
          const isRtlDir = ${isRtl};
          const savedSearchQuery = ${JSON.stringify(this._searchQuery)};

          let settingsInactivityTimer = null;
          function resetSettingsInactivityTimer() {
            if (settingsInactivityTimer) clearTimeout(settingsInactivityTimer);
            // 3-minute inactivity timeout (resets on mouse/keyboard activity)
            settingsInactivityTimer = setTimeout(() => {
              const modal = document.getElementById('settingsModal');
              if (modal && modal.style.display !== 'none') {
                closeSettings();
              }
            }, 180000);
          }
          
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
            }

            // If a specific workflow is active (or search query is active), refresh only visible accounts!
            if (currentWorkflowFilter !== 'all' || query) {
              const visibleCards = document.querySelectorAll('.account-card:not(.workflow-hidden):not(.search-hidden)');
              if (visibleCards.length === 0) return; // No visible results, do nothing
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
            // Target only cards currently visible in the active workflow
            const cards = document.querySelectorAll('.account-card:not(.workflow-hidden)');

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
            const q = (query || '').toLowerCase().trim();

            if (clearBtn) clearBtn.style.display = q ? 'block' : 'none';

            let visibleCount = 0;
            cards.forEach(card => {
              const email = (card.dataset.email || '').toLowerCase();
              const name = (card.dataset.name || '').toLowerCase();
              const alias = (card.dataset.alias || '').toLowerCase();
              const textMatches = !q || email.includes(q) || name.includes(q) || alias.includes(q);

              if (textMatches) {
                card.classList.remove('search-hidden');
                if (!card.classList.contains('workflow-hidden')) {
                  visibleCount++;
                }
              } else {
                card.classList.add('search-hidden');
              }
            });

            if (noResults) noResults.style.display = (visibleCount === 0 && cards.length > 0) ? 'block' : 'none';
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
            // Keep search input available during refresh so users can search and switch accounts freely
            const input = document.getElementById('searchInput');
            if (input) input.disabled = false;
          }

          // ── Workflows ──
          let currentWorkflowFilter = ${JSON.stringify(activeWorkflowId || 'all')};

          function selectWorkflowFilter(workflowId) {
            currentWorkflowFilter = workflowId;
            document.querySelectorAll('#workflowBar .workflow-chip').forEach(chip => {
              chip.classList.toggle('active', chip.dataset.workflowId === workflowId);
            });
            applyWorkflowFilter(workflowId);
            vscode.postMessage({
              command: 'setActiveWorkflow',
              workflowId: workflowId === 'all' ? null : workflowId
            });
          }

          function applyWorkflowFilter(workflowId) {
            const cards = document.querySelectorAll('.account-card');
            const noResults = document.getElementById('searchNoResults');
            let visibleCount = 0;
            cards.forEach(card => {
              const cardWf = card.dataset.workflow || '';
              let match = false;
              if (workflowId === 'all') {
                match = true;
              } else if (workflowId === 'uncategorized') {
                match = !cardWf;
              } else {
                match = (cardWf === workflowId);
              }

              if (match) {
                card.classList.remove('workflow-hidden');
                if (!card.classList.contains('search-hidden')) {
                  visibleCount++;
                }
              } else {
                card.classList.add('workflow-hidden');
              }
            });

            if (noResults) noResults.style.display = (visibleCount === 0 && cards.length > 0) ? 'block' : 'none';
          }

          function handleAssignWorkflow(email) {
            vscode.postMessage({
              command: 'assignAccountWorkflow',
              email: email
            });
          }

          function handleCreateWorkflow() {
            vscode.postMessage({
              command: 'createWorkflow'
            });
          }

          function showWorkflowActions(e, wfId, wfName) {
            e.stopPropagation();
            vscode.postMessage({
              command: 'workflowOptions',
              workflowId: wfId,
              workflowName: wfName
            });
          }

          let isBulkMode = false;
          const selectedBulkEmails = new Set();

          function toggleBulkSelectMode() {
            isBulkMode = !isBulkMode;
            document.body.classList.toggle('bulk-mode', isBulkMode);
            const bar = document.getElementById('bulkActionBar');
            if (bar) bar.style.display = isBulkMode ? 'flex' : 'none';
            if (!isBulkMode) {
              selectedBulkEmails.clear();
            }
            updateBulkUI();
          }

          function handleCardCheck(checkbox, email) {
            if (checkbox.checked) {
              selectedBulkEmails.add(email);
            } else {
              selectedBulkEmails.delete(email);
            }
            updateBulkUI();
          }

          function updateBulkUI() {
            const countEl = document.getElementById('bulkSelectedText');
            if (countEl) {
              countEl.textContent = selectedBulkEmails.size + ' ${i18n.t('workflows.bulkSelected')}';
            }
            document.querySelectorAll('.account-card').forEach(card => {
              const email = card.dataset.email;
              const chk = card.querySelector('.card-bulk-check');
              if (selectedBulkEmails.has(email)) {
                card.classList.add('selected-for-bulk');
                if (chk) chk.checked = true;
              } else {
                card.classList.remove('selected-for-bulk');
                if (chk) chk.checked = false;
              }
            });
          }

          function selectAllBulk(select) {
            const cards = document.querySelectorAll('.account-card:not(.workflow-hidden):not(.search-hidden)');
            cards.forEach(card => {
              const email = card.dataset.email;
              if (select) {
                selectedBulkEmails.add(email);
              } else {
                selectedBulkEmails.delete(email);
              }
            });
            updateBulkUI();
          }

          function bulkAssignWorkflow() {
            if (selectedBulkEmails.size === 0) return;
            vscode.postMessage({
              command: 'bulkAssignWorkflow',
              emails: Array.from(selectedBulkEmails)
            });
          }

          function bulkExportSelected() {
            if (selectedBulkEmails.size === 0) return;
            vscode.postMessage({
              command: 'bulkExportAccounts',
              emails: Array.from(selectedBulkEmails)
            });
          }

          document.addEventListener('click', function(e) {
            if (!isBulkMode) return;
            const card = e.target.closest('.account-card');
            if (!card) return;
            if (e.target.closest('button') || e.target.closest('input') || e.target.closest('select') || e.target.closest('a')) return;
            const email = card.dataset.email;
            if (email) {
              if (selectedBulkEmails.has(email)) {
                selectedBulkEmails.delete(email);
              } else {
                selectedBulkEmails.add(email);
              }
              updateBulkUI();
            }
          });

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
            // Apply initial workflow filter
            applyWorkflowFilter(currentWorkflowFilter);
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

          function onAutoCaptureToggle() {
            const toggle = document.getElementById('autoCaptureToggle');
            const slider = document.getElementById('autoCaptureSlider');
            const track = document.getElementById('autoCaptureTrack');
            if (!toggle) return;
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

          function onAdaptivePollingToggle() {
            const toggle = document.getElementById('adaptivePollingToggle');
            const slider = document.getElementById('adaptivePollingSlider');
            const track = document.getElementById('adaptivePollingTrack');
            if (!toggle) return;
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

          function onAutoResumeChatToggle() {
            const toggle = document.getElementById('autoResumeChatToggle');
            const slider = document.getElementById('autoResumeChatSlider');
            const track = document.getElementById('autoResumeChatTrack');
            const promptGroup = document.getElementById('autoResumePromptGroup');
            if (!toggle) return;
            if (toggle.checked) {
              slider.style[isRtlDir ? 'right' : 'left'] = '20px';
              track.style.background = '#4caf50';
              track.style.boxShadow = '0 0 6px rgba(76,175,80,0.4)';
              if (promptGroup) {
                promptGroup.style.opacity = '1';
                promptGroup.style.pointerEvents = 'auto';
              }
            } else {
              slider.style[isRtlDir ? 'right' : 'left'] = '2px';
              track.style.background = 'var(--glass-border)';
              track.style.boxShadow = 'none';
              if (promptGroup) {
                promptGroup.style.opacity = '0.4';
                promptGroup.style.pointerEvents = 'none';
              }
            }
          }

          function onConfirmOnSwitchToggle() {
            const toggle = document.getElementById('confirmOnSwitchToggle');
            const slider = document.getElementById('confirmOnSwitchSlider');
            const track = document.getElementById('confirmOnSwitchTrack');
            if (!toggle) return;
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

          function onShowNotificationsToggle() {
            const toggle = document.getElementById('showNotificationsToggle');
            const slider = document.getElementById('showNotificationsSlider');
            const track = document.getElementById('showNotificationsTrack');
            if (!toggle) return;
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

            const autoCaptureToggle = document.getElementById('autoCaptureToggle');
            if (autoCaptureToggle) {
              autoCaptureToggle.checked = currentAutoCapture;
              onAutoCaptureToggle();
            }

            const adaptivePollingToggle = document.getElementById('adaptivePollingToggle');
            if (adaptivePollingToggle) {
              adaptivePollingToggle.checked = currentAdaptivePolling;
              onAdaptivePollingToggle();
            }

            const autoResumeChatToggle = document.getElementById('autoResumeChatToggle');
            if (autoResumeChatToggle) {
              autoResumeChatToggle.checked = currentAutoResumeChat;
              onAutoResumeChatToggle();
            }

            const autoResumePromptInput = document.getElementById('autoResumePromptInput');
            if (autoResumePromptInput) {
              autoResumePromptInput.value = currentAutoResumePrompt || 'continua';
            }

            const noticeDurationSelect = document.getElementById('noticeDurationSelect');
            if (noticeDurationSelect) {
              noticeDurationSelect.value = String(currentNoticeDuration);
            }

            const confirmOnSwitchToggle = document.getElementById('confirmOnSwitchToggle');
            if (confirmOnSwitchToggle) {
              confirmOnSwitchToggle.checked = currentConfirmOnSwitch;
              onConfirmOnSwitchToggle();
            }

            const showNotificationsToggle = document.getElementById('showNotificationsToggle');
            if (showNotificationsToggle) {
              showNotificationsToggle.checked = currentShowNotifications;
              onShowNotificationsToggle();
            }

            modal.style.display = 'flex';
            vscode.postMessage({ command: 'settingsOpened' });
            resetSettingsInactivityTimer();
            if (!modal._activityListenersAttached) {
              const resetTimer = () => resetSettingsInactivityTimer();
              modal.addEventListener('mousemove', resetTimer);
              modal.addEventListener('keydown', resetTimer);
              modal.addEventListener('click', resetTimer);
              modal._activityListenersAttached = true;
            }
            attachIntervalListener();
            } catch (err) {
              alert("Error in openSettings: " + err.message + "\\nStack:\\n" + err.stack);
            }
          }

          function closeSettingsModalOnly() {
            if (settingsInactivityTimer) {
              clearTimeout(settingsInactivityTimer);
              settingsInactivityTimer = null;
            }
            document.getElementById('settingsModal').style.display = 'none';
            document.getElementById('immediateConfirmOverlay').style.display = 'none';
            vscode.postMessage({ command: 'settingsClosed' });
          }

          function closeSettings() {
            closeSettingsModalOnly();
            // Revert live preview back to current active theme if user cancelled
            applyLiveTheme(currentTheme);
            const themeSelect = document.getElementById('themeSelect');
            if (themeSelect) themeSelect.value = currentTheme;
          }

          function saveSettings() {
            try {
              const themeSelect = document.getElementById('themeSelect');
              const selectedTheme = themeSelect ? themeSelect.value : 'dark-purple';
              currentTheme = selectedTheme;
              applyLiveTheme(selectedTheme);

              const select = document.getElementById('preferredModelSelect');
              const selectedModel = select ? select.value : '';
              const langSelect = document.getElementById('languageSelect');
              const selectedLang = langSelect ? langSelect.value : 'auto';
              const autoRefreshToggle = document.getElementById('autoRefreshToggle');
              const autoRefreshEnabled = autoRefreshToggle ? autoRefreshToggle.checked : true;
              const autoRotateToggle = document.getElementById('autoRotateToggle');
              const autoRotateEnabled = autoRotateToggle ? autoRotateToggle.checked : false;
              const lowCreditNotificationsToggle = document.getElementById('lowCreditNotificationsToggle');
              const lowCreditNotificationsEnabled = lowCreditNotificationsToggle ? lowCreditNotificationsToggle.checked : true;
              const intervalSelect = document.getElementById('refreshIntervalSelect');
              const refreshInterval = intervalSelect ? (parseInt(intervalSelect.value, 10) || 0) : 15;
              
              const sortBySettingsSelect = document.getElementById('sortBySettingsSelect');
              const selectedSortBy = sortBySettingsSelect ? sortBySettingsSelect.value : 'default';
              const cacheDurationSelect = document.getElementById('cacheDurationSelect');
              const selectedCacheDuration = cacheDurationSelect ? (parseInt(cacheDurationSelect.value, 10) || 7) : 7;

              const autoCaptureToggle = document.getElementById('autoCaptureToggle');
              const autoCaptureEnabled = autoCaptureToggle ? autoCaptureToggle.checked : true;

              const adaptivePollingToggle = document.getElementById('adaptivePollingToggle');
              const adaptivePollingEnabled = adaptivePollingToggle ? adaptivePollingToggle.checked : true;

              const autoResumeChatToggle = document.getElementById('autoResumeChatToggle');
              const autoResumeChatEnabled = autoResumeChatToggle ? autoResumeChatToggle.checked : true;

              const autoResumePromptInput = document.getElementById('autoResumePromptInput');
              const autoResumePrompt = autoResumePromptInput ? (autoResumePromptInput.value.trim() || 'continua') : 'continua';

              const noticeDurationSelect = document.getElementById('noticeDurationSelect');
              const noticeDuration = noticeDurationSelect ? (parseInt(noticeDurationSelect.value, 10) || 0) : 0;

              const confirmOnSwitchToggle = document.getElementById('confirmOnSwitchToggle');
              const confirmOnSwitch = confirmOnSwitchToggle ? confirmOnSwitchToggle.checked : false;

              const showNotificationsToggle = document.getElementById('showNotificationsToggle');
              const showNotificationsEnabled = showNotificationsToggle ? showNotificationsToggle.checked : false;

              currentLanguage = selectedLang;
              currentPreferredModel = selectedModel;
              currentAutoRefresh = autoRefreshEnabled;
              currentAutoRotate = autoRotateEnabled;
              currentLowCreditNotifications = lowCreditNotificationsEnabled;
              currentRefreshInterval = refreshInterval;
              currentSortBy = selectedSortBy;
              currentCacheDurationDays = selectedCacheDuration;
              currentAutoCapture = autoCaptureEnabled;
              currentAdaptivePolling = adaptivePollingEnabled;
              currentAutoResumeChat = autoResumeChatEnabled;
              currentAutoResumePrompt = autoResumePrompt;
              currentNoticeDuration = noticeDuration;
              currentConfirmOnSwitch = confirmOnSwitch;
              currentShowNotifications = showNotificationsEnabled;

              closeSettingsModalOnly();
              vscode.postMessage({ command: 'showLoading' });

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
                cacheDurationDays: selectedCacheDuration,
                autoCaptureAccounts: autoCaptureEnabled,
                adaptiveQuotaPolling: adaptivePollingEnabled,
                autoResumeChat: autoResumeChatEnabled,
                autoResumePrompt: autoResumePrompt,
                noticeDurationSeconds: noticeDuration,
                confirmOnSwitch: confirmOnSwitch,
                showNotifications: showNotificationsEnabled
              });
            } catch (err) {
              console.error('Error in saveSettings:', err);
              vscode.postMessage({ command: 'logError', message: 'Error in saveSettings: ' + err.message, stack: err.stack });
            }
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
              vscode.postMessage({ command: 'aliasEditingStarted', email });
              displayEl.style.display = 'none';
              editBtn.style.display = 'none';
              if (refreshBtn) refreshBtn.style.display = 'none';
              inputEl.style.display = 'inline-block';
              inputEl.focus();
              inputEl.select();
            }
          }

          function cancelEditAlias(email) {
            vscode.postMessage({ command: 'aliasEditingFinished', email });
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
            vscode.postMessage({ command: 'aliasEditingFinished', email });
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

                  // Re-apply workflow and search filters to preserve active view
                  applyWorkflowFilter(currentWorkflowFilter);
                  const sInput = document.getElementById('searchInput');
                  if (sInput && sInput.value.trim()) {
                    applySearchFilter(sInput.value);
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

            } else if (msg.command === 'settingsSavedToast') {
              const toast = document.getElementById('refreshToast');
              if (toast) {
                toast.textContent = '${i18n.t('settings.saved')}';
                toast.classList.add('visible');
                if (refreshToastTimeout) { clearTimeout(refreshToastTimeout); }
                refreshToastTimeout = setTimeout(() => {
                  toast.classList.remove('visible');
                  refreshToastTimeout = null;
                }, 4000);
              }
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
    const claudeKeys = keys.filter(k => {
      const lower = k.toLowerCase();
      return lower.includes('claude') || lower.includes('sonnet') || lower.includes('opus');
    });
    if (claudeKeys.length === 0) return undefined;

    return claudeKeys.sort((a, b) => {
      const aLower = a.toLowerCase();
      const bLower = b.toLowerCase();
      if ((bLower.includes('5.5') || bLower.includes('5-5')) && !(aLower.includes('5.5') || aLower.includes('5-5'))) return 1;
      if ((aLower.includes('5.5') || aLower.includes('5-5')) && !(bLower.includes('5.5') || bLower.includes('5-5'))) return -1;

      // Extract numbers to compare versions (e.g. 4-6 vs 3-5)
      const aMatch = a.match(/\d+(?:[.-]\d+)*/);
      const bMatch = b.match(/\d+(?:[.-]\d+)*/);
      
      if (!aMatch && !bMatch) return a.localeCompare(b);
      if (!aMatch) return 1;
      if (!bMatch) return -1;
      
      return bMatch[0].localeCompare(aMatch[0]);
    })[0];
  }

  /**
   * Extracts the balance value of a specific model from the raw balances object.
   */
  private getModelBalanceValue(balances: Record<string, any> | undefined, targetKey: string): number {
    return getModelBalanceValue(balances, targetKey);
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
        const prefVal = getModelBalanceValue(acc.balances, effectivePreferred);
        if (prefVal >= 0) return prefVal;
      }

      // 2. Primary Gemini model keys
      const primaryKeys = [
        'gemini-3.8-flash-tiered',
        'gemini-3.8-flash-high',
        'gemini-3.8-flash',
        'gemini-3.8-flash-med',
        'gemini-3.8-flash-medium',
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
        'gemini-3.8-flash-tiered',
        'gemini-3.8-flash-high',
        'gemini-3.8-flash',
        'gemini-3.8-flash-med',
        'gemini-3.8-flash-medium',
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
      const aActive = pinnedEmailLower !== null && isEmailMatch(a.email, pinnedEmailLower);
      const bActive = pinnedEmailLower !== null && isEmailMatch(b.email, pinnedEmailLower);
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
        normalizeModelKey(m.key).toLowerCase() === normalizedPref ||
        m.key.toLowerCase() === normalizedPref ||
        m.key.toLowerCase() === effectivePreferred.toLowerCase()
      );
      if (prefIdx === -1) {
        prefIdx = processedModels.findIndex(m => {
          const k = m.key.toLowerCase();
          const normK = normalizeModelKey(m.key).toLowerCase();
          return k.includes(normalizedPref) || normalizedPref.includes(k) ||
                 normK.includes(normalizedPref) || normalizedPref.includes(normK) ||
                 k.replace(/\s+/g, '') === normalizedPref.replace(/\s+/g, '');
        });
      }
      if (prefIdx > -1) {
        const [prefModel] = processedModels.splice(prefIdx, 1);
        preferredModelData = prefModel;
      } else {
        // Preferred model not in processedModels: check acc.balances directly
        const balanceEntry = getModelBalanceEntry(acc.balances, effectivePreferred);
        if (balanceEntry) {
          preferredModelData = balanceEntry;
        } else {
          preferredModelData = { key: effectivePreferred, value: 0 };
        }
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
        ${!acc.isActive ? `<button class="btn btn-primary btn-activate" onclick="handleSwitchAccount(this, '${acc.email}')">${i18n.t('accounts.activate')}</button>` : ''}
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

    const currentWf = acc.workflow ? this._workflows.find(w => w.id === acc.workflow) : undefined;
    const currentWfName = currentWf ? currentWf.name : (acc.workflow || '');

    const workflowBadgeHtml = currentWfName
      ? `<span class="card-wf-tag" onclick="event.stopPropagation(); handleAssignWorkflow('${acc.email}')" title="${currentWfName} · ${i18n.t('workflows.badgeTooltip')}">
           <svg class="icon-svg" style="width:10px; height:10px; flex-shrink:0;" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>
           <span>${currentWfName}</span>
         </span>`
      : `<button class="card-wf-add-btn" onclick="event.stopPropagation(); handleAssignWorkflow('${acc.email}')" title="${i18n.t('workflows.badgeTooltip')}">
           <svg class="icon-svg" style="width:11px; height:11px;" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/><line x1="12" y1="11" x2="12" y2="17"/><line x1="9" y1="14" x2="15" y2="14"/></svg>
         </button>`;

    return `
      <div class="account-card ${acc.isActive ? 'active' : ''} ${isExpired ? 'expired' : ''} ${isIneligible ? 'ineligible' : ''} ${acc.status === AccountStatus.DEPLETED ? 'depleted' : ''}" data-email="${acc.email}" data-name="${displayName}" data-alias="${acc.alias || ''}" data-status="${acc.status}" data-workflow="${acc.workflow || ''}" data-model-balances='${modelBalancesStr}'>
        <div class="card-header">
          <input type="checkbox" class="card-bulk-check" data-email="${acc.email}" onclick="event.stopPropagation(); handleCardCheck(this, '${acc.email}')" />
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
            <div class="user-email-row" style="display:flex; align-items:center; gap:5px; margin-top:2px;">
              <span class="user-email-text" style="font-size:0.75rem; color:var(--text-secondary); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; max-width:150px;" title="${acc.email}">${acc.email}</span>
              ${workflowBadgeHtml}
            </div>
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
