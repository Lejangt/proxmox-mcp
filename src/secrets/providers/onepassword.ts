import { runSecretCommand } from '../run-command.js';
import { describe, envOf, type SecretContext } from './shared.js';

/*
 * Service account and Connect tokens, session tokens of `op signin` and what
 * the desktop app integration needs to reach the app.
 */
const OP_ENV = [
  'OP_SERVICE_ACCOUNT_TOKEN',
  'OP_CONNECT_HOST',
  'OP_CONNECT_TOKEN',
  'OP_ACCOUNT',
  'OP_CONFIG_DIR',
  'OP_BIOMETRIC_UNLOCK_ENABLED',
  'DBUS_SESSION_BUS_ADDRESS',
  'DISPLAY',
  'WAYLAND_DISPLAY',
];

/** `op [--account <account>] read --no-newline <op://...>` */
export function resolveOnePasswordSecret(
  ref: { ref: string; account?: string; binary?: string },
  ctx: SecretContext,
): Promise<string> {
  const argv = [ref.binary ?? 'op'];
  if (ref.account !== undefined) argv.push('--account', ref.account);
  argv.push('read', '--no-newline', ref.ref);
  return runSecretCommand({
    argv,
    label: describe(ctx, '1password'),
    passEnv: OP_ENV,
    passEnvPrefixes: ['OP_SESSION_'],
    parentEnv: envOf(ctx),
    ...(ctx.timeoutMs !== undefined ? { timeoutMs: ctx.timeoutMs } : {}),
  });
}
