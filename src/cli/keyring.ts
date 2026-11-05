import {
  deleteKeyringSecret,
  KEYRING_SERVICE,
  loadKeyring,
  storeKeyringSecret,
} from '../secrets/providers/keyring.js';

/** Keychain access used by the CLI. Replaced by a fake in tests. */
export interface KeyringOps {
  /**
   * True when the optional binding loads and a read of a probe entry works,
   * which also proves that a keychain service (Secret Service, Keychain,
   * Credential Manager) answers. Nothing is written by the probe.
   */
  available(): Promise<boolean>;
  set(service: string, account: string, value: string): Promise<void>;
  /** Returns false when there was no entry. */
  delete(service: string, account: string): Promise<boolean>;
}

const PROBE_ACCOUNT = '__proxmox-ve-mcp-probe__';

export const systemKeyring: KeyringOps = {
  async available() {
    try {
      const mod = await loadKeyring();
      await new mod.AsyncEntry(KEYRING_SERVICE, PROBE_ACCOUNT).getPassword();
      return true;
    } catch {
      return false;
    }
  },
  set: (service, account, value) => storeKeyringSecret({ service, account }, account, value),
  delete: (service, account) => deleteKeyringSecret({ service, account }, account),
};

export { KEYRING_SERVICE };
