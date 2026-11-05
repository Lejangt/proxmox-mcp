import { redactSecrets } from '../proxmox/errors.js';

/** A failure the user can act on. Printed without a stack trace. */
export class CliError extends Error {
  override name = 'CliError';
  constructor(
    message: string,
    readonly exitCode = 1,
  ) {
    super(message);
  }
}

/** Wrong arguments. Exit code 2. */
export class UsageError extends CliError {
  override name = 'UsageError';
  constructor(message: string) {
    super(message, 2);
  }
}

/** The user cancelled a prompt. */
export class CancelledError extends CliError {
  override name = 'CancelledError';
  constructor() {
    super('Cancelled.', 130);
  }
}

/** Message of any thrown value, scrubbed of known secrets, never with a stack. */
export function messageOf(err: unknown): string {
  const raw = err instanceof Error ? err.message || err.name : String(err);
  return redactSecrets(raw);
}

export function exitCodeOf(err: unknown): number {
  return err instanceof CliError ? err.exitCode : 1;
}
