export type SecretRef =
  | { source: 'env'; name: string }
  | { source: 'file'; path: string }
  | { source: 'keyring'; service?: string; account?: string }
  | {
      source: 'bws';
      secretId: string;
      accessToken?: SecretRef;
      serverUrl?: string;
      binary?: string;
    }
  | { source: '1password'; ref: string; account?: string; binary?: string }
  | {
      source: 'vault';
      path: string;
      field: string;
      mount?: string;
      address?: string;
      token?: SecretRef;
      namespace?: string;
      binary?: string;
    }
  | { source: 'pass'; name: string; binary?: string }
  | { source: 'command'; command: string[]; timeoutSeconds?: number };
