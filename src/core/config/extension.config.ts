/**
 * Extension Configuration — Centralized configuration access
 *
 * Wraps VS Code's configuration API with typed accessors
 * for all Antigravity Hub settings.
 */

import * as vscode from 'vscode';

const CONFIG_SECTION = 'antigravityAccount';

export class ExtensionConfig {
  private static instance: ExtensionConfig;
  private context: vscode.ExtensionContext | null = null;

  private constructor() {}

  static getInstance(): ExtensionConfig {
    if (!ExtensionConfig.instance) {
      ExtensionConfig.instance = new ExtensionConfig();
    }
    return ExtensionConfig.instance;
  }

  /**
   * Must be called once during activation with the extension context.
   */
  initialize(context: vscode.ExtensionContext): void {
    this.context = context;
  }

  /**
   * Get the current display language code (e.g., 'en', 'ar')
   */
  getLanguage(): string {
    return this.getConfig().get<string>('language', 'auto');
  }

  /**
   * Whether automatic balance refresh on panel open is enabled
   */
  isAutoRefreshEnabled(): boolean {
    return this.getConfig().get<boolean>('autoRefreshEnabled', false);
  }

  /**
   * Get the refresh interval in minutes (0 = disabled)
   */
  getRefreshIntervalMinutes(): number {
    return this.getConfig().get<number>('refreshIntervalMinutes', 0);
  }

  /**
   * Get the active account quota polling interval in seconds (default: 45s)
   */
  getActiveQuotaRefreshIntervalSeconds(): number {
    return this.getConfig().get<number>('activeQuotaRefreshIntervalSeconds', 45);
  }

  /**
   * Get the low credit warning threshold
   */
  getLowCreditThreshold(): number {
    return this.getConfig().get<number>('lowCreditThreshold', 100);
  }

  /**
   * Whether automatic account rotation on depletion is enabled
   */
  isAutoRotateEnabled(): boolean {
    return this.getConfig().get<boolean>('autoRotateEnabled', false);
  }

  /**
   * Set whether automatic account rotation on depletion is enabled
   */
  async setAutoRotateEnabled(enabled: boolean): Promise<void> {
    await this.getConfig().update('autoRotateEnabled', enabled, true);
  }

  /**
   * Whether to show a confirmation modal before closing and reloading window on account switch.
   * Default: false (immediate automatic reload)
   */
  isConfirmOnSwitchEnabled(): boolean {
    return this.getConfig().get<boolean>('confirmOnSwitch', false);
  }

  /**
   * Whether dynamic adaptive quota polling is enabled (< 10% quota checks every 8s)
   */
  isAdaptiveQuotaPollingEnabled(): boolean {
    return this.getConfig().get<boolean>('adaptiveQuotaPolling', true);
  }

  /**
   * Whether low credit notifications are enabled
   */
  isLowCreditNotificationsEnabled(): boolean {
    return this.getConfig().get<boolean>('lowCreditNotificationsEnabled', true);
  }

  /**
   * Get the cache validity duration in days
   */
  getCacheDurationDays(): number {
    return this.getConfig().get<number>('cacheDurationDays', 7);
  }

  /**
   * Get the sorting method
   */
  getSortBy(): string {
    return this.getConfig().get<string>('sortBy', 'default');
  }

  /**
   * Get the visual theme ('dark-purple', 'vscode', 'midnight', 'deep-blue')
   */
  getTheme(): string {
    return this.getConfig().get<string>('theme', 'dark-purple');
  }

  /**
   * Whether to automatically restore the chat session and continue generation after depletion switch.
   */
  isAutoResumeChatEnabled(): boolean {
    return this.getConfig().get<boolean>('autoResumeChat', true);
  }

  /**
   * Text prompt to automatically send to the chat when resuming after depletion.
   */
  getAutoResumePrompt(): string {
    return this.getConfig().get<string>('autoResumePrompt', 'continua');
  }

  /**
   * Maximum elapsed seconds since last AI activity to consider the agent was actively working.
   */
  getAutoResumeTimeoutSeconds(): number {
    return this.getConfig().get<number>('autoResumeTimeoutSeconds', 90);
  }

  /**
   * Duration in seconds of the pre-switch notification countdown notice (0 = instant reload).
   */
  getNoticeDurationSeconds(): number {
    return this.getConfig().get<number>('noticeDurationSeconds', 0);
  }

  /**
   * Whether automatic capture and saving of newly detected Antigravity accounts is enabled (Default: true)
   */
  isAutoCaptureAccountsEnabled(): boolean {
    return this.getConfig().get<boolean>('autoCaptureAccounts', true);
  }

  /**
   * Set whether automatic capture and saving of newly detected Antigravity accounts is enabled
   */
  async setAutoCaptureAccountsEnabled(enabled: boolean): Promise<void> {
    await this.getConfig().update('autoCaptureAccounts', enabled, true);
  }

  /**
   * Retrieves the entire extension settings object as a plain configuration record.
   */
  getFullConfig(): any {
    return {
      autoRotateEnabled: this.isAutoRotateEnabled(),
      autoCaptureAccounts: this.isAutoCaptureAccountsEnabled(),
      confirmOnSwitch: this.isConfirmOnSwitchEnabled(),
      noticeDurationSeconds: this.getNoticeDurationSeconds(),
      autoResumeChat: this.isAutoResumeChatEnabled(),
      autoResumePrompt: this.getAutoResumePrompt(),
      autoResumeTimeoutSeconds: this.getAutoResumeTimeoutSeconds(),
      adaptiveQuotaPolling: this.isAdaptiveQuotaPollingEnabled(),
      activeQuotaRefreshIntervalSeconds: this.getActiveQuotaRefreshIntervalSeconds(),
      lowCreditThreshold: this.getLowCreditThreshold(),
      lowCreditNotificationsEnabled: this.isLowCreditNotificationsEnabled(),
    };
  }

  /**
   * Updates multiple configuration properties programmatically.
   */
  async updateFullConfig(settings: Record<string, any>): Promise<void> {
    const config = this.getConfig();
    for (const [key, value] of Object.entries(settings)) {
      if (value !== undefined) {
        await config.update(key, value, vscode.ConfigurationTarget.Global);
      }
    }
  }

  /**
   * Get the extension context (for services that need it)
   */
  getContext(): vscode.ExtensionContext {
    if (!this.context) {
      throw new Error('ExtensionConfig not initialized. Call initialize() first.');
    }
    return this.context;
  }

  private getConfig(): vscode.WorkspaceConfiguration {
    return vscode.workspace.getConfiguration(CONFIG_SECTION);
  }
}
