/**
 * Account Repository Interface — Domain contract
 *
 * Defines the contract for account persistence.
 * Infrastructure layer (SecretStorage, globalState) implements this.
 * This follows the Dependency Inversion principle (SOLID).
 */

import { Account, AccountCreationData, AccountTokens, AccountSummary } from '../models/account.model';
import { DeviceProfile } from '../models/device-profile.model';
import { Workflow } from '../models/workflow.model';

export interface IAccountRepository {
  /** Get all stored accounts (without tokens) */
  getAllAccounts(): Promise<Account[]>;

  /** Get a single account by email */
  getAccount(email: string): Promise<Account | null>;

  /** Save a new account (after OAuth) */
  saveAccount(data: AccountCreationData): Promise<Account>;

  /** Remove an account and its tokens */
  removeAccount(email: string): Promise<void>;

  /** Update account metadata (alias, credits, status, etc.) */
  updateAccount(email: string, updates: Partial<Account>): Promise<void>;

  /** Get the currently active account email */
  getActiveAccountEmail(): Promise<string | null>;

  /** Set the active account */
  setActiveAccount(email: string | null): Promise<void>;

  /** Set the active account email (alias) */
  setActiveAccountEmail(email: string | null): Promise<void>;

  /** Store tokens securely */
  storeTokens(email: string, tokens: AccountTokens): Promise<void>;

  /** Retrieve tokens */
  getTokens(email: string): Promise<AccountTokens | null>;

  /** Get summaries for quick-pick display */
  getAccountSummaries(): Promise<AccountSummary[]>;

  /** Store a device profile securely for an account */
  storeDeviceProfile(email: string, profile: DeviceProfile): Promise<void>;

  /** Retrieve the device profile for an account */
  getDeviceProfile(email: string): Promise<DeviceProfile | null>;

  /** Get the user's preferred model key (null = never set, "" = explicitly none) */
  getPreferredModel(): Promise<string | null>;

  /** Set the user's preferred model key */
  setPreferredModel(modelKey: string): Promise<void>;

  /** Get the timestamp (ms) of when balances were last globally refreshed */
  getBalancesLastRefreshed(): Promise<number>;

  /** Set the timestamp (ms) of when balances were last globally refreshed */
  setBalancesLastRefreshed(timestampMs: number): Promise<void>;

  /** Get pending refresh account emails across window reloads / account switches */
  getPendingRefreshEmails(): Promise<string[]>;

  /** Set pending refresh account emails to resume after account switch */
  setPendingRefreshEmails(emails: string[]): Promise<void>;

  /** Get all defined workflows */
  getWorkflows(): Promise<Workflow[]>;

  /** Save or update a workflow */
  saveWorkflow(workflow: Workflow): Promise<void>;

  /** Delete a workflow (unassigns accounts from this workflow without deleting the accounts) */
  deleteWorkflow(workflowId: string): Promise<void>;

  /** Rename a workflow */
  renameWorkflow(workflowId: string, newName: string): Promise<void>;

  /** Get currently active workflow filter (null = all accounts) */
  getActiveWorkflowId(): Promise<string | null>;

  /** Set currently active workflow filter (null = all accounts) */
  setActiveWorkflowId(workflowId: string | null): Promise<void>;

  /** Assign multiple accounts to a workflow (or undefined to unassign) in a single batch */
  assignAccountsToWorkflow(emails: string[], workflowId?: string): Promise<void>;
}

