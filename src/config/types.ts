import type { SecretRef } from '../secrets/types.js';

export type ConfirmMode = 'auto' | 'always' | 'never';

export interface TlsSettings {
  verify: boolean;
  caFile?: string;
  fingerprint?: string;
}

export interface HostSettings {
  description?: string;
  url: string;
  tokenId: string;
  tokenSecret: SecretRef;
  tls: TlsSettings;
  readOnly: boolean;
  timeoutSeconds: number;
}

export interface CategorySettings {
  enabled: boolean;
  tools: Record<string, boolean>;
}

export interface Settings {
  version: 1;
  readOnly: boolean;
  confirmDestructive: ConfirmMode;
  defaultHost?: string;
  hosts: Record<string, HostSettings>;
  limits: { maxOutputChars: number; taskWaitSeconds: number };
  categories: Record<string, CategorySettings>;
}
