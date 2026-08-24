/**
 * Model Utilities
 * 
 * Provides model key mapping and formatting to match the display names in Antigravity IDE.
 * Filters out deprecated/unsupported models to keep the UI clean.
 */

export function normalizeModelKey(key: string): string {
  if (!key) return '';
  const lower = key.toLowerCase().trim();

  // Explicit mappings for all known aliases and legacy strings
  if (lower === 'gemini-3.7-flash' || lower === 'gemini-3.7-flash-tiered' || lower === 'gemini 3.7 flash' || lower === 'gemini 3.7 flash tiered' || lower === 'gemini 3.7 flash (tiered)' || lower === '3.7 flash' || lower === '3.7-flash') {
    return '3.7 Flash';
  }
  if (lower === 'gemini-3.5-flash-extra-low' || lower === 'gemini 3.5 flash (low)' || lower === '3.5 flash (med)') {
    return '3.5 Flash (Med)';
  }
  if (lower === 'gemini-3.5-flash-low' || lower === 'gemini-3.5-flash-medium' || lower === 'gemini-3.5-flash-high' || lower === 'gemini-3.5-flash' || lower === 'gemini 3.5 flash' || lower === 'gemini 3.5 flash (high)' || lower === 'gemini 3.5 flash (medium)' || lower === '3.5 flash (high)') {
    return '3.5 Flash (High)';
  }
  if (lower === 'gemini-3.1-pro-low' || lower === 'gemini 3.1 pro (low)' || lower === '3.1 pro (low)') {
    return '3.1 Pro (Low)';
  }
  if (lower === 'gemini-3.1-pro-high' || lower === 'gemini 3.1 pro (high)' || lower === '3.1 pro (high)') {
    return '3.1 Pro (High)';
  }
  if (lower === 'gpt-oss-120b-medium' || lower === 'gpt-oss 120b' || lower === 'gpt-oss 120b (medium)') {
    return 'GPT-OSS 120B';
  }
  if (lower === 'claude-sonnet-4-6' || lower === 'claude sonnet 4.6 (thinking)' || lower === 'sonnet 4.6' || lower === 'claude sonnet 4.6') {
    return 'Sonnet 4.6';
  }
  if (lower === 'claude-opus-4-6' || lower === 'claude-opus-4-6-thinking' || lower === 'claude opus 4.6 (thinking)' || lower === 'opus 4.6' || lower === 'claude opus 4.6') {
    return 'Opus 4.6';
  }

  const friendly = getFriendlyModelName(key);
  if (friendly) return friendly;
  return key.trim();
}

export function getFriendlyModelName(key: string): string | null {
  const lower = key.toLowerCase();
  
  // Exclude known deprecated/unsupported/internal models in the IDE
  if (
    lower.includes('gemini-3-flash') ||
    lower.includes('gemini-3.1-flash') ||
    lower.includes('gemini-pro-agent') ||
    lower.includes('gemini-2.5') ||
    lower.startsWith('tab_') ||
    lower.startsWith('chat_') ||
    lower.startsWith('tap_')
  ) {
    return null;
  }
  
  // Precise mapping of current active IDE models
  if (lower === 'gemini-3.7-flash' || lower === 'gemini-3.7-flash-tiered' || lower === 'gemini 3.7 flash' || lower === 'gemini 3.7 flash tiered') return '3.7 Flash';
  if (lower === 'gemini-3.5-flash-extra-low') return '3.5 Flash (Med)';
  if (lower === 'gemini-3.5-flash-low') return '3.5 Flash (High)';
  if (lower === 'gemini-3.5-flash-medium') return '3.5 Flash (High)';
  if (lower === 'gemini-3.5-flash-high') return '3.5 Flash (High)';
  if (lower === 'gemini-3.5-flash') return '3.5 Flash (High)';
  
  if (lower === 'gemini-3.1-pro-low') return '3.1 Pro (Low)';
  if (lower === 'gemini-3.1-pro-high') return '3.1 Pro (High)';
  
  if (lower === 'gpt-oss-120b-medium') return 'GPT-OSS 120B';
  
  // Dynamic Claude formatting
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
  
  // Fallback: format unrecognized keys nicely
  return key
    .split(/[-_\s]+/)
    .map(word => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

export function getModelBalanceValue(balances: Record<string, any> | undefined, targetKey: string): number {
  if (!balances || !targetKey) return -1;
  const normalizedTarget = normalizeModelKey(targetKey).toLowerCase();
  const lowerTarget = targetKey.toLowerCase();
  
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
      if (typeof v === 'object' && v !== null && 'value' in v) {
        return v.value;
      }
      return typeof v === 'number' ? v : Number(v);
    }
  }

  // Handle Claude version match (e.g. Claude 4.6 (Thinking))
  if (lowerTarget.startsWith('claude ') && lowerTarget.endsWith(' (thinking)')) {
    const targetVersion = lowerTarget.replace('claude ', '').replace(' (thinking)', '');
    for (const [k, v] of Object.entries(balances)) {
      if (!k || !k.toLowerCase().includes('claude')) continue;
      const friendlyName = getFriendlyModelName(k);
      if (friendlyName && friendlyName.toLowerCase().includes(` ${targetVersion} `)) {
        if (typeof v === 'object' && v !== null && 'value' in v) {
          return v.value;
        }
        return typeof v === 'number' ? v : Number(v);
      }
    }
  }

  return -1;
}
