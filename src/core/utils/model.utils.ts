/**
 * Model Utilities
 *
 * Provides model key mapping and formatting to match display names in Antigravity IDE.
 * Filters out deprecated/unsupported models to keep UI clean and consistent.
 */

import {
  EXCLUDED_MODEL_PREFIXES,
  EXCLUDED_MODEL_SUBSTRINGS,
  EXACT_MODEL_MAP
} from '../constants/model-catalog.constants';

export function normalizeModelKey(key: string): string {
  if (!key) return '';
  let lower = key.toLowerCase().trim();
  if (lower.startsWith('models/')) {
    lower = lower.substring('models/'.length);
  }

  if (EXACT_MODEL_MAP[lower]) {
    return EXACT_MODEL_MAP[lower];
  }

  // Substring checks for Gemini variants
  if (lower.includes('3.8-flash-tiered') || lower.includes('3.8-flash-high')) return '3.8 Flash (High)';
  if (lower.includes('3.8-flash-med')) return '3.8 Flash (Med)';
  if (lower.includes('3.8-flash-low')) return '3.8 Flash (Low)';
  if (lower.includes('hydrogen')) return 'Gemini 4 Hydrogen';
  if (lower.includes('neon')) return 'Gemini 4 Neon';

  const friendly = getFriendlyModelName(key);
  return friendly || key.trim();
}

