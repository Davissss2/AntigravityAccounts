/**
 * Account Card Balances Utilities
 * Parses balances, filters models, computes countdowns and formats renewal times.
 */

import { I18nService } from '../../../i18n';
import { getFriendlyModelName, normalizeModelKey, getModelBalanceEntry } from '../../../core/utils/model.utils';

export interface ProcessedModel {
  key: string;
  value: number;
  resetTime?: string;
}

export interface CreditBalance {
  key: string;
  value: number;
}

export function formatResetTime(resetTimeStr?: string): string {
  const i18n = I18nService.getInstance();
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
}

export function parseAccountBalances(balances?: Record<string, any>): {
  processedModels: ProcessedModel[];
  creditBalances: CreditBalance[];
} {
  const processedModels: ProcessedModel[] = [];
  const creditBalances: CreditBalance[] = [];
  if (!balances) return { processedModels, creditBalances };

  const allModelEntries: Array<{ key: string; lowerKey: string; value: number; resetTime?: string }> = [];

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
      value = typeof rawV === 'number' ? rawV : Number(rawV);
      if (value > 0) {
        creditBalances.push({ key: k, value });
      }
      continue;
    }

    allModelEntries.push({ key: k, lowerKey, value, resetTime });
  }

  // Filter out chat, tap, tab, gemini-2.5 and lite models
  const filtered = allModelEntries
    .filter(m => !m.lowerKey.startsWith('chat') && !m.lowerKey.startsWith('tap') && !m.lowerKey.startsWith('tab'))
    .filter(m => !m.lowerKey.includes('gemini-2.5'))
    .filter(m => !m.lowerKey.match(/[-_\s]?lite$/i));

  const friendlyModelMap = new Map<string, ProcessedModel>();
  for (const entry of filtered) {
    const friendlyName = getFriendlyModelName(entry.key);
    if (friendlyName) {
      const existing = friendlyModelMap.get(friendlyName);
      if (!existing || (entry.key.includes('tiered') && !existing.key.includes('tiered'))) {
        friendlyModelMap.set(friendlyName, { key: friendlyName, value: entry.value, resetTime: entry.resetTime });
      }
    }
  }

  const resultModels = Array.from(friendlyModelMap.values());
  resultModels.sort((a, b) => {
    const aCritical = a.value < 20;
    const bCritical = b.value < 20;
    const timeA = a.resetTime ? new Date(a.resetTime).getTime() : 0;
    const timeB = b.resetTime ? new Date(b.resetTime).getTime() : 0;

    if (aCritical && !bCritical) return 1;
    if (!aCritical && bCritical) return -1;
    if (aCritical && bCritical) {
      if (timeA && timeB && timeA !== timeB) return timeA - timeB;
      return a.value - b.value;
    }
    if (a.value !== b.value) return b.value - a.value;
    if (timeA && timeB) return timeA - timeB;
    return 0;
  });

  return { processedModels: resultModels, creditBalances };
}

export function resolvePreferredAndCountdown(
  processedModels: ProcessedModel[],
  effectivePreferred: string,
  rawBalances?: Record<string, any>
): {
  preferredModelData: ProcessedModel | null;
  nextResetTime?: string;
} {
  let preferredModelData: ProcessedModel | null = null;

  if (effectivePreferred) {
    const normalizedPref = normalizeModelKey(effectivePreferred).toLowerCase();
    let prefIdx = processedModels.findIndex(
      m => normalizeModelKey(m.key).toLowerCase() === normalizedPref ||
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
      const balanceEntry = getModelBalanceEntry(rawBalances, effectivePreferred);
      preferredModelData = balanceEntry || { key: effectivePreferred, value: 0 };
    }
  } else if (processedModels.length > 0) {
    preferredModelData = processedModels[0];
  }

  let nextResetTime: string | undefined = undefined;
  const now = Date.now();

  if (preferredModelData && preferredModelData.resetTime) {
    const prefTime = new Date(preferredModelData.resetTime).getTime();
    if (!isNaN(prefTime) && prefTime > now) {
      nextResetTime = preferredModelData.resetTime;
    }
  }

  const depletedWithReset = processedModels.filter(m => m.resetTime && m.value < 100);
  for (const m of depletedWithReset) {
    const t = new Date(m.resetTime!).getTime();
    if (!isNaN(t) && t > now) {
      if (!nextResetTime || t < new Date(nextResetTime).getTime()) {
        nextResetTime = m.resetTime;
      }
    }
  }

  if (!nextResetTime) {
    let minDiffMs = Infinity;
    for (const m of processedModels) {
      if (m.resetTime) {
        const t = new Date(m.resetTime).getTime();
        if (!isNaN(t) && t > now) {
          const diffMs = t - now;
          if (diffMs < minDiffMs) {
            minDiffMs = diffMs;
            nextResetTime = m.resetTime;
          }
        }
      }
    }
  }

  return { preferredModelData, nextResetTime };
}
