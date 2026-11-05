import { runSecretCommand } from '../run-command.js';
import { describe, envOf, type SecretContext } from './shared.js';

/** Runs a user supplied argv (never through a shell) and uses its trimmed stdout. */
export function resolveCommandSecret(
  ref: { command: string[]; timeoutSeconds?: number },
  ctx: SecretContext,
): Promise<string> {
  const timeoutMs = ref.timeoutSeconds !== undefined ? ref.timeoutSeconds * 1000 : ctx.timeoutMs;
  return runSecretCommand({
    argv: ref.command,
    label: describe(ctx, 'command'),
    parentEnv: envOf(ctx),
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
  });
}
