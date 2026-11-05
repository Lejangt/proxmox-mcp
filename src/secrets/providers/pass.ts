import { runSecretCommand } from '../run-command.js';
import { describe, envOf, secretError, type SecretContext } from './shared.js';

/* pass needs its store location and gpg-agent to decrypt. */
const PASS_ENV = [
  'PASSWORD_STORE_DIR',
  'PASSWORD_STORE_GPG_OPTS',
  'GNUPGHOME',
  'GPG_AGENT_INFO',
  'GPG_TTY',
  'DISPLAY',
  'WAYLAND_DISPLAY',
  'DBUS_SESSION_BUS_ADDRESS',
];

/** `pass show <name>`, the password is the first line. */
export async function resolvePassSecret(
  ref: { name: string; binary?: string },
  ctx: SecretContext,
): Promise<string> {
  const output = await runSecretCommand({
    argv: [ref.binary ?? 'pass', 'show', ref.name],
    label: describe(ctx, 'pass'),
    passEnv: PASS_ENV,
    parentEnv: envOf(ctx),
    ...(ctx.timeoutMs !== undefined ? { timeoutMs: ctx.timeoutMs } : {}),
  });
  const first = output.split(/\r?\n/, 1)[0]!.trim();
  if (!first) throw secretError(ctx, 'pass', 'the first line of the entry is empty');
  return first;
}
