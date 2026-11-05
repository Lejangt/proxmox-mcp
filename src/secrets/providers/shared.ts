import { SecretError } from '../../proxmox/errors.js';

export interface SecretContext {
  /** Host alias the secret belongs to, used for messages and keyring defaults. */
  host: string;
  /** Environment to read from. Defaults to process.env. */
  env?: NodeJS.ProcessEnv;
  /** Timeout for external commands. */
  timeoutMs?: number;
  /** What is being resolved, for messages. Defaults to "token secret". */
  purpose?: string;
}

export function describe(ctx: SecretContext, source: string): string {
  return `${ctx.purpose ?? 'token secret'} for host "${ctx.host}" (source ${source})`;
}

export function secretError(ctx: SecretContext, source: string, reason: string): SecretError {
  return new SecretError(`Cannot resolve ${describe(ctx, source)}: ${reason}`);
}

export function envOf(ctx: SecretContext): NodeJS.ProcessEnv {
  return ctx.env ?? process.env;
}
