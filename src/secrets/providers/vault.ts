import type { SecretRef } from '../types.js';
import { runSecretCommand } from '../run-command.js';
import type { NestedResolver } from './bws.js';
import { describe, envOf, secretError, type SecretContext } from './shared.js';

/*
 * TLS and token settings of the user's own Vault or OpenBao setup. OpenBao
 * reads BAO_* first and falls back to VAULT_*. VAULT_SKIP_VERIFY and
 * BAO_SKIP_VERIFY are deliberately not passed on.
 */
const VAULT_ENV = [
  'ADDR',
  'TOKEN',
  'NAMESPACE',
  'CACERT',
  'CAPATH',
  'CLIENT_CERT',
  'CLIENT_KEY',
  'TLS_SERVER_NAME',
  'CONFIG_PATH',
].flatMap((name) => [`VAULT_${name}`, `BAO_${name}`]);

/**
 * `vault kv get [-mount=<mount>] -field=<field> <path>` (or `bao`). Address,
 * token and namespace go through the environment, never through argv.
 */
export async function resolveVaultSecret(
  ref: {
    path: string;
    field: string;
    mount?: string;
    address?: string;
    token?: SecretRef;
    namespace?: string;
    binary?: string;
  },
  ctx: SecretContext,
  resolveNested: NestedResolver,
): Promise<string> {
  const childEnv: Record<string, string> = {};
  if (ref.token) {
    if (ref.token.source === 'bws' || ref.token.source === 'vault') {
      throw secretError(ctx, 'vault', 'token must not use source bws or vault');
    }
    const token = await resolveNested(ref.token, {
      ...ctx,
      purpose: `vault token of the ${ctx.purpose ?? 'token secret'}`,
    });
    childEnv.VAULT_TOKEN = token;
    childEnv.BAO_TOKEN = token;
  }
  if (ref.address !== undefined) {
    childEnv.VAULT_ADDR = ref.address;
    childEnv.BAO_ADDR = ref.address;
  }
  if (ref.namespace !== undefined) {
    childEnv.VAULT_NAMESPACE = ref.namespace;
    childEnv.BAO_NAMESPACE = ref.namespace;
  }
  const argv = [ref.binary ?? 'vault', 'kv', 'get'];
  if (ref.mount !== undefined) argv.push(`-mount=${ref.mount}`);
  argv.push(`-field=${ref.field}`, ref.path);
  return runSecretCommand({
    argv,
    label: describe(ctx, 'vault'),
    env: childEnv,
    passEnv: VAULT_ENV,
    parentEnv: envOf(ctx),
    ...(ctx.timeoutMs !== undefined ? { timeoutMs: ctx.timeoutMs } : {}),
  });
}
