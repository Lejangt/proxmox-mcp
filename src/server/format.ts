import type { CallToolResult } from '@modelcontextprotocol/server';
import { redactSecrets } from '../proxmox/errors.js';

/*
 * Every text that leaves through a tool result passes redactSecrets first, as
 * the last line of defence against a resolved token secret showing up in
 * output or error messages. Redaction runs before truncation, so a secret
 * cut in half at the truncation point cannot slip through.
 */

/** Upper bound for error text so a huge upstream message cannot flood the model context. */
const MAX_ERROR_CHARS = 2000;

export function formatResult(data: unknown, maxChars: number): CallToolResult {
  const text = typeof data === 'string' ? data : (JSON.stringify(data ?? null, null, 2) ?? 'null');
  return { content: [{ type: 'text', text: truncate(redactSecrets(text), maxChars) }] };
}

export function truncate(text: string, maxChars: number): string {
  if (maxChars <= 0 || text.length <= maxChars) return text;
  const note =
    `\n\n[Output truncated: showing ${maxChars} of ${text.length} characters. ` +
    'Narrow the query with filters, a smaller limit or a more specific path to get the rest.]';
  return text.slice(0, maxChars) + note;
}

interface ApiErrorLike {
  status: number;
  message?: string;
  errors?: Record<string, unknown>;
}

/**
 * ProxmoxApiError is detected by shape (numeric `status`) so this module does
 * not depend on the client implementation.
 */
function isApiErrorLike(err: unknown): err is ApiErrorLike {
  return (
    typeof err === 'object' &&
    err !== null &&
    typeof (err as { status?: unknown }).status === 'number' &&
    (err instanceof Error || typeof (err as { message?: unknown }).message === 'string')
  );
}

export function errorMessage(err: unknown): string {
  if (isApiErrorLike(err)) {
    const message = err.message ?? 'request failed';
    const lines = [`Proxmox API error (HTTP ${err.status}): ${message}`];
    const errors = err.errors;
    // ProxmoxApiError already lists the parameter errors in its message.
    if (errors && typeof errors === 'object' && !message.includes('\nParameter errors:\n')) {
      const entries = Object.entries(errors);
      if (entries.length > 0) {
        lines.push('Parameter errors:');
        for (const [key, value] of entries) lines.push(`  ${key}: ${String(value)}`);
      }
    }
    return clip(lines.join('\n'));
  }
  if (err instanceof Error) {
    if (err.name === 'AbortError') return 'The request was cancelled.';
    return clip(err.message || err.name);
  }
  return clip(typeof err === 'string' ? err : 'Unknown error');
}

export function formatError(err: unknown): CallToolResult {
  return { isError: true, content: [{ type: 'text', text: errorMessage(err) }] };
}

/** An error result for a refusal or validation problem that is not an exception. */
export function errorResult(message: string): CallToolResult {
  return { isError: true, content: [{ type: 'text', text: clip(message) }] };
}

function clip(text: string): string {
  const clean = redactSecrets(text);
  return clean.length > MAX_ERROR_CHARS ? clean.slice(0, MAX_ERROR_CHARS) + ' [...]' : clean;
}
