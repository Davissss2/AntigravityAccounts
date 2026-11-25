/**
 * Workflow & Bulk Account Actions Handler
 *
 * Modularizes interactive workflow import selection, workflow deletion
 * (keep vs permanently delete accounts), and bulk permanent deletion.
 */

import * as vscode from 'vscode';
import { IAccountRepository } from '../../../core/domain/repositories/account.repository';
import { AccountService } from '../../../features/accounts/account.service';
import { I18nService } from '../../../i18n/i18n.service';
import { Logger } from '../../../core/utils/logger';

export interface ImportWorkflowChoice {
  mode: 'workflow' | 'none' | 'keep';
  workflowId?: string;
}

export async function pickImportWorkflowTarget(
  accountRepo: IAccountRepository,
  accountCount: number,
  backupHasKnownWorkflows: boolean
): Promise<ImportWorkflowChoice | null> {
  const i18n = I18nService.getInstance();
  const existingWorkflows = await accountRepo.getWorkflows();
  const activeWfId = await accountRepo.getActiveWorkflowId();

  interface ImportPickItem extends vscode.QuickPickItem {
    action: 'workflow' | 'create' | 'none' | 'keep';
    workflowId?: string;
  }

  const items: ImportPickItem[] = [];

  // Put currently active workflow first for 1-click convenience
  const sortedWorkflows = [...existingWorkflows].sort((a, b) => {
    if (a.id === activeWfId) return -1;
    if (b.id === activeWfId) return 1;
    return a.name.localeCompare(b.name);
  });

  for (const wf of sortedWorkflows) {
    items.push({
      label: `$(folder) ${i18n.t('workflows.importToWorkflow', { name: wf.name })}`,
      description: wf.id === activeWfId ? `(${i18n.t('accounts.active')})` : undefined,
      action: 'workflow',
      workflowId: wf.id,
    });
  }

  items.push({
    label: `$(plus) ${i18n.t('workflows.importCreateNew')}`,
    action: 'create',
  });

  items.push({
    label: `$(globe) ${i18n.t('workflows.importToAllOnly')}`,
    action: 'none',
  });

  if (backupHasKnownWorkflows) {
    items.push({
      label: `$(archive) ${i18n.t('workflows.importKeep')}`,
      action: 'keep',
    });
  }

  const picked = await vscode.window.showQuickPick(items, {
    placeHolder: i18n.t('workflows.importTitleCount', { count: accountCount }),
    title: i18n.t('workflows.importTitle'),
  });

  if (!picked) return null;

  if (picked.action === 'create') {
    const newWfName = await vscode.window.showInputBox({
      prompt: i18n.t('workflows.createPrompt'),
      placeHolder: i18n.t('workflows.createPlaceholder'),
      validateInput: (val) => (!val || !val.trim() ? i18n.t('workflows.createPlaceholder') : undefined),
    });
    if (!newWfName || !newWfName.trim()) return null;

    const newWfId = 'wf_' + Date.now();
    await accountRepo.saveWorkflow({
      id: newWfId,
      name: newWfName.trim(),
      createdAt: new Date().toISOString(),
    });
    return { mode: 'workflow', workflowId: newWfId };
  }

  if (picked.action === 'workflow' && picked.workflowId) {
    return { mode: 'workflow', workflowId: picked.workflowId };
  }

  if (picked.action === 'keep') {
    return { mode: 'keep' };
  }

  return { mode: 'none' };
}

