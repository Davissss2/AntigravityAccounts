/**
 * Subscription Plan Utilities
 *
 * Maps Google Cloud Code / Antigravity `loadCodeAssist` tier metadata
 * (`paidTier` / `currentTier`) to canonical `AccountPlan` enums and UI badge metadata.
 */

import { AccountPlan } from '../domain/models/account.model';

export interface TierMetadata {
  id?: string;
  name?: string;
  description?: string;
}

export interface DetectedPlan {
  plan: AccountPlan;
  planLabel?: string;
}

export interface PlanBadgeMeta {
  text: string;
  cssClass: string;
  tooltip: string;
}

export function detectAccountPlan(data?: {
  paidTier?: TierMetadata | null;
  currentTier?: TierMetadata | null;
} | null): DetectedPlan {
  if (!data) return { plan: AccountPlan.UNKNOWN };

  const paid = data.paidTier || undefined;
  const current = data.currentTier || undefined;

  const paidRaw = [paid?.id, paid?.name, paid?.description].filter(Boolean).join(' ').toLowerCase();
  const currentRaw = [current?.id, current?.name, current?.description].filter(Boolean).join(' ').toLowerCase();

  // 1. Inspect paidTier first (authoritative for subscribed accounts)
  if (paidRaw) {
    const label = paid?.name || paid?.description || paid?.id;
    if (paidRaw.includes('trial')) {
      return { plan: AccountPlan.TRIAL, planLabel: label || 'Trial' };
    }
    if (paidRaw.includes('ultra')) {
      return { plan: AccountPlan.ULTRA, planLabel: label || 'Google AI Ultra' };
    }
    if (paidRaw.includes('enterprise') || paidRaw.includes('business')) {
      return { plan: AccountPlan.ENTERPRISE, planLabel: label || 'Enterprise' };
    }
    if (paidRaw.includes('pro') || paidRaw.includes('plus') || paidRaw.includes('premium') || paidRaw.includes('helium')) {
      return { plan: AccountPlan.PRO, planLabel: label || 'Google AI Pro' };
    }
    if (paid?.name || paid?.id) {
      return { plan: AccountPlan.PREMIUM, planLabel: label };
    }
  }

  // 2. Fallback to currentTier (free / standard / enterprise / trial)
  if (currentRaw) {
    const label = current?.name || current?.id;
    if (currentRaw.includes('trial')) {
      return { plan: AccountPlan.TRIAL, planLabel: label || 'Trial' };
    }
    if (currentRaw.includes('ultra')) {
      return { plan: AccountPlan.ULTRA, planLabel: label || 'Google AI Ultra' };
    }
    if (currentRaw.includes('enterprise') || currentRaw.includes('business') || current?.id === 'standard-tier') {
      return { plan: AccountPlan.ENTERPRISE, planLabel: label || 'Enterprise' };
    }
    if (currentRaw.includes('pro') || currentRaw.includes('premium')) {
      return { plan: AccountPlan.PRO, planLabel: label || 'Google AI Pro' };
    }
    if (
      current?.id === 'free-tier' ||
      currentRaw.includes('free') ||
      currentRaw.includes('starter') ||
      currentRaw.includes('antigravity')
    ) {
      return { plan: AccountPlan.FREE, planLabel: 'Free' };
    }
  }

  return { plan: AccountPlan.UNKNOWN };
}

export function getPlanBadgeMeta(plan?: AccountPlan | string, planLabel?: string): PlanBadgeMeta | null {
  if (!plan || plan === AccountPlan.UNKNOWN) return null;

  const p = String(plan).toLowerCase();
  const labelLower = (planLabel || '').toLowerCase();

  if (p === AccountPlan.ULTRA || labelLower.includes('ultra')) {
    return { text: 'ULTRA', cssClass: 'plan-badge-ultra', tooltip: planLabel || 'Google AI Ultra' };
  }
  if (p === AccountPlan.TRIAL || labelLower.includes('trial')) {
    return { text: 'TRIAL', cssClass: 'plan-badge-trial', tooltip: planLabel || 'Trial' };
  }
  if (p === AccountPlan.PRO || p === AccountPlan.PREMIUM) {
    const text = labelLower.includes('plus') ? 'PLUS' : 'PRO';
    return { text, cssClass: 'plan-badge-pro', tooltip: planLabel || 'Google AI Pro' };
  }
  if (p === AccountPlan.ENTERPRISE) {
    return { text: 'ENT', cssClass: 'plan-badge-enterprise', tooltip: planLabel || 'Enterprise' };
  }
  if (p === AccountPlan.FREE) {
    return { text: 'FREE', cssClass: 'plan-badge-free', tooltip: planLabel || 'Free' };
  }

  return null;
}
