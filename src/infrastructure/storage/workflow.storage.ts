/**
 * Workflow Storage Helper
 * Manages workflows, active workflow filter, and account assignments in globalState.
 */

import * as vscode from 'vscode';
import { Workflow } from '../../core/domain/models/workflow.model';
import { Account } from '../../core/domain/models/account.model';
import { STORAGE_KEYS } from '../../core/constants/app.constants';
import { Logger } from '../../core/utils/logger';

export class WorkflowStorage {
  constructor(private context: vscode.ExtensionContext) {}

  async getWorkflows(): Promise<Workflow[]> {
    return this.context.globalState.get<Workflow[]>(STORAGE_KEYS.WORKFLOWS, []);
  }

  async saveWorkflow(workflow: Workflow): Promise<void> {
    const workflows = await this.getWorkflows();
    const index = workflows.findIndex(w => w.id === workflow.id);
    if (index >= 0) {
      workflows[index] = { ...workflows[index], ...workflow };
    } else {
      workflows.push(workflow);
    }
    await this.context.globalState.update(STORAGE_KEYS.WORKFLOWS, workflows);
    Logger.getInstance().info(`Workflow saved: ${workflow.name} (${workflow.id})`);
  }

  async deleteWorkflow(
    workflowId: string,
    getAllAccounts: () => Promise<Account[]>,
    saveAccounts: (accounts: Account[]) => Promise<void>
  ): Promise<void> {
    const workflows = await this.getWorkflows();
    const filtered = workflows.filter(w => w.id !== workflowId);
    await this.context.globalState.update(STORAGE_KEYS.WORKFLOWS, filtered);

    // Unassign accounts that belonged to this workflow
    const accounts = await getAllAccounts();
    let accountsUpdated = false;
    for (const acc of accounts) {
      if (acc.workflow === workflowId) {
        acc.workflow = undefined;
        accountsUpdated = true;
      }
    }
    if (accountsUpdated) {
      await saveAccounts(accounts);
    }

    const activeWf = await this.getActiveWorkflowId();
    if (activeWf === workflowId) {
      await this.setActiveWorkflowId(null);
    }

    Logger.getInstance().info(`Workflow deleted: ${workflowId}`);
  }

  async renameWorkflow(workflowId: string, newName: string): Promise<void> {
    const workflows = await this.getWorkflows();
    const target = workflows.find(w => w.id === workflowId);
    if (target) {
      target.name = newName.trim();
      await this.context.globalState.update(STORAGE_KEYS.WORKFLOWS, workflows);
      Logger.getInstance().info(`Workflow ${workflowId} renamed to: ${newName}`);
    }
  }

  async getActiveWorkflowId(): Promise<string | null> {
    return this.context.globalState.get<string | null>(STORAGE_KEYS.ACTIVE_WORKFLOW, null);
  }

  async setActiveWorkflowId(workflowId: string | null): Promise<void> {
    await this.context.globalState.update(STORAGE_KEYS.ACTIVE_WORKFLOW, workflowId);
    Logger.getInstance().info(`Active workflow set to: ${workflowId || '(all)'}`);
  }

  async assignAccountsToWorkflow(
    emails: string[],
    workflowId: string | undefined,
    getAllAccounts: () => Promise<Account[]>,
    saveAccounts: (accounts: Account[]) => Promise<void>
  ): Promise<void> {
    const emailSet = new Set(emails.map(e => e.toLowerCase().trim()));
    const accounts = await getAllAccounts();
    let updated = false;

    for (const acc of accounts) {
      if (emailSet.has(acc.email.toLowerCase().trim())) {
        if (workflowId) {
          acc.workflow = workflowId;
        } else {
          delete acc.workflow;
        }
        updated = true;
      }
    }

    if (updated) {
      await saveAccounts(accounts);
      Logger.getInstance().info(`Assigned ${emails.length} accounts to workflow: ${workflowId || '(none)'}`);
    }
  }
}
