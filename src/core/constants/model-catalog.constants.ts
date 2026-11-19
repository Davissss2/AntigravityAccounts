/**
 * Model Catalog Constants
 * Centralized mappings, aliases, and exclusion filters for AI models.
 */

export const EXCLUDED_MODEL_PREFIXES: readonly string[] = ['tab_', 'chat_', 'tap_'];

export const EXCLUDED_MODEL_SUBSTRINGS: readonly string[] = [
  'gemini-3-flash',
  'gemini-3.1-flash',
  'gemini-pro-agent',
  'gemini-2.5'
];

export const EXACT_MODEL_MAP: Record<string, string> = {
  // Gemini 3.8 Flash (High / Tiered)
  'gemini-3.8-flash': '3.8 Flash (High)',
  'gemini 3.8 flash': '3.8 Flash (High)',
  '3.8 flash': '3.8 Flash (High)',
  '3.8-flash': '3.8 Flash (High)',
  'gemini-3.8-flash-high': '3.8 Flash (High)',
  'gemini 3.8 flash (high)': '3.8 Flash (High)',
  '3.8 flash (high)': '3.8 Flash (High)',
  'gemini-3.8-flash-tiered': '3.8 Flash (High)',
  'gemini 3.8 flash tiered': '3.8 Flash (High)',
  'gemini 3.8 flash (tiered)': '3.8 Flash (High)',

  // Gemini 3.8 Flash (Med)
  'gemini-3.8-flash-medium': '3.8 Flash (Med)',
  'gemini-3.8-flash-med': '3.8 Flash (Med)',
  'gemini 3.8 flash (med)': '3.8 Flash (Med)',
  '3.8 flash (med)': '3.8 Flash (Med)',
  'gemini-3.8-flash-extra-low': '3.8 Flash (Med)',

  // Gemini 3.8 Flash (Low)
  'gemini-3.8-flash-low': '3.8 Flash (Low)',
  'gemini 3.8 flash (low)': '3.8 Flash (Low)',
  '3.8 flash (low)': '3.8 Flash (Low)',

  // Gemini 3.7 Flash
  'gemini-3.7-flash': '3.7 Flash',
  'gemini-3.7-flash-tiered': '3.7 Flash',
  'gemini 3.7 flash': '3.7 Flash',
  'gemini 3.7 flash tiered': '3.7 Flash',
  'gemini 3.7 flash (tiered)': '3.7 Flash',
  '3.7 flash': '3.7 Flash',
  '3.7-flash': '3.7 Flash',

  // Gemini 3.5 Flash
  'gemini-3.5-flash-extra-low': '3.5 Flash (Med)',
  'gemini 3.5 flash (low)': '3.5 Flash (Med)',
  'gemini 3.5 flash (med)': '3.5 Flash (Med)',
  'gemini-3.5-flash-low': '3.5 Flash (High)',
  'gemini-3.5-flash-medium': '3.5 Flash (High)',
  'gemini-3.5-flash-high': '3.5 Flash (High)',
  'gemini-3.5-flash': '3.5 Flash (High)',
  'gemini 3.5 flash': '3.5 Flash (High)',
  'gemini 3.5 flash (high)': '3.5 Flash (High)',
  'gemini 3.5 flash (medium)': '3.5 Flash (High)',
  '3.5 flash (high)': '3.5 Flash (High)',

  // Gemini 3.1 Pro
  'gemini-3.1-pro-low': '3.1 Pro (Low)',
  'gemini 3.1 pro (low)': '3.1 Pro (Low)',
  '3.1 pro (low)': '3.1 Pro (Low)',
  'gemini-3.1-pro-high': '3.1 Pro (High)',
  'gemini 3.1 pro (high)': '3.1 Pro (High)',
  '3.1 pro (high)': '3.1 Pro (High)',

  // GPT-OSS 120B
  'gpt-oss-120b-medium': 'GPT-OSS 120B',
  'gpt-oss 120b': 'GPT-OSS 120B',
  'gpt-oss 120b (medium)': 'GPT-OSS 120B',

  // Claude 5.5
  'claude-sonnet-5-5': 'Sonnet 5.5',
  'claude-sonnet-5.5': 'Sonnet 5.5',
  'claude sonnet 5.5': 'Sonnet 5.5',
  'claude sonnet 5.5 (thinking)': 'Sonnet 5.5',
  'sonnet 5.5': 'Sonnet 5.5',
  'sonnet-5-5': 'Sonnet 5.5',
  'claude-5-5-sonnet': 'Sonnet 5.5',
  'claude 5.5 sonnet': 'Sonnet 5.5',
  'claude-sonnet-5-5-thinking': 'Sonnet 5.5',
  'claude-opus-5-5': 'Opus 5.5',
  'claude-opus-5.5': 'Opus 5.5',
  'claude-opus-5-5-thinking': 'Opus 5.5',
  'claude-opus-5.5-thinking': 'Opus 5.5',
  'claude opus 5.5 (thinking)': 'Opus 5.5',
  'claude opus 5.5': 'Opus 5.5',
  'opus 5.5': 'Opus 5.5',
  'opus-5-5': 'Opus 5.5',
  'claude-5-5-opus': 'Opus 5.5',
  'claude 5.5 opus': 'Opus 5.5',

  // Claude 4.6
  'claude-sonnet-4-6': 'Sonnet 4.6',
  'claude sonnet 4.6 (thinking)': 'Sonnet 4.6',
  'sonnet 4.6': 'Sonnet 4.6',
  'claude sonnet 4.6': 'Sonnet 4.6',
  'claude-opus-4-6': 'Opus 4.6',
  'claude-opus-4-6-thinking': 'Opus 4.6',
  'claude opus 4.6 (thinking)': 'Opus 4.6',
  'opus 4.6': 'Opus 4.6',
  'claude opus 4.6': 'Opus 4.6',

  // Claude 3.5
  'claude-sonnet-3-5': 'Sonnet 3.5',
  'claude-sonnet-3.5': 'Sonnet 3.5',
  'claude-3-5-sonnet': 'Sonnet 3.5',
  'claude 3.5 sonnet': 'Sonnet 3.5',
  'sonnet 3.5': 'Sonnet 3.5',
  'sonnet-3-5': 'Sonnet 3.5',
  'claude-opus-3-5': 'Opus 3.5',
  'claude-opus-3.5': 'Opus 3.5',
  'claude-3-5-opus': 'Opus 3.5',
  'claude 3.5 opus': 'Opus 3.5',
  'opus 3.5': 'Opus 3.5',
  'opus-3-5': 'Opus 3.5'
};
