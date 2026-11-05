import type { SecretRef } from '../types.js';
import { runSecretCommand } from '../run-command.js';
import { describe, envOf, secretError, type SecretContext } from './shared.js';

export type NestedResolver = (ref: SecretRef, ctx: SecretContext) => Promise<string>;

/* Profile and config file selection of the user, never the access token itself. */
const BWS_ENV = [
  'BWS_CONFIG_FILE',
  'BWS_PROFILE',
  'BWS_SERVER_URL',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
];

/**
 * `bws secret get <id> --output json`. The access token goes to the child
 * only through BWS_ACCESS_TOKEN in its environment, never as an argument,
 * because argv is visible to other users in the process list.
 */
export async function resolveBwsSecret(
  ref: { secretId: string; accessToken?: SecretRef; serverUrl?: string; binary?: string },
  ctx: SecretContext,
  resolveNested: NestedResolver,
): Promise<string> {
  const env = envOf(ctx);
  let accessToken: string | undefined;
  if (ref.accessToken) {
    if (ref.accessToken.source === 'bws') {
      throw secretError(ctx, 'bws', 'accessToken must not use source bws');
    }
    accessToken = await resolveNested(ref.accessToken, {
      ...ctx,
      purpose: `bws access token of the ${ctx.purpose ?? 'token secret'}`,
    });
  } else {
    accessToken = env.BWS_ACCESS_TOKEN?.trim() || undefined;
  }
  if (!accessToken) {
    throw secretError(
      ctx,
      'bws',
      'no access token: set BWS_ACCESS_TOKEN or configure tokenSecret.accessToken',
    );
  }
  const childEnv: Record<string, string> = { BWS_ACCESS_TOKEN: accessToken };
  if (ref.serverUrl !== undefined) childEnv.BWS_SERVER_URL = ref.serverUrl;

  const output = await runSecretCommand({
    argv: [ref.binary ?? 'bws', 'secret', 'get', ref.secretId, '--output', 'json', '--color', 'no'],
    label: describe(ctx, 'bws'),
    env: childEnv,
    passEnv: BWS_ENV,
    parentEnv: env,
    ...(ctx.timeoutMs !== undefined ? { timeoutMs: ctx.timeoutMs } : {}),
  });
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch {
    throw secretError(ctx, 'bws', 'bws did not print JSON');
  }
  const value = (parsed as { value?: unknown } | null)?.value;
  if (typeof value !== 'string' || value.trim() === '') {
    throw secretError(ctx, 'bws', 'the secret has no value');
  }
  return value.trim();
}
