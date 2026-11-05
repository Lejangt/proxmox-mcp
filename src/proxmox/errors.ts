/**
 * Error types shared by config, secrets and the Proxmox client.
 *
 * None of these errors ever carries a secret value, request headers or a URL
 * with credentials. Messages are meant to be shown to the agent and the user.
 */

export class ConfigError extends Error {
  override name = 'ConfigError';
}

export class SecretError extends Error {
  override name = 'SecretError';
}

export class TlsError extends Error {
  override name = 'TlsError';
}

/** Network level failure (connection refused, timeout, size limit, redirect). */
export class ProxmoxConnectionError extends Error {
  override name = 'ProxmoxConnectionError';
}

export class ReadOnlyError extends Error {
  override name = 'ReadOnlyError';
  constructor(
    readonly alias: string,
    readonly method: string,
    readonly path: string,
  ) {
    super(
      `Host "${alias}" is read-only: ${method} ${path} was refused before any request was sent. ` +
        'Set readOnly: false for the host and globally to allow changes.',
    );
  }
}

export interface ProxmoxApiErrorInit {
  status: number;
  method: string;
  /** API path without query string. */
  path: string;
  /** Message reported by Proxmox (reason phrase or body message). */
  proxmoxMessage?: string;
  /** Per parameter validation errors from the response body. */
  errors?: Record<string, string>;
  hint?: string;
}

export class ProxmoxApiError extends Error {
  override name = 'ProxmoxApiError';
  readonly status: number;
  readonly method: string;
  readonly path: string;
  readonly proxmoxMessage?: string;
  readonly errors?: Record<string, string>;

  constructor(init: ProxmoxApiErrorInit) {
    const parts = [`${init.method} ${init.path} failed with HTTP ${init.status}`];
    if (init.proxmoxMessage) parts.push(init.proxmoxMessage);
    let message = parts.join(': ');
    if (init.errors && Object.keys(init.errors).length > 0) {
      const details = Object.entries(init.errors)
        .map(([key, value]) => `${key}: ${value}`)
        .join('\n');
      message += `\nParameter errors:\n${details}`;
    }
    if (init.hint) message += `\n${init.hint}`;
    super(message);
    this.status = init.status;
    this.method = init.method;
    this.path = init.path;
    if (init.proxmoxMessage !== undefined) this.proxmoxMessage = init.proxmoxMessage;
    if (init.errors !== undefined) this.errors = init.errors;
  }
}

/*
 * Every resolved secret is registered here so that any text leaving the
 * process (tool output, error messages, logs) can be scrubbed as a last line
 * of defence. Values shorter than 4 characters are not registered because
 * replacing them would mangle ordinary text without protecting anything real.
 */
const knownSecrets = new Set<string>();
const MIN_REDACT_LENGTH = 4;

export const REDACTED = '[REDACTED]';

export function registerSecret(value: string): void {
  if (value.length >= MIN_REDACT_LENGTH) knownSecrets.add(value);
}

/** For tests. */
export function clearRegisteredSecrets(): void {
  knownSecrets.clear();
}

/**
 * Removes every registered secret and every value in `extra` from `text`.
 * Longer values are replaced first so a secret that contains another one is
 * removed completely.
 */
export function redactSecrets(text: string, extra: Iterable<string> = []): string {
  const values = new Set<string>(knownSecrets);
  for (const value of extra) {
    if (value.length >= MIN_REDACT_LENGTH) values.add(value);
  }
  if (values.size === 0 || text.length === 0) return text;
  let out = text;
  for (const value of [...values].sort((a, b) => b.length - a.length)) {
    if (out.includes(value)) out = out.split(value).join(REDACTED);
  }
  return out;
}

/** Strips control characters (except newline and tab) and limits the length. */
export function sanitizeText(text: string, maxLength = 500): string {
  // eslint-disable-next-line no-control-regex
  const cleaned = text.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '');
  return cleaned.length > maxLength ? `${cleaned.slice(0, maxLength)}...` : cleaned;
}
