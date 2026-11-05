import type { HostSettings, TlsSettings } from '../config/types.js';
import type { SecretRef } from '../secrets/types.js';
import { KEYRING_SERVICE } from '../secrets/providers/keyring.js';

/** Short, value free description of where a secret lives. */
export function describeSecretRef(ref: SecretRef, alias?: string): string {
  switch (ref.source) {
    case 'env':
      return `env ${ref.name}`;
    case 'file':
      return `file ${ref.path}`;
    case 'keyring': {
      const service = ref.service ?? KEYRING_SERVICE;
      const account = ref.account ?? alias ?? '(host alias)';
      return service === KEYRING_SERVICE && account === alias
        ? 'keyring'
        : `keyring ${service}/${account}`;
    }
    case 'bws':
      return `bws ${ref.secretId}`;
    case '1password':
      return `1password ${ref.ref}`;
    case 'vault':
      return `${ref.binary === 'bao' ? 'openbao' : 'vault'} ${ref.mount ? `${ref.mount}/` : ''}${ref.path}#${ref.field}`;
    case 'pass':
      return `pass ${ref.name}`;
    case 'command':
      return `command ${ref.command[0] ?? ''}`;
    default:
      return 'unknown';
  }
}

export type TlsModeName = 'system' | 'ca-file' | 'pinned' | 'pinned+ca' | 'off';

export function tlsMode(tls: TlsSettings): TlsModeName {
  if (!tls.verify) return 'off';
  if (tls.fingerprint !== undefined) return tls.caFile !== undefined ? 'pinned+ca' : 'pinned';
  if (tls.caFile !== undefined) return 'ca-file';
  return 'system';
}

export function describeTls(tls: TlsSettings): string {
  switch (tlsMode(tls)) {
    case 'off':
      return 'verification OFF';
    case 'pinned':
      return 'pinned fingerprint';
    case 'pinned+ca':
      return 'CA file and pinned fingerprint';
    case 'ca-file':
      return `CA file ${tls.caFile}`;
    default:
      return 'system CAs';
  }
}

export function describeHost(alias: string, host: HostSettings): string[] {
  return [
    `URL: ${host.url}`,
    `Token ID: ${host.tokenId}`,
    `Secret: ${describeSecretRef(host.tokenSecret, alias)}`,
    `TLS: ${describeTls(host.tls)}`,
    `Read-only: ${host.readOnly ? 'yes' : 'no'}`,
    ...(host.description !== undefined ? [`Description: ${host.description}`] : []),
  ];
}
