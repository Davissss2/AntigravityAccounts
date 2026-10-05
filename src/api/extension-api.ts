import { Account, AccountSummary } from '../core/domain/models/account.model';

export interface SwitchAccountOptions {
  skipPrompt?: boolean;
}

export interface AutoSwitchResult {
  success: boolean;
  targetEmail?: string;
  message?: string;
}

export interface ActiveAccountInfo {
  email: string | null;
  account?: AccountSummary | null;
  raw?: any;
}

/**
 * Public programmatic API for Antigravity Accounts.
 * Allows AI agents, external extensions, or automation scripts to query accounts,
 * trigger fast quota reloads, switch accounts, and configure auto-rotation.
 */
export interface AntigravityAccountApi {
  /**
   * Retrieves summaries of all registered accounts (email, displayName, balances, status, isActive).
   */
  getAccounts(): Promise<AccountSummary[]>;

  /**
   * Retrieves full details of all registered accounts.
   */
  getAllAccounts(): Promise<Account[]>;

  /**
   * Retrieves the currently active Antigravity account detected from state.vscdb and repository.
   */
  getActiveAccount(): Promise<ActiveAccountInfo>;

  /**
   * Switches to a specific account by email.
   * If skipPrompt is true, skips user confirmation dialogs and triggers injection directly.
   */
  switchAccount(email: string, options?: SwitchAccountOptions): Promise<'success' | 'cancelled' | 'error'>;

  /**
   * Automatically switches to the healthy account with the highest available quota.
   */
  autoSwitch(options?: SwitchAccountOptions): Promise<AutoSwitchResult>;

  /**
   * Performs a rapid (sub-second) quota refresh for the currently active account.
   */
  refreshActiveQuota(force?: boolean): Promise<Account | null>;

  /**
   * Refreshes quota balances for all accounts or background list.
   */
  refreshBalances(force?: boolean): Promise<void>;

  /**
   * Automatically scans and synchronizes the active Antigravity account from state.vscdb.
   */
  syncActiveAccount(forceRefresh?: boolean): Promise<Account | null>;

  /**
   * Sets whether automatic rotation on quota depletion is enabled.
   */
  setAutoSwitchEnabled(enabled: boolean): Promise<void>;

  /**
   * Checks whether automatic rotation on quota depletion is currently enabled.
   */
  isAutoSwitchEnabled(): boolean;
}