export async function handleDeleteWorkflowInteractive(
  accountRepo: IAccountRepository,
  accountService: AccountService,
  workflowId: string,
  refresh: () => Promise<void>
): Promise<void> {
  const i18n = I18nService.getInstance();
  const workflows = await accountRepo.getWorkflows();
  const target = workflows.find(w => w.id === workflowId);
  const wfName = target ? target.name : workflowId;
  const allAccounts = await accountRepo.getAllAccounts();
  const wfAccounts = allAccounts.filter(a => a.workflow === workflowId);

  if (wfAccounts.length === 0) {
    const confirm = await vscode.window.showWarningMessage(
      i18n.t('workflows.confirmDeleteEmpty', { name: wfName }),
      { modal: true },
      i18n.t('workflows.delete')
    );
    if (confirm === i18n.t('workflows.delete')) {
      await accountRepo.deleteWorkflow(workflowId);
      await refresh();
    }
    return;
  }

  const choice = await vscode.window.showQuickPick(
    [
      {
        label: `$(folder) ${i18n.t('workflows.deleteOnlyWorkflow')}`,
        detail: i18n.t('workflows.deleteOnlyWorkflowDetail', { count: wfAccounts.length, name: wfName }),
        mode: 'workflow_only' as const,
      },
      {
        label: `$(trash) ${i18n.t('workflows.deleteWorkflowAndAccounts', { count: wfAccounts.length })}`,
        detail: i18n.t('workflows.deleteWorkflowAndAccountsDetail', { count: wfAccounts.length, name: wfName }),
        mode: 'workflow_and_accounts' as const,
      },
    ],
    {
      placeHolder: i18n.t('workflows.deleteChoicePrompt', { name: wfName, count: wfAccounts.length }),
    }
  );

  if (!choice) return;

  if (choice.mode === 'workflow_only') {
    await accountRepo.deleteWorkflow(workflowId);
    await refresh();
    return;
  }

  const deleteBtn = i18n.t('workflows.confirmDeleteAccountsBtn', { count: wfAccounts.length });
  const confirm = await vscode.window.showWarningMessage(
    i18n.t('workflows.confirmDeleteWorkflowAndAccounts', { name: wfName, count: wfAccounts.length }),
    { modal: true },
    deleteBtn
  );
  if (confirm !== deleteBtn) return;

  for (const acc of wfAccounts) {
    await accountRepo.removeAccount(acc.email);
  }
  await accountRepo.deleteWorkflow(workflowId);
  accountService.emitAccountsChanged();
  await refresh();
  Logger.getInstance().info(`Deleted workflow '${wfName}' and permanently removed ${wfAccounts.length} account(s).`);
  vscode.window.showInformationMessage(
    i18n.t('workflows.deletedWorkflowAndAccountsSuccess', { name: wfName, count: wfAccounts.length })
  );
}

export async function handleDeleteWorkflowAccounts(
  accountRepo: IAccountRepository,
  accountService: AccountService,
  workflowId: string,
  wfName: string,
  refresh: () => Promise<void>
): Promise<void> {
  const i18n = I18nService.getInstance();
  const allAccounts = await accountRepo.getAllAccounts();
  const wfAccounts = allAccounts.filter(a => a.workflow === workflowId);

  if (wfAccounts.length === 0) {
    vscode.window.showInformationMessage(i18n.t('workflows.emptyWorkflow'));
    return;
  }

  const deleteBtn = i18n.t('workflows.confirmDeleteAccountsBtn', { count: wfAccounts.length });
  const confirm = await vscode.window.showWarningMessage(
    i18n.t('workflows.confirmDeleteOnlyAccounts', { name: wfName, count: wfAccounts.length }),
    { modal: true },
    deleteBtn
  );
  if (confirm !== deleteBtn) return;

  for (const acc of wfAccounts) {
    await accountRepo.removeAccount(acc.email);
  }
  accountService.emitAccountsChanged();
  await refresh();
  Logger.getInstance().info(`Permanently deleted ${wfAccounts.length} account(s) from workflow '${wfName}'.`);
  vscode.window.showInformationMessage(
    i18n.t('workflows.bulkDeleteSuccess', { count: wfAccounts.length })
  );
}

export async function handleBulkDeleteAccounts(
  accountRepo: IAccountRepository,
  accountService: AccountService,
  emails: string[],
  refresh: () => Promise<void>
): Promise<boolean> {
  if (!emails.length) return false;
  const i18n = I18nService.getInstance();
  const deleteBtn = i18n.t('workflows.confirmDeleteAccountsBtn', { count: emails.length });
  const confirm = await vscode.window.showWarningMessage(
    i18n.t('workflows.confirmBulkDelete', { count: emails.length }),
    { modal: true },
    deleteBtn
  );
  if (confirm !== deleteBtn) return false;

  for (const email of emails) {
    await accountRepo.removeAccount(email);
  }
  accountService.emitAccountsChanged();
  await refresh();
  Logger.getInstance().info(`Bulk deleted ${emails.length} account(s) permanently.`);
  vscode.window.showInformationMessage(
    i18n.t('workflows.bulkDeleteSuccess', { count: emails.length })
  );
  return true;
}
