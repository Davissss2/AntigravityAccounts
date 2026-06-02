/**
 * Model Utilities
 * 
 * Provides model key mapping and formatting to match the display names in Antigravity IDE.
 * Filters out deprecated/unsupported models to keep the UI clean.
 */

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
  if (lower === 'gemini-3.5-flash-extra-low') return 'Gemini 3.5 Flash (Low)';
  if (lower === 'gemini-3.5-flash-low') return 'Gemini 3.5 Flash (Medium)';
  if (lower === 'gemini-3.5-flash-medium') return 'Gemini 3.5 Flash (High)';
  if (lower === 'gemini-3.5-flash-high') return 'Gemini 3.5 Flash (High)';
  if (lower === 'gemini-3.5-flash') return 'Gemini 3.5 Flash (High)';
  
  if (lower === 'gemini-3.1-pro-low') return 'Gemini 3.1 Pro (Low)';
  if (lower === 'gemini-3.1-pro-high') return 'Gemini 3.1 Pro (High)';
  
  if (lower === 'gpt-oss-120b-medium') return 'GPT-OSS 120B (Medium)';
  
  // Dynamic Claude formatting
  if (lower.startsWith('claude-sonnet-')) {
    const version = lower.replace('claude-sonnet-', '').replace(/-/g, '.');
    return `Claude Sonnet ${version} (Thinking)`;
  }
  if (lower.startsWith('claude-opus-')) {
    const version = lower.replace('claude-opus-', '').replace('-thinking', '').replace(/-/g, '.');
    return `Claude Opus ${version} (Thinking)`;
  }
  if (lower.startsWith('claude-') && lower.endsWith('-all')) {
    const version = lower.replace('claude-', '').replace('-all', '').replace(/-/g, '.');
    return `Claude ${version} (Thinking)`;
  }
  
  // Fallback: format unrecognized keys nicely
  return key
    .split(/[-_\s]+/)
    .map(word => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}
