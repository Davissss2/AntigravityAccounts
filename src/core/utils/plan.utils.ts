/**
 * Subscription Plan Utilities
 *
 * Strictly maps Google Cloud Code / Antigravity `loadCodeAssist` tier metadata
 * (`paidTier` / `currentTier` / `allowedTiers`) to canonical `AccountPlan` enums
 * and UI badge metadata without false positives on Free Starter tiers.
 */

import { AccountPlan } from '../domain/models/account.model';

export interface TierMetadata {
  id?: string;
  name?: string;
  description?: string;
}

export interface LoadCodeAssistTierPayload {
  paidTier?: TierMetadata | null;
  currentTier?: TierMetadata | null;
  allowedTiers?: Array<TierMetadata & { isDefault?: boolean }> | null;
  cloudaicompanionProject?: string | null;
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

export function detectAccountPlan(data?: LoadCodeAssistTierPayload | null): DetectedPlan {
  if (!data || typeof data !== 'object') return { plan: AccountPlan.UNKNOWN };

  const paid = data.paidTier || undefined;
  const current = data.currentTier || undefined;

  const paidId = String(paid?.id || '').toLowerCase();
  const paidName = String(paid?.name || '').toLowerCase();
  const paidText = [paidId, paidName, String(paid?.description || '').toLowerCase()].filter(Boolean).join(' ');

  // 1. Inspect paidTier strictly (Google reports "Antigravity Starter Quota" in paidTier for FREE accounts!)
  if (paidText) {
    const label = paid?.name || paid?.description || paid?.id;

    // Free / Starter tiers reported inside paidTier must NEVER become PRO/PREMIUM
    if (/\b(starter|free)\b/.test(paidText) || paidId === 'free-tier') {
      return { plan: AccountPlan.FREE, planLabel: 'Free' };
    }
    if (/\btrial\b/.test(paidText)) {
      return { plan: AccountPlan.TRIAL, planLabel: label || 'Trial' };
    }
    if (paidId === 'g1-ultra-tier' || /\bultra\b/.test(paidText)) {
      return { plan: AccountPlan.ULTRA, planLabel: label || 'Google AI Ultra' };
    }
    if (paidId === 'g1-pro-tier' || paidId === 'g1-plus-tier' || /\b(pro|plus)\b/.test(paidName) || /\b(google ai pro|google ai plus)\b/.test(paidText)) {
      return { plan: AccountPlan.PRO, planLabel: label || 'Google AI Pro' };
    }
    if (/\b(enterprise|business)\b/.test(paidText)) {
      return { plan: AccountPlan.ENTERPRISE, planLabel: label || 'Enterprise' };
    }
  }

  // 2. Inspect currentTier strictly (using id and name only, never prose descriptions)
  const currentId = String(current?.id || '').toLowerCase();
  const currentName = String(current?.name || '').toLowerCase();
  const currentIdName = [currentId, currentName].filter(Boolean).join(' ');

  if (currentIdName) {
    const label = current?.name || current?.id;
    if (/\btrial\b/.test(currentIdName)) {
      return { plan: AccountPlan.TRIAL, planLabel: label || 'Trial' };
    }
    if (currentId === 'g1-ultra-tier' || /\bultra\b/.test(currentIdName)) {
      return { plan: AccountPlan.ULTRA, planLabel: label || 'Google AI Ultra' };
    }
    if (currentId === 'g1-pro-tier' || currentId === 'g1-plus-tier' || /\b(pro|plus)\b/.test(currentName)) {
      return { plan: AccountPlan.PRO, planLabel: label || 'Google AI Pro' };
    }
    if (currentId === 'standard-tier' || /\b(enterprise|business)\b/.test(currentIdName)) {
      return { plan: AccountPlan.ENTERPRISE, planLabel: label || 'Enterprise' };
    }
    if (currentId === 'free-tier' || /\b(free|starter|antigravity|legacy)\b/.test(currentIdName)) {
      return { plan: AccountPlan.FREE, planLabel: 'Free' };
    }
  }

  // 3. Valid loadCodeAssist response with no paid tier (e.g. free consumer account with allowedTiers/project)
  const hasFreeAllowed = Array.isArray(data.allowedTiers) &&
    data.allowedTiers.some(t => String(t?.id || '').toLowerCase() === 'free-tier');
  if (hasFreeAllowed || data.cloudaicompanionProject || current) {
    return { plan: AccountPlan.FREE, planLabel: 'Free' };
  }

  return { plan: AccountPlan.UNKNOWN };
}

export function getPlanBadgeMeta(plan?: AccountPlan | string, planLabel?: string): PlanBadgeMeta | null {
  if (!plan || plan === AccountPlan.UNKNOWN) return null;

  const p = String(plan).toLowerCase();
  const labelLower = (planLabel || '').toLowerCase();

  // Guard against legacy misclassified "Antigravity Starter Quota" stored as premium
  if (/\b(starter|free)\b/.test(labelLower)) {
    return { text: 'FREE', cssClass: 'plan-badge-free', tooltip: 'Free' };
  }
  if (p === AccountPlan.ULTRA || /\bultra\b/.test(labelLower)) {
    return { text: 'ULTRA', cssClass: 'plan-badge-ultra', tooltip: planLabel || 'Google AI Ultra' };
  }
  if (p === AccountPlan.TRIAL || /\btrial\b/.test(labelLower)) {
    return { text: 'TRIAL', cssClass: 'plan-badge-trial', tooltip: planLabel || 'Trial' };
  }
  if (p === AccountPlan.PRO || p === AccountPlan.PREMIUM) {
    const text = /\bplus\b/.test(labelLower) ? 'PLUS' : 'PRO';
    return { text, cssClass: 'plan-badge-pro', tooltip: planLabel || 'Google AI Pro' };
  }
  if (p === AccountPlan.ENTERPRISE) {
    return { text: 'ENT', cssClass: 'plan-badge-enterprise', tooltip: planLabel || 'Enterprise' };
  }
  if (p === AccountPlan.FREE) {
    return { text: 'FREE', cssClass: 'plan-badge-free', tooltip: 'Free' };
  }

  return null;
}
