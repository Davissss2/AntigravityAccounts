/**
 * Balance & API Service
 *
 * Interacts with Google's internal CloudCode/Antigravity APIs to extract
 * AI credit balances, plan types, and project metadata.
 *
 * Since Antigravity 1.107 there is exactly ONE source of truth for quota:
 * `v1internal:fetchAvailableModels`. Verified against the shipped build
 * (`out/main.js`): the IDE renders its "Models & Usage" page from that call and
 * raises `Individual quota reached` only when a model reports
 * `quotaInfo.remainingFraction === 0` -- there is no separate baseline bucket to
 * query and no generation probe to run. Anything else this extension invents
 * (generation probes, per-family zeroing, weekly summary endpoints) makes the
 * panel disagree with the IDE, which is exactly the 100% <-> 0% flapping users
 * report. So: mirror the IDE, nothing more.
 */

import { ApiClient, ApiError } from '../../core/network/api.client';
import { API } from '../../core/constants/app.constants';
import { Logger } from '../../core/utils/logger';
import { AccountPlan, AccountStatus } from '../../core/domain/models/account.model';

export interface BalanceResult {
  balances: Record<string, any>;
  plan: AccountPlan;
  projectId?: string;
  hasError: boolean;
  isRateLimited?: boolean;
  isDepleted?: boolean;
  isAuthError?: boolean;
  status?: AccountStatus;
}

export interface AccountContext {
  projectId?: string;
  planName?: string;
  ineligible?: boolean;
  rateLimited?: boolean;
}

/** Models the IDE never shows as user-facing quota (tabs, chat previews, taps). */
const INTERNAL_MODEL_PREFIXES = ['tab', 'tab_', 'chat', 'chat_', 'tap', 'tap_'];

export class BalanceService {
  /**
   * Reads the quota map exactly as the IDE does.
   *
   * The project matters: `fetchAvailableModels` is scoped to the Cloud AI
   * Companion project, and querying a stale/foreign project returns a different
   * (and silently wrong) fraction map. When the stored project is rejected or the
   * response comes back empty, the project is re-resolved through
   * `loadCodeAssist` -- the same call the IDE performs on startup.
   */
  async getBalanceInfo(
    accessToken: string,
    options?: { fast?: boolean; projectId?: string; signal?: AbortSignal; probeModel?: string }
  ): Promise<BalanceResult> {
    const result: BalanceResult = {
      balances: {},
      plan: AccountPlan.UNKNOWN,
      hasError: false,
      isRateLimited: false,
      projectId: options?.projectId
    };

    if (options?.signal?.aborted) {
      result.hasError = true;
      return result;
    }

    let projectId = options?.projectId;
    let authError = false;
    let rateLimited = false;

    for (let attempt = 0; attempt < 2; attempt++) {
      if (options?.signal?.aborted) {
        result.hasError = true;
        return result;
      }

      try {
        Logger.getInstance().debug(
          `Querying v1internal:fetchAvailableModels${projectId ? ` for project ${projectId}` : ''}...`
        );
        const data = await ApiClient.request<any>(API.FETCH_MODELS_URL, {
          method: 'POST',
          body: projectId ? { project: projectId } : {},
          accessToken,
          timeoutMs: 8000,
          signal: options?.signal
        });

        const parsed = this.parseAvailableModels(data);
        if (Object.keys(parsed.balances).length > 0) {
          result.balances = parsed.balances;
          result.isDepleted = parsed.allExhausted;
          if (result.isDepleted) {
            result.status = AccountStatus.DEPLETED;
          }
          Logger.getInstance().info(
            `Fetched quota for ${Object.keys(parsed.balances).length} models${projectId ? ` (project ${projectId})` : ''}.`
          );
          return result;
        }

        // Empty model list: usually a stale project. Fall through to re-resolve.
        Logger.getInstance().debug('fetchAvailableModels returned no metered models.');
      } catch (e: any) {
        if (options?.signal?.aborted || (e instanceof ApiError && e.status === 499)) {
          result.hasError = true;
          return result;
        }
        if (e instanceof ApiError && e.status === 401) {
          Logger.getInstance().warn('fetchAvailableModels rejected the access token (401).');
          authError = true;
          break;
        }
        if (e instanceof ApiError && e.status === 429) {
          // A rate limit is a transport condition, never an exhausted account.
          // Callers must keep the previous quota state untouched.
          Logger.getInstance().warn('fetchAvailableModels hit rate limit (429). Preserving quota state.');
          rateLimited = true;
          break;
        }
        Logger.getInstance().debug('fetchAvailableModels failed', e?.message || e);
      }

      if (attempt > 0) {
        break;
      }

      // Re-resolve the project the IDE would use, then retry once.
      const context = await this.resolveAccountContext(accessToken, options?.signal);
      if (!context) {
        break;
      }
      if (context.rateLimited) {
        rateLimited = true;
        break;
      }
      if (context.ineligible) {
        result.status = AccountStatus.INELIGIBLE;
        result.hasError = true;
        return result;
      }
      if (context.planName && result.plan === AccountPlan.UNKNOWN) {
        result.plan = this.parsePlanName(context.planName);
      }
      if (!context.projectId || context.projectId === projectId) {
        break;
      }
      projectId = context.projectId;
      result.projectId = projectId;
    }

    if (authError) {
      result.isAuthError = true;
      result.hasError = true;
      result.status = AccountStatus.TOKEN_EXPIRED;
      return result;
    }
    if (rateLimited) {
      result.isRateLimited = true;
      result.hasError = true;
      return result;
    }

    Logger.getInstance().warn('Could not read the quota map from fetchAvailableModels.');
    result.hasError = true;
    return result;
  }