export function getFriendlyModelName(key: string): string | null {
  if (!key) return null;
  let lower = key.toLowerCase().trim();
  if (lower.startsWith('models/')) {
    lower = lower.substring('models/'.length);
  }

  // Exclude deprecated or internal models
  if (EXCLUDED_MODEL_PREFIXES.some(prefix => lower.startsWith(prefix))) {
    return null;
  }
  if (EXCLUDED_MODEL_SUBSTRINGS.some(sub => lower.includes(sub))) {
    return null;
  }

  if (EXACT_MODEL_MAP[lower]) {
    return EXACT_MODEL_MAP[lower];
  }

  if (lower.includes('3.8-flash-tiered') || lower.includes('3.8-flash-high')) return '3.8 Flash (High)';
  if (lower.includes('3.8-flash-med')) return '3.8 Flash (Med)';
  if (lower.includes('3.8-flash-low')) return '3.8 Flash (Low)';
  if (lower.includes('hydrogen')) return 'Gemini 4 Hydrogen';
  if (lower.includes('neon')) return 'Gemini 4 Neon';

  // Dynamic Claude version formatting
  if (lower.includes('sonnet') && (lower.includes('5-5') || lower.includes('5.5'))) return 'Sonnet 5.5';
  if (lower.includes('opus') && (lower.includes('5-5') || lower.includes('5.5'))) return 'Opus 5.5';
  if (lower.includes('sonnet') && (lower.includes('4-6') || lower.includes('4.6'))) return 'Sonnet 4.6';
  if (lower.includes('opus') && (lower.includes('4-6') || lower.includes('4.6'))) return 'Opus 4.6';
  if (lower.includes('sonnet') && (lower.includes('3-5') || lower.includes('3.5'))) return 'Sonnet 3.5';
  if (lower.includes('opus') && (lower.includes('3-5') || lower.includes('3.5'))) return 'Opus 3.5';

  if (lower.startsWith('claude-sonnet-')) {
    const version = lower.replace('claude-sonnet-', '').replace(/-/g, '.');
    return `Sonnet ${version}`;
  }
  if (lower.startsWith('claude-opus-')) {
    const version = lower.replace('claude-opus-', '').replace('-thinking', '').replace(/-/g, '.');
    return `Opus ${version}`;
  }
  if (lower.startsWith('claude-') && lower.endsWith('-all')) {
    const version = lower.replace('claude-', '').replace('-all', '').replace(/-/g, '.');
    return `Claude ${version}`;
  }

  // Fallback: title-case words
  return key
    .split(/[-_\s]+/)
    .map(word => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

export function getModelBalanceValue(balances: Record<string, any> | undefined, targetKey: string): number {
  const entry = getModelBalanceEntry(balances, targetKey);
  return entry ? entry.value : -1;
}

export function getModelBalanceEntry(
  balances: Record<string, any> | undefined,
  targetKey: string
): { key: string; value: number; resetTime?: string } | null {
  if (!balances || !targetKey) return null;
  const normalizedTarget = normalizeModelKey(targetKey).toLowerCase();
  const lowerTarget = targetKey.toLowerCase();

  const candidates: Array<{ key: string; rawKey: string; value: number; resetTime?: string }> = [];

  for (const [k, v] of Object.entries(balances)) {
    if (!k) continue;
    const friendlyName = getFriendlyModelName(k);
    const normalizedK = normalizeModelKey(k);

    if (
      (friendlyName && friendlyName.toLowerCase() === normalizedTarget) ||
      (friendlyName && friendlyName.toLowerCase() === lowerTarget) ||
      normalizedK.toLowerCase() === normalizedTarget ||
      k.toLowerCase() === lowerTarget ||
      k.toLowerCase().includes(normalizedTarget) ||
      normalizedTarget.includes(k.toLowerCase())
    ) {
      let value = 0;
      let resetTime: string | undefined;
      if (typeof v === 'object' && v !== null && 'value' in v) {
        value = typeof v.value === 'number' ? v.value : Number(v.value);
        resetTime = v.resetTime;
      } else {
        value = typeof v === 'number' ? v : Number(v);
      }
      candidates.push({
        key: friendlyName || normalizeModelKey(targetKey),
        rawKey: k,
        value: isNaN(value) ? 0 : value,
        resetTime
      });
    }
  }

  if (candidates.length > 0) {
    const canonical = candidates.find(c => c.rawKey.includes('tiered'));
    if (canonical) {
      return { key: canonical.key, value: canonical.value, resetTime: canonical.resetTime };
    }
    return { key: candidates[0].key, value: candidates[0].value, resetTime: candidates[0].resetTime };
  }

  // Claude 5.5 version match fallback
  if (normalizedTarget.includes('5.5') || lowerTarget.includes('5.5') || lowerTarget.includes('5-5')) {
    const isSonnet = normalizedTarget.includes('sonnet') || lowerTarget.includes('sonnet');
    const isOpus = normalizedTarget.includes('opus') || lowerTarget.includes('opus');
    for (const [k, v] of Object.entries(balances)) {
      if (!k) continue;
      const lowerK = k.toLowerCase();
      if (
        (lowerK.includes('5-5') || lowerK.includes('5.5')) &&
        ((isSonnet && lowerK.includes('sonnet')) ||
         (isOpus && lowerK.includes('opus')) ||
         (!isSonnet && !isOpus && lowerK.includes('claude')))
      ) {
        let value = 0;
        let resetTime: string | undefined;
        if (typeof v === 'object' && v !== null && 'value' in v) {
          value = typeof v.value === 'number' ? v.value : Number(v.value);
          resetTime = v.resetTime;
        } else {
          value = typeof v === 'number' ? v : Number(v);
        }
        return {
          key: getFriendlyModelName(k) || normalizeModelKey(targetKey),
          value: isNaN(value) ? 0 : value,
          resetTime
        };
      }
    }
  }

  // Thinking Claude match fallback
  if (lowerTarget.startsWith('claude ') && lowerTarget.endsWith(' (thinking)')) {
    const targetVersion = lowerTarget.replace('claude ', '').replace(' (thinking)', '');
    for (const [k, v] of Object.entries(balances)) {
      if (!k || !k.toLowerCase().includes('claude')) continue;
      const friendlyName = getFriendlyModelName(k);
      if (friendlyName && friendlyName.toLowerCase().includes(` ${targetVersion} `)) {
        let value = 0;
        let resetTime: string | undefined;
        if (typeof v === 'object' && v !== null && 'value' in v) {
          value = typeof v.value === 'number' ? v.value : Number(v.value);
          resetTime = v.resetTime;
        } else {
          value = typeof v === 'number' ? v : Number(v);
        }
        return {
          key: friendlyName,
          value: isNaN(value) ? 0 : value,
          resetTime
        };
      }
    }
  }

  return null;
}
