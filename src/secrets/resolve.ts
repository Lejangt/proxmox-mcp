import { registerSecret, SecretError } from '../proxmox/errors.js';
import { resolveBwsSecret } from './providers/bws.js';
import { resolveCommandSecret } from './providers/command.js';
import { resolveEnvSecret } from './providers/env.js';
import { resolveFileSecret } from './providers/file.js';
import { resolveKeyringSecret } from './providers/keyring.js';
import { resolveOnePasswordSecret } from './providers/onepassword.js';
import { resolvePassSecret } from './providers/pass.js';
import type { SecretContext } from './providers/shared.js';
import { resolveVaultSecret } from './providers/vault.js';
import type { SecretRef } from './types.js';

export type { SecretContext } from './providers/shared.js';

/*
 * Nested refs (bws.accessToken, vault.token) are resolved with a resolver
 * that rejects bws and vault, so there is no recursion even when a ref was
 * built in code without the schema.
 */
function resolveNested(ref: SecretRef, ctx: SecretContext): Promise<string> {
  if (ref.source === 'bws' || ref.source === 'vault') {
    return Promise.reject(
      new SecretError(
        `Cannot resolve ${ctx.purpose ?? 'secret'} for host "${ctx.host}": nested source ${ref.source} is not allowed`,
      ),
    );
  }
  if (ref.source === 'keyring' && ref.account === undefined) {
    return Promise.reject(
      new SecretError(
        `Cannot resolve ${ctx.purpose ?? 'secret'} for host "${ctx.host}": a nested keyring reference needs an account`,
      ),
    );
  }
  return resolveAny(ref, ctx);
}

async function resolveAny(ref: SecretRef, ctx: SecretContext): Promise<string> {
  let value: string;
  switch (ref.source) {
    case 'env':
      value = await resolveEnvSecret(ref, ctx);
      break;
    case 'file':
      value = await resolveFileSecret(ref, ctx);
      break;
    case 'keyring':
      value = await resolveKeyringSecret(ref, ctx);
      break;
    case 'bws':
      value = await resolveBwsSecret(ref, ctx, resolveNested);
      break;
    case '1password':
      value = await resolveOnePasswordSecret(ref, ctx);
      break;
    case 'vault':
      value = await resolveVaultSecret(ref, ctx, resolveNested);
      break;
    case 'pass':
      value = await resolvePassSecret(ref, ctx);
      break;
    case 'command':
      value = await resolveCommandSecret(ref, ctx);
      break;
    default: {
      const source = (ref as { source?: unknown }).source;
      throw new SecretError(
        `Cannot resolve secret for host "${ctx.host}": unknown source ${JSON.stringify(String(source)).slice(0, 40)}`,
      );
    }
  }
  // Registered so that any later output can be scrubbed of it.
  registerSecret(value);
  return value;
}

/**
 * Resolves a secret reference. Errors are SecretError and name the source and
 * host, never the value.
 */
export function resolveSecret(ref: SecretRef, ctx: SecretContext): Promise<string> {
  return resolveAny(ref, ctx);
}