  /**
   * Resolves the account context (project + plan) the IDE uses.
   * Equivalent to the IDE's `loadCodeAssist` call on startup.
   */
  async resolveAccountContext(accessToken: string, signal?: AbortSignal): Promise<AccountContext | null> {
    if (signal?.aborted) return null;
    try {
      const data = await ApiClient.request<any>(API.DAILY_LOAD_CODE_ASSIST, {
        method: 'POST',
        body: {
          metadata: {
            ide_type: 'ANTIGRAVITY',
            ide_version: API.DEFAULT_VERSION,
            ide_name: 'antigravity'
          }
        },
        accessToken,
        timeoutMs: 8000,
        signal
      });
      if (!data) return null;

      const paidTier = data.paidTier || {};
      const currentTier = data.currentTier || {};
      return {
        projectId: data.cloudaicompanionProject || undefined,
        planName: paidTier.name || currentTier.name || undefined
      };
    } catch (e: any) {
      if (signal?.aborted || (e instanceof ApiError && e.status === 499)) return null;
      if (e instanceof ApiError && e.status === 429) {
        return { rateLimited: true };
      }
      if (e instanceof ApiError && (e.status === 403 || e.status === 400)) {
        Logger.getInstance().warn(`loadCodeAssist reports the account as ineligible (${e.status}).`);
        return { ineligible: true };
      }
      Logger.getInstance().debug('loadCodeAssist failed', e?.message || e);
      return null;
    }
  }

  /**
   * Maps the `fetchAvailableModels` payload to balances.
   *
   * Faithful to the IDE:
   *  - `remainingFraction` is read verbatim; an omitted value is protobuf for 0.
   *  - Models without `quotaInfo` are not metered and are ignored.
   *  - The account only counts as depleted when every metered model is at 0.
   */
  private parseAvailableModels(data: any): { balances: Record<string, any>; allExhausted: boolean } {
    const balances: Record<string, any> = {};
    let metered = 0;
    let withQuota = 0;

    for (const [modelId, modelData] of Object.entries<any>(data?.models ?? {})) {
      const quota = modelData?.quotaInfo;
      if (!quota) continue;

      const raw = quota.remainingFraction;
      const fraction = typeof raw === 'number' ? raw : raw === undefined ? 0 : Number(raw);
      if (isNaN(fraction)) continue;

      const value = Math.round(fraction * 100);
      balances[modelId] = {
        value,
        remainingFraction: fraction,
        resetTime: quota.resetTime
      };

      if (!this.isInternalModel(modelId)) {
        metered++;
        if (value > 0) withQuota++;
      }
    }

    return { balances, allExhausted: metered > 0 && withQuota === 0 };
  }

  private isInternalModel(modelId: string): boolean {
    const lower = modelId.toLowerCase();
    return INTERNAL_MODEL_PREFIXES.some(prefix => lower.startsWith(prefix));
  }

  /**
   * Maps Google's internal string names to our clean Domain Enums.
   */
  private parsePlanName(name?: string): AccountPlan {
    if (!name) return AccountPlan.UNKNOWN;

    const lower = name.toLowerCase();

    if (lower.includes('ultra')) return AccountPlan.ULTRA;
    if (lower.includes('premium')) return AccountPlan.PREMIUM;
    if (lower.includes('free') || lower.includes('standard') || lower.includes('starter')) return AccountPlan.FREE;

    return AccountPlan.UNKNOWN;
  }
}
