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
import { API, CANONICAL_CONSUMER_PROJECT } from '../../core/constants/app.constants';
import { Logger } from '../../core/utils/logger';
import { AccountPlan, AccountStatus } from '../../core/domain/models/account.model';
import { detectAccountPlan } from '../../core/utils/plan.utils';

export interface BalanceResult {
  balances: Record<string, any>;
  plan: AccountPlan;
  planLabel?: string;
  projectId?: string;
  hasError: boolean;
  isRateLimited?: boolean;
  isDepleted?: boolean;
  isAuthError?: boolean;
  status?: AccountStatus;
}

export interface AccountContext {
  projectId?: string;
  plan?: AccountPlan;
  planLabel?: string;
  rateLimited?: boolean;
  ineligibleReason?: string;
  validationUrl?: string;
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
    options?: {
      fast?: boolean;
      projectId?: string;
      signal?: AbortSignal;
      probeModel?: string;
      currentPlan?: AccountPlan;
      forcePlanRefresh?: boolean;
    }
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

    let projectId = options?.projectId || CANONICAL_CONSUMER_PROJECT;
    result.projectId = projectId;
    let authError = false;
    let rateLimited = false;
    const shouldResolvePlan =
      !!options?.forcePlanRefresh ||
      !options?.currentPlan ||
      options.currentPlan === AccountPlan.UNKNOWN;

    for (let attempt = 0; attempt < 2; attempt++) {
      if (options?.signal?.aborted) {
        result.hasError = true;
        return result;
      }

      try {
        Logger.getInstance().debug(
          `Querying v1internal:fetchAvailableModels${projectId ? ` for project ${projectId}` : ''}...`
        );
        const contextPromise = (attempt === 0 && shouldResolvePlan)
          ? this.resolveAccountContext(accessToken, options?.signal)
          : Promise.resolve(null);

        const [prodRes, dailyRes, ctxRes] = await Promise.allSettled([
          ApiClient.request<any>(API.FETCH_MODELS_URL, {
            method: 'POST',
            body: projectId ? { project: projectId } : {},
            accessToken,
            timeoutMs: 8000,
            signal: options?.signal
          }),
          ApiClient.request<any>(API.DAILY_FETCH_MODELS_URL, {
            method: 'POST',
            body: projectId ? { project: projectId } : {},
            accessToken,
            timeoutMs: 8000,
            signal: options?.signal
          }),
          contextPromise
        ]);

        if (ctxRes.status === 'fulfilled' && ctxRes.value) {
          if (ctxRes.value.plan && ctxRes.value.plan !== AccountPlan.UNKNOWN) {
            result.plan = ctxRes.value.plan;
            result.planLabel = ctxRes.value.planLabel;
          }
          if (ctxRes.value.projectId) {
            result.projectId = ctxRes.value.projectId;
          }
        }

        const prodData = prodRes.status === 'fulfilled' ? prodRes.value : null;
        const dailyData = dailyRes.status === 'fulfilled' ? dailyRes.value : null;
        const rejections = [prodRes, dailyRes]
          .filter((r): r is PromiseRejectedResult => r.status === 'rejected')
          .map(r => r.reason);

        if (rejections.some(e => options?.signal?.aborted || (e instanceof ApiError && e.status === 499))) {
          result.hasError = true;
          return result;
        }
        if (!prodData && !dailyData && rejections.length > 0) {
          if (rejections.every(e => e instanceof ApiError && e.status === 401)) {
            Logger.getInstance().warn('fetchAvailableModels rejected the access token (401).');
            authError = true;
            break;
          }
          if (rejections.some(e => e instanceof ApiError && e.status === 429)) {
            Logger.getInstance().warn('fetchAvailableModels hit rate limit (429). Preserving quota state.');
            rateLimited = true;
            break;
          }
        }

        // Prioritize dailyData (staging) as it includes complete remainingFraction and newest models
        const mainData = dailyData || prodData;
        if (mainData) {
          const parsed = this.parseAvailableModels(mainData);
          // If secondary source has any models not present in primary, merge them cleanly
          const secondary = dailyData ? prodData : null;
          if (secondary?.models) {
            for (const [modelId, modelObj] of Object.entries<any>(secondary.models)) {
              if (modelObj?.quotaInfo && !parsed.balances[modelId]) {
                const raw = modelObj.quotaInfo.remainingFraction;
                const fraction = typeof raw === 'number' ? raw : raw === undefined ? 0 : Number(raw);
                if (!isNaN(fraction)) {
                  parsed.balances[modelId] = {
                    value: Math.round(fraction * 100),
                    remainingFraction: fraction,
                    resetTime: modelObj.quotaInfo.resetTime
                  };
                }
              }
            }
          }

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
        }

        // Empty model list: usually a stale project. Fall through to re-resolve.
        Logger.getInstance().debug('fetchAvailableModels returned no metered models.');
      } catch (e: any) {
        if (options?.signal?.aborted || (e instanceof ApiError && e.status === 499)) {
          result.hasError = true;
          return result;
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
      if (context.plan && context.plan !== AccountPlan.UNKNOWN && result.plan === AccountPlan.UNKNOWN) {
        result.plan = context.plan;
        result.planLabel = context.planLabel;
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
    const body = {
      metadata: {
        ide_type: 'ANTIGRAVITY',
        ide_version: API.DEFAULT_VERSION,
        ide_name: 'antigravity'
      }
    };
    let sawRateLimit = false;

    for (const url of [API.DAILY_LOAD_CODE_ASSIST, API.LOAD_CODE_ASSIST]) {
      if (signal?.aborted) return null;
      try {
        const data = await ApiClient.request<any>(url, {
          method: 'POST',
          body,
          accessToken,
          timeoutMs: 8000,
          signal
        });
        if (!data) continue;
        // Mirror Antigravity IDE out/main.js confirmUserForService() exact consumer rule:
        // only ineligible when free-tier is NOT in allowedTiers AND IS in ineligibleTiers with a reason.
        const allowedHasFree = Array.isArray(data.allowedTiers) &&
          data.allowedTiers.some((t: any) => String(t?.id || '').toLowerCase() === 'free-tier');
        const freeIneligible = Array.isArray(data.ineligibleTiers)
          ? data.ineligibleTiers.find((t: any) => String(t?.tierId || '').toLowerCase() === 'free-tier' && !!t?.reasonMessage)
          : undefined;
        const detected = detectAccountPlan(data);
        if (!allowedHasFree && freeIneligible) {
          Logger.getInstance().warn(`[loadCodeAssist] free-tier ineligible: ${freeIneligible.reasonMessage}`);
          return {
            projectId: data.cloudaicompanionProject || undefined,
            plan: detected.plan,
            planLabel: detected.planLabel,
            ineligibleReason: String(freeIneligible.reasonMessage),
            validationUrl: freeIneligible.validationUrl ? String(freeIneligible.validationUrl) : undefined
          };
        }
        if (detected.plan !== AccountPlan.UNKNOWN || data.cloudaicompanionProject) {
          return {
            projectId: data.cloudaicompanionProject || undefined,
            plan: detected.plan,
            planLabel: detected.planLabel
          };
        }
      } catch (e: any) {
        if (signal?.aborted || (e instanceof ApiError && e.status === 499)) return null;
        if (e instanceof ApiError && e.status === 429) {
          sawRateLimit = true;
          break;
        }
        Logger.getInstance().debug(`loadCodeAssist failed on ${url}`, e?.message || e);
      }
    }

    return sawRateLimit ? { rateLimited: true } : null;
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
}
