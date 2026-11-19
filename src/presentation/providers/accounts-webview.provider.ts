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
import { getWebviewStyles } from '../webview/styles/webview.styles';
import { getModalsHtml } from '../webview/templates/modals.template';
import { renderAccountCardHtml } from '../webview/templates/account-card.template';
import { getWebviewClientScript } from '../webview/scripts/webview.client';

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

  /** Concurrency and visibility guards to prevent Webview ServiceWorker InvalidStateError */
  private _isRendering: boolean = false;
  private _renderQueued: boolean = false;
  private _refreshDebounceTimer: NodeJS.Timeout | null = null;
  private _pendingRefreshOnVisible: boolean = false;

  /**
   * Debounces full HTML re-renders so rapid account updates (e.g., active quota polling,
   * batch refreshes, auth events) are coalesced into a single clean repaint without
   * destroying and recreating the webview iframe in rapid succession.
   */
  public debouncedRefresh(delayMs: number = 300): void {
    if (this._refreshDebounceTimer) {
      clearTimeout(this._refreshDebounceTimer);
    }
    this._refreshDebounceTimer = setTimeout(() => {
      this._refreshDebounceTimer = null;
      this.refresh().catch(err => {
        Logger.getInstance().error('Error during debounced refresh', err);
      });
    }, delayMs);
  }

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

    // Automatically re-detect active account and re-render when data changes (debounced & safe)
    this.accountService.onAccountsChanged(() => {
      // Do not recreate full HTML DOM during active scan since cards update individually
      if (!this._isRefreshingProgress.isRefreshing) {
        this.detectAndPinActiveAccount().then(() => this.debouncedRefresh(350));
      }
    });
  }

  /**
   * Asynchronously checks if the native IDE auth session differs from the pinned active account,
   * without blocking HTML generation or causing black screen delays.
   */
  private checkNativeAuthMismatch(): void {
    this.accountService.getNativeAuthEmail().then(async email => {
      if (email && email !== this._cachedNativeAuthEmail) {
        this._cachedNativeAuthEmail = email;
        const accounts = await this.accountRepo.getAllAccounts();
        const matched = accounts.find(a => isEmailMatch(a.email, email));
        if (matched && (!this._pinnedActiveEmail || !isEmailMatch(this._pinnedActiveEmail, email))) {
          this._pinnedActiveEmail = email.toLowerCase();
          await this.accountRepo.setActiveAccountEmail(email.toLowerCase());
          this.debouncedRefresh(200);
        } else if (this._view && this._pinnedActiveEmail && !isEmailMatch(email, this._pinnedActiveEmail)) {
          this.debouncedRefresh(200);
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
    this.reconcileRefreshProgress();
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

    // Clean up reference when the webview view is disposed
    webviewView.onDidDispose(() => {
      if (this._view === webviewView) {
        this._view = undefined;
      }
    });

    // If webview transitions from hidden to visible, flush any pending updates
    webviewView.onDidChangeVisibility(() => {
      if (webviewView.visible && this._pendingRefreshOnVisible) {
        this._pendingRefreshOnVisible = false;
        this.debouncedRefresh(100);
      }
    });

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
            Logger.getInstance().info(`[Webview] Account switch requested for: ${message.email}`);
            // If a refresh is running, abort it cleanly on switch
            if (this._isRefreshingProgress.isRefreshing) {
              this._refreshAbortController?.abort();
            }
            try {
              const config = ExtensionConfig.getInstance();
              const skipPrompt = !config.isConfirmOnSwitchEnabled();
              const result = await this.accountService.switchAccountWorkflow(message.email, { skipPrompt });
              if (result !== 'success') {
                await this.accountRepo.setPendingRefreshEmails([]);
                this._view?.webview.postMessage({ command: 'accountSwitchCancelled', email: message.email });
              }
            } catch (err) {
              Logger.getInstance().error(`Account switch failed for ${message.email}`, err);
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
            await this.refresh();
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

    // Step 1: Initial render with slight delay to ensure Chromium service worker handshake is established
    setTimeout(() => {
      this.refresh();
    }, 60);

    // Step 2: Background asynchronous active account detection & pinning from state.vscdb
    const prevPinned = this._pinnedActiveEmail;
    this.detectAndPinActiveAccount().then(async () => {
      // Re-render only if pinned account actually changed from what Frame 0 rendered
      if (this._pinnedActiveEmail && this._pinnedActiveEmail !== prevPinned) {
        this.debouncedRefresh(200);
      }

      const accounts = await this.accountRepo.getAllAccounts();
      if (accounts.length === 0) return;

      // Clear any pending queue from previous switches to avoid unwanted auto-refresh loops
      await this.accountRepo.setPendingRefreshEmails([]);

      const config = ExtensionConfig.getInstance();

      if (config.isAutoRefreshEnabled()) {
        const refreshIntervalMinutes = config.getRefreshIntervalMinutes();
        const intervalMs = refreshIntervalMinutes > 0 ? refreshIntervalMinutes * 60 * 1000 : 15 * 60 * 1000;

        // Refresh active account only if its cooldown has passed (fast, non-intrusive)
        await this.handleActiveAccountRefresh(Math.min(intervalMs, 5 * 60 * 1000));
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
   * Clears a refresh-progress state left behind by a scan that died without
   * reaching its finally block (window reload, aborted host, closed panel).
   * Without this the UI keeps the banner, hides the refresh button and looks
   * like the extension refuses to scan again.
   */
  private reconcileRefreshProgress(): void {
    if (this._isRefreshingProgress.isRefreshing && !this._refreshAbortController) {
      Logger.getInstance().warn('Stale refresh progress detected; resetting the scan state.');
      this._isRefreshingProgress = {
        isRefreshing: false,
        totalAccounts: 0,
        currentIndex: 0,
        currentEmail: '',
      };
      this._pendingQueueEmails = [];
    }
  }

  /**
   * Forces a safe, synchronized re-render of the Webview HTML.
   * Concurrency-guarded to prevent InvalidStateError: Failed to register a ServiceWorker.
   */
  public async refresh(): Promise<void> {
    this.reconcileRefreshProgress();

    if (this._isSettingsOpen || this._isEditingAlias) {
      this._pendingRefreshAfterInteraction = true;
      Logger.getInstance().debug('Skipping full webview HTML re-render because user is interacting with settings or editing alias.');
      return;
    }

    if (!this._view) {
      return;
    }

    // Never attempt to re-render if the view is hidden/collapsed to avoid InvalidStateError in ServiceWorker
    if (!this._view.visible) {
      this._pendingRefreshOnVisible = true;
      Logger.getInstance().debug('Webview is hidden; deferring HTML re-render until visible.');
      return;
    }

    // Guard against concurrent execution destroying the iframe while still bootstrapping
    if (this._isRendering) {
      this._renderQueued = true;
      Logger.getInstance().debug('Render already in progress; queued follow-up refresh.');
      return;
    }

    // Re-resolve the active account before painting. The cached pin can be stale when
    // the previous render happened before a switch that immediately closed the window,
    // which left the old account marked as ACTIVE while the status bar showed the new
    // one. The lookup is bounded: painting must never wait for it.
    try {
      await Promise.race([
        this.detectAndPinActiveAccount(),
        new Promise<void>(resolve => setTimeout(resolve, 250))
      ]);
    } catch (err) {
      Logger.getInstance().debug('Active account refresh before render failed', err);
    }

    if (!this._view || !this._view.visible) {
      this._pendingRefreshOnVisible = true;
      return;
    }

    this._isRendering = true;
    try {
      const html = await this._getHtmlForWebview(this._view.webview);
      // Double check that the view was not disposed or hidden during HTML generation
      if (this._view && this._view.visible) {
        this._view.webview.html = html;
      }
    } catch (err: any) {
      Logger.getInstance().error('Error setting webview HTML', err);
      if (err?.message?.includes('InvalidStateError') || err?.name === 'InvalidStateError') {
        Logger.getInstance().warn('Detected ServiceWorker InvalidStateError during render. Scheduling recovery retry in 250ms...');
        setTimeout(() => {
          if (this._view && this._view.visible) {
            this.debouncedRefresh(100);
          }
        }, 250);
      }
    } finally {
      this._isRendering = false;
      if (this._renderQueued) {
        this._renderQueued = false;
        this.debouncedRefresh(80);
      }
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
  private _detectActivePromise: Promise<void> | null = null;

  private async detectAndPinActiveAccount(): Promise<void> {
    if (this._detectActivePromise) {
      return this._detectActivePromise;
    }
    this._detectActivePromise = this._doDetectAndPinActiveAccount().finally(() => {
      this._detectActivePromise = null;
    });
    return this._detectActivePromise;
  }

  private async _doDetectAndPinActiveAccount(): Promise<void> {
    // Step 1: Check if active email is logged into Antigravity
    const activeEmail = await this.accountService.getActiveAntigravityEmail();

    // Step 1.5: If error reading database or timed out, preserve current pin
    if (activeEmail === undefined) {
      Logger.getInstance().info('Failed to read active email, preserving current pin.');
      return;
    }

    // Step 2: If no account (Antigravity is logged out or check was silent)
    if (!activeEmail) {
      if (this._pinnedActiveEmail) {
        Logger.getInstance().info(`Active email check returned empty; preserving existing active account pin: ${this._pinnedActiveEmail}`);
        return;
      }
      const repoActive = await this.accountRepo.getActiveAccountEmail();
      if (repoActive) {
        this._pinnedActiveEmail = repoActive.toLowerCase();
        return;
      }
      return;
    }

    let accounts = await this.accountRepo.getAllAccounts();
    let matchedAccount = accounts.find(a => isEmailMatch(a.email, activeEmail));

    // Step 3: If not in repository, auto-capture it immediately!
    if (!matchedAccount) {
      Logger.getInstance().info(`[Auto-Capture] Active Antigravity account "${activeEmail}" not in repository. Auto-capturing...`);
      const captured = await this.accountService.syncActiveAccountFromDb(false);
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
      this._pinnedActiveEmail = activeEmail.toLowerCase();
      await this.accountRepo.setActiveAccountEmail(activeEmail.toLowerCase());
      Logger.getInstance().info(`Pinned active Antigravity account: ${activeEmail}`);
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
    // Instantiate AbortController immediately so any cancel click is captured without lag
    this._refreshAbortController?.abort();
    this._refreshAbortController = new AbortController();
    const signal = this._refreshAbortController.signal;

    // Step 0: Fast active account resolution from local DB cache
    if (!this._pinnedActiveEmail) {
      const cachedActive = await this.accountRepo.getActiveAccountEmail();
      if (cachedActive) {
        this._pinnedActiveEmail = cachedActive.toLowerCase();
      }
      this.detectAndPinActiveAccount().catch(() => {});
    } else {
      this.detectAndPinActiveAccount().catch(() => {});
    }

    if (signal.aborted) {
      this._view?.webview.postMessage({ command: 'refreshFinished', wasCancelled: true });
      this._refreshAbortController = null;
      return;
    }

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

    // Tell webview the REAL total count immediately so banner displays "0 / N 0%"
    this._view?.webview.postMessage({ command: 'refreshStarted', totalAccounts });

    if (totalAccounts === 0 || signal.aborted) {
      this._isRefreshingProgress.isRefreshing = false;
      this._view?.webview.postMessage({ command: 'refreshFinished', wasCancelled: !!signal.aborted });
      this._refreshAbortController = null;
      return;
    }

    let didRun = false;
    try {
      didRun = await this.accountService.refreshBalancesWorkflow(notify, {
        signal,
        orderedEmails,
        onlyEmails,
        force,
        activeEmail: this._pinnedActiveEmail || undefined,
        onAccountStart: (email: string) => {
          currentIndex++;
          this._isRefreshingProgress.currentIndex = currentIndex;
          this._isRefreshingProgress.currentEmail = email;
          this._view?.webview.postMessage({ command: 'accountRefreshStart', email, currentIndex, totalAccounts });
        },
        onAntiBanWait: (seconds: number, nextEmail: string) => {
          this._view?.webview.postMessage({ command: 'accountAntiBanWait', seconds, nextEmail, currentIndex, totalAccounts });
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
      const wasCancelled = !!signal.aborted || !didRun;
      this._view?.webview.postMessage({ command: 'refreshFinished', wasCancelled });
      this._refreshAbortController = null;
      if (!wasCancelled) {
        this.debouncedRefresh(150);
      }
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
      // Re-render to apply updated data and sorting safely
      this.debouncedRefresh(150);
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
      'Gemini 4 Hydrogen',
      'Gemini 4 Neon',
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
        const cachedActive = await this.accountRepo.getActiveAccountEmail();
        if (cachedActive) {
          this._pinnedActiveEmail = cachedActive.toLowerCase();
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
       if (totalHours === 0 && mins === 0) {
         return '<1m';
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
      <button class="btn-new-workflow" onclick="openLeaksModal()" title="Radar de Filtraciones Antigravity" style="border: 1px solid rgba(0, 229, 255, 0.45); background: rgba(0, 229, 255, 0.08); color: #00e5ff; font-weight: 500;">
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>
        <span>Radar Filtraciones</span>
        <span style="background: #00e5ff; color: #0c0a17; font-size: 0.65rem; font-weight: 700; padding: 1px 5px; border-radius: 6px; margin-inline-start: 4px;">NUEVO: Neon</span>
      </button>
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

    const stylesHtml = getWebviewStyles();
    const modalsHtml = getModalsHtml({
      i18n,
      configTheme,
      configLanguage,
      configSortBy,
      configCacheDurationDays,
      configAutoRefresh,
      configAutoRotate,
      configLowCreditNotifications,
      configRefreshInterval,
      configAutoCapture,
      configAdaptivePolling,
      configAutoResumeChat,
      configAutoResumePrompt,
      configNoticeDuration,
      configConfirmOnSwitch,
      configShowNotifications,
      isRtl
    });
    const scriptHtml = getWebviewClientScript({
      availableModelKeys,
      effectivePreferred,
      configTheme,
      configLanguage,
      hasAccounts: accounts.length > 0,
      configAutoRefresh,
      configAutoRotate,
      configLowCreditNotifications,
      configRefreshInterval,
      configSortBy,
      configCacheDurationDays,
      configAutoCapture,
      configAdaptivePolling,
      configAutoResumeChat,
      configAutoResumePrompt,
      configNoticeDuration,
      configConfirmOnSwitch,
      configShowNotifications,
      isRtl,
      searchQuery: this._searchQuery,
      isRefreshing: this._isRefreshingProgress.isRefreshing,
      activeWorkflowId,
      i18n
    });

    return `
      <!DOCTYPE html>
      <html lang="${isRtl ? 'ar' : 'en'}" dir="${isRtl ? 'rtl' : 'ltr'}" data-theme="${configTheme}">
      <head>
        <meta charset="UTF-8">
        <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} https: data:; style-src ${webview.cspSource} 'unsafe-inline'; font-src ${webview.cspSource} data:; script-src 'unsafe-inline';">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Antigravity Accounts</title>
        <style>
          ${stylesHtml}
        </style>
      </head>
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
          <button type="button" class="toolbar-scan" onclick="handleRefresh()" title="${i18n.t('commands.refreshBalances.title')}">
            <span class="toolbar-label" id="scanLabelDisplay">⚡ <span class="scan-text-long">${i18n.t('common.refresh')}</span><span class="scan-text-short" style="display: none;">${i18n.t('common.refresh')}</span></span>
          </button>
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
              <div class="refresh-progress-leading">
                <span id="refreshPulseDot" class="refresh-pulse-glow"></span>
                <span class="refresh-progress-email" id="refreshProgressEmail">
                  ${this._isRefreshingProgress.isRefreshing && this._isRefreshingProgress.currentEmail 
                    ? `<span class="refresh-status-badge scanning">${i18n.t('accounts.refreshingAccount')}</span> <span class="refresh-email-highlight">${this._isRefreshingProgress.currentEmail}</span>` 
                    : `<span class="refresh-status-badge">Activo</span> <span class="refresh-status-text">Iniciando escaneo seguro...</span>`}
                </span>
              </div>
              <div class="refresh-progress-stats">
                <div class="refresh-progress-pill">
                  <span id="refreshProgressCount">${this._isRefreshingProgress.currentIndex} / ${this._isRefreshingProgress.totalAccounts}</span>
                  <span class="refresh-progress-pill-sep">•</span>
                  <span id="refreshProgressPercent">${this._isRefreshingProgress.totalAccounts > 0 ? Math.round((this._isRefreshingProgress.currentIndex / this._isRefreshingProgress.totalAccounts) * 100) : 0}%</span>
                </div>
              </div>
            </div>
            <div class="refresh-progress-bar-track">
              <div class="refresh-progress-bar-fill" id="refreshProgressBar" style="width: ${this._isRefreshingProgress.totalAccounts > 0 ? Math.max(2, Math.round((this._isRefreshingProgress.currentIndex / this._isRefreshingProgress.totalAccounts) * 100)) : 0}%;"></div>
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
          <div class="cancel-confirm-box" id="cancelConfirmBox">
            <div id="cancelPromptView">
              <h4>${i18n.t('accounts.confirmCancelTitle')}</h4>
              <p>${i18n.t('accounts.confirmCancelMessage')}</p>
              <div class="cancel-confirm-actions">
                <button class="btn btn-danger" onclick="confirmCancel()">${i18n.t('accounts.confirmCancelYes')}</button>
                <button class="btn btn-primary" onclick="dismissCancelConfirm()">${i18n.t('accounts.confirmCancelNo')}</button>
              </div>
            </div>
            <div id="cancelSpinnerView" style="display:none;flex-direction:column;align-items:center;gap:12px;padding:8px 0;">
              <div style="width:22px;height:22px;border:2px solid var(--glass-border);border-top-color:var(--primary-color);border-radius:50%;animation:spin 0.7s linear infinite;"></div>
              <span style="font-size:0.85rem;color:var(--text-secondary);">${i18n.t('accounts.cancellingRefresh')}</span>
            </div>
          </div>
        </div>

        ${modalsHtml}
        ${scriptHtml}
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

    const isDeadAccount = (acc: any): boolean =>
      acc.status === AccountStatus.TOKEN_EXPIRED
      || acc.status === AccountStatus.ERROR
      || acc.status === AccountStatus.SCOPE_MISSING;

    /** Models the panel actually prints on the card (same filters as renderAccountCard). */
    const isDisplayableModel = (key: string): boolean => {
      const lower = key.toLowerCase();
      if (lower.startsWith('chat') || lower.startsWith('tab') || lower.startsWith('tap')) return false;
      if (lower.includes('gemini-2.5')) return false;
      if (/[-_\s]?lite$/i.test(lower)) return false;
      return !!getFriendlyModelName(key);
    };

    /**
     * Percentage the card prints for that account: the preferred model's value.
     *
     * Sorting used to fall back to the best value among every other model, so an
     * account whose preferred model sat at 0% — the one the chat refuses to use — was
     * ranked as if it had 100%, merely because some unrelated model still had quota.
     * The list then disagreed with the very number shown on each card.
     */
    const getAccountQuotaValue = (acc: any): number => {
      if (!acc.balances) return 0;
      if (isDeadAccount(acc)) return 0;

      if (effectivePreferred) {
        const prefEntry = getModelBalanceEntry(acc.balances, effectivePreferred);
        const prefValue = prefEntry ? Number(prefEntry.value) : NaN;
        return isNaN(prefValue) ? 0 : Math.max(0, prefValue);
      }

      // No preferred model configured: use the best model the card would display.
      let best = 0;
      for (const [k, rawV] of Object.entries(acc.balances)) {
        if (!isDisplayableModel(k)) continue;
        const val = typeof rawV === 'object' && rawV !== null ? Number((rawV as any).value) : Number(rawV);
        if (!isNaN(val) && val > best) best = val;
      }
      return best;
    };

    /**
     * Milliseconds until the account renews, mirroring the countdown printed on the card:
     * the preferred model while it is below 100%, otherwise the soonest depleted model,
     * and the preferred model's own date when everything is full.
     */
    const getAccountNextRegenTime = (acc: any): number => {
      if (!acc.balances) return Infinity;
      if (isDeadAccount(acc)) return Infinity;

      const now = Date.now();
      const toTime = (value?: string): number | null => {
        if (!value) return null;
        const time = new Date(value).getTime();
        return isNaN(time) ? null : time;
      };
      /** Future dates only: a renewal date in the past is stale data, not "ready now". */
      const futureDelta = (value?: string): number | null => {
        const time = toTime(value);
        return time !== null && time > now ? time - now : null;
      };

      if (effectivePreferred) {
        const prefEntry = getModelBalanceEntry(acc.balances, effectivePreferred);
        if (prefEntry) {
          const prefDelta = futureDelta(prefEntry.resetTime);
          if (prefDelta !== null) return prefDelta;
        }
      }

      // Fallback: soonest future renewal among the models the card displays.
      let min = Infinity;
      for (const [k, rawV] of Object.entries(acc.balances)) {
        if (!isDisplayableModel(k)) continue;
        if (typeof rawV !== 'object' || rawV === null) continue;
        const d = futureDelta((rawV as any).resetTime);
        if (d !== null && d < min) min = d;
      }
      return min;
    };

    // Status weight: Active/Low balance first, Depleted next, then unusable accounts.
    // SCOPE_MISSING is usable-looking but the agent signs it out, so it sorts with
    // the broken ones while keeping its own rank.
    const getStatusWeight = (status: AccountStatus) => {
      switch (status) {
        case AccountStatus.ACTIVE: return 0;
        case AccountStatus.LOW_BALANCE: return 1;
        case AccountStatus.DEPLETED: return 2;
        case AccountStatus.SCOPE_MISSING: return 3;
        case AccountStatus.TOKEN_EXPIRED: return 4;
        case AccountStatus.ERROR: return 5;
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
          const aIsDead = isDeadAccount(a);
          const bIsDead = isDeadAccount(b);
          const aHasQuota = aQuota > 0 && !aIsDead;
          const bHasQuota = bQuota > 0 && !bIsDead;

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
   * Delegates single card rendering to account-card.template
   */
  private renderAccountCard(acc: any, effectivePreferred: string): string {
    return renderAccountCardHtml(acc, effectivePreferred, this._workflows);
  }
}
