import { secretError, type SecretContext } from './shared.js';

export const KEYRING_SERVICE = 'proxmox-ve-mcp';

interface AsyncEntryLike {
  getPassword(): Promise<string | null>;
  setPassword(password: string): Promise<void>;
  deletePassword(): Promise<boolean>;
}
interface KeyringModule {
  AsyncEntry: new (service: string, account: string) => AsyncEntryLike;
}

/* A variable specifier keeps bundlers and tsc from requiring the optional package. */
const KEYRING_PACKAGE = '@napi-rs/keyring';
let modulePromise: Promise<KeyringModule> | undefined;

export class KeyringUnavailableError extends Error {
  override name = 'KeyringUnavailableError';
}

/** Loads the optional keychain binding, or throws KeyringUnavailableError. */
export function loadKeyring(): Promise<KeyringModule> {
  modulePromise ??= (import(KEYRING_PACKAGE) as Promise<KeyringModule>).then(
    (mod) => {
      if (typeof mod.AsyncEntry !== 'function') throw new Error('unexpected module shape');
      return mod;
    },
    () => {
      modulePromise = undefined;
      throw new KeyringUnavailableError(
        'the OS keychain is not available: the optional package @napi-rs/keyring is not installed ' +
          'or has no build for this platform. Use another secret source (file, env, a password manager).',
      );
    },
  );
  return modulePromise;
}

export interface KeyringTarget {
  service?: string;
  account?: string;
}

function target(ref: KeyringTarget, host: string): { service: string; account: string } {
  return { service: ref.service ?? KEYRING_SERVICE, account: ref.account ?? host };
}

export async function resolveKeyringSecret(
  ref: KeyringTarget,
  ctx: SecretContext,
): Promise<string> {
  const { service, account } = target(ref, ctx.host);
  let mod: KeyringModule;
  try {
    mod = await loadKeyring();
  } catch (err) {
    throw secretError(ctx, 'keyring', (err as Error).message);
  }
  let value: string | null;
  try {
    value = await new mod.AsyncEntry(service, account).getPassword();
  } catch {
    throw secretError(
      ctx,
      'keyring',
      `the keychain could not be read for service "${service}", account "${account}" (is a keychain or Secret Service running?)`,
    );
  }
  const trimmed = value?.trim();
  if (!trimmed) {
    throw secretError(
      ctx,
      'keyring',
      `no entry for service "${service}", account "${account}". Store it with: proxmox-ve-mcp secret set ${ctx.host}`,
    );
  }
  return trimmed;
}

/** Stores a secret in the OS keychain (used by `proxmox-ve-mcp secret set`). */
export async function storeKeyringSecret(
  ref: KeyringTarget,
  host: string,
  value: string,
): Promise<void> {
  const { service, account } = target(ref, host);
  const mod = await loadKeyring();
  await new mod.AsyncEntry(service, account).setPassword(value);
}

/** Removes a keychain entry. Returns false when there was none. */
export async function deleteKeyringSecret(ref: KeyringTarget, host: string): Promise<boolean> {
  const { service, account } = target(ref, host);
  const mod = await loadKeyring();
  return new mod.AsyncEntry(service, account).deletePassword();
}
