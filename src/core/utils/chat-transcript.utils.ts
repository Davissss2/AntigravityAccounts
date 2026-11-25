/**
 * Chat Transcript Utilities
 * Inspects transcript.jsonl tails to detect quota failures, capacity errors, and open runs.
 */

import * as fs from 'fs';
import { Logger } from './logger';

export const QUOTA_KEYWORDS = [
  '503',
  '429',
  'unavailable',
  'resource_exhausted',
  'capacity',
  'quota',
  'individual quota',
  'baseline quota',
  'limit reached',
  'rate limit',
  'rate_limit',
  'no capacity available'
];

export function isRunStillOpen(entries: any[]): boolean {
  if (!entries || entries.length === 0) return false;

  let last: any = null;
  for (let i = entries.length - 1; i >= 0; i--) {
    if (entries[i] && typeof entries[i] === 'object') {
      last = entries[i];
      break;
    }
  }
  if (!last) return false;

  const type = String(last.type || '').toUpperCase();
  const status = String(last.status || '').toUpperCase();
  const hasToolCalls = Array.isArray(last.tool_calls) && last.tool_calls.length > 0;
  const hasContent = String(last.content || '').trim().length > 0;

  if (['RUNNING', 'IN_PROGRESS', 'PENDING', 'QUEUED'].includes(status)) return true;
  if (type === 'ERROR_MESSAGE') return false;
  if (type === 'USER_INPUT') return true;
  if (type === 'GENERIC' || type === 'TOOL_RESPONSE' || type === 'TOOL_CALL') return true;
  if (type === 'PLANNER_RESPONSE') return hasToolCalls;
  if (hasToolCalls) return true;
  return !hasContent;
}

export function inspectTranscriptTail(transcriptPath: string): { isQuotaError: boolean; runStillOpen: boolean } {
  let isQuotaError = false;
  let runStillOpen = false;

  try {
    const stat = fs.statSync(transcriptPath);
    const bufferSize = Math.min(stat.size, 65536);
    const fd = fs.openSync(transcriptPath, 'r');
    const buffer = Buffer.alloc(bufferSize);
    fs.readSync(fd, buffer, 0, bufferSize, Math.max(0, stat.size - bufferSize));
    fs.closeSync(fd);

    const chunk = buffer.toString('utf-8');
    const lines = chunk.trim().split('\n').filter(Boolean);
    const tailLines = lines.slice(-20);

    const entries: any[] = [];
    for (const line of tailLines) {
      try {
        entries.push(JSON.parse(line));
      } catch {}
    }

    for (let i = entries.length - 1; i >= 0; i--) {
      const entry = entries[i];
      const content = String(entry.content || '').toLowerCase();
      const status = String(entry.status || '').toLowerCase();
      const type = String(entry.type || '').toUpperCase();

      if (type === 'ERROR_MESSAGE' || status === 'error') {
        for (const kw of QUOTA_KEYWORDS) {
          if (content.includes(kw)) {
            isQuotaError = true;
            break;
          }
        }
      }
      if (!isQuotaError) {
        for (const kw of QUOTA_KEYWORDS) {
          if (
            content.includes(kw) &&
            (content.includes('error') ||
              content.includes('code 503') ||
              content.includes('capacity') ||
              content.includes('exhausted') ||
              content.includes('quota'))
          ) {
            isQuotaError = true;
            break;
          }
        }
      }
      if (isQuotaError) break;
    }

    runStillOpen = isRunStillOpen(entries);
  } catch (err: any) {
    Logger.getInstance().debug('[ChatTranscript] Error reading transcript tail', err);
  }

  return { isQuotaError, runStillOpen };
}
