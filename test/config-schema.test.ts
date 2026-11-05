import { describe, expect, it } from 'vitest';
import { normalizeFingerprint, settingsJsonSchema, settingsSchema } from '../src/config/schema.js';

const FP = 'ab'.repeat(32);

function base(host: Record<string, unknown> = {}) {
  return {
    version: 1,
    hosts: {
      lab: {
        url: 'https://pve.example.com:8006',
        tokenId: 'mcp@pve!agent',
        tokenSecret: { source: 'keyring' },
        ...host,
      },
    },
  };
}

describe('settings schema', () => {
  it('fills defaults', () => {
    const s = settingsSchema.parse(base());
    expect(s.readOnly).toBe(false);
    expect(s.confirmDestructive).toBe('auto');
    expect(s.limits).toEqual({ maxOutputChars: 60000, taskWaitSeconds: 600 });
    expect(s.categories).toEqual({});
    expect(s.hosts.lab).toMatchObject({
      readOnly: false,
      timeoutSeconds: 30,
      tls: { verify: true },
    });
  });

  it('rejects unknown keys everywhere', () => {
    expect(settingsSchema.safeParse({ ...base(), readonly: true }).success).toBe(false);
    expect(settingsSchema.safeParse(base({ readonly: true })).success).toBe(false);
    expect(settingsSchema.safeParse(base({ tls: { verfiy: false } })).success).toBe(false);
    expect(
      settingsSchema.safeParse(base({ tokenSecret: { source: 'keyring', acount: 'x' } })).success,
    ).toBe(false);
    expect(settingsSchema.safeParse({ ...base(), limits: { maxOutputChar: 10 } }).success).toBe(
      false,
    );
    expect(
      settingsSchema.safeParse({ ...base(), categories: { guests: { enable: false } } }).success,
    ).toBe(false);
    expect(settingsSchema.safeParse({ ...base(), categories: { gusts: {} } }).success).toBe(false);
  });

  it('requires version 1', () => {
    expect(settingsSchema.safeParse({ ...base(), version: 2 }).success).toBe(false);
  });

  it('only accepts https URLs without path or credentials and normalizes them', () => {
    expect(settingsSchema.safeParse(base({ url: 'http://pve.example.com:8006' })).success).toBe(
      false,
    );
    expect(settingsSchema.safeParse(base({ url: 'https://u:p@pve.example.com' })).success).toBe(
      false,
    );
    expect(
      settingsSchema.safeParse(base({ url: 'https://pve.example.com/api2/json' })).success,
    ).toBe(false);
    expect(settingsSchema.safeParse(base({ url: 'https://pve.example.com?x=1' })).success).toBe(
      false,
    );
    expect(
      settingsSchema.parse(base({ url: 'https://PVE.example.com:8006/' })).hosts.lab!.url,
    ).toBe('https://pve.example.com:8006');
  });

  it('validates the token id format', () => {
    for (const bad of ['mcp@pve', 'mcp!agent', 'mcp@pve!', 'm=c@pve!a', 'mcp@pve!a b', '@pve!a']) {
      expect(settingsSchema.safeParse(base({ tokenId: bad })).success, bad).toBe(false);
    }
    expect(settingsSchema.safeParse(base({ tokenId: 'root@pam!mcp-1' })).success).toBe(true);
  });

  it('normalizes fingerprints with and without colons', () => {
    const upper = normalizeFingerprint(FP)!;
    expect(upper).toMatch(/^(AB:){31}AB$/);
    expect(
      settingsSchema.parse(base({ tls: { fingerprint: upper.toLowerCase() } })).hosts.lab!.tls
        .fingerprint,
    ).toBe(upper);
    expect(
      settingsSchema.parse(base({ tls: { fingerprint: FP } })).hosts.lab!.tls.fingerprint,
    ).toBe(upper);
    expect(settingsSchema.safeParse(base({ tls: { fingerprint: 'AB:CD' } })).success).toBe(false);
    expect(normalizeFingerprint('zz'.repeat(32))).toBeUndefined();
  });

  it('rejects verify false combined with pinning or a CA', () => {
    expect(
      settingsSchema.safeParse(base({ tls: { verify: false, fingerprint: FP } })).success,
    ).toBe(false);
    expect(
      settingsSchema.safeParse(base({ tls: { verify: false, caFile: '/x.pem' } })).success,
    ).toBe(false);
    expect(settingsSchema.safeParse(base({ tls: { verify: false } })).success).toBe(true);
  });

  it('validates host aliases and defaultHost', () => {
    const s = base();
    expect(settingsSchema.safeParse({ ...s, hosts: { Lab: s.hosts.lab } }).success).toBe(false);
    expect(settingsSchema.safeParse({ ...s, hosts: { '-lab': s.hosts.lab } }).success).toBe(false);
    expect(
      settingsSchema.safeParse({ ...s, hosts: { ['a'.repeat(33)]: s.hosts.lab } }).success,
    ).toBe(false);
    expect(settingsSchema.safeParse({ ...s, defaultHost: 'office' }).success).toBe(false);
    expect(settingsSchema.safeParse({ ...s, defaultHost: 'lab' }).success).toBe(true);
  });

  it('accepts every secret source and validates them', () => {
    const ok = [
      { source: 'env', name: 'PVE_SECRET' },
      { source: 'file', path: '~/secret' },
      { source: 'keyring', service: 's', account: 'a' },
      {
        source: 'bws',
        secretId: '00000000-0000-0000-0000-000000000000',
        serverUrl: 'https://vault.bitwarden.eu',
        accessToken: { source: 'keyring', account: 'bws' },
      },
      { source: '1password', ref: 'op://vault/item/field', account: 'my' },
      {
        source: 'vault',
        path: 'pve/token',
        field: 'secret',
        mount: 'kv',
        address: 'http://127.0.0.1:8200',
        token: { source: 'env', name: 'VT' },
      },
      { source: 'pass', name: 'pve/token' },
      { source: 'command', command: ['/usr/bin/printf', 'x'], timeoutSeconds: 5 },
    ];
    for (const ref of ok) {
      expect(settingsSchema.safeParse(base({ tokenSecret: ref })).success, ref.source).toBe(true);
    }
    const bad = [
      { source: 'plain', value: 'x' },
      { source: 'env', name: 'A-B' },
      { source: 'bws', secretId: 'not-a-uuid' },
      {
        source: 'bws',
        secretId: '00000000-0000-0000-0000-000000000000',
        serverUrl: 'http://vault.bitwarden.eu',
      },
      // nested bws or vault is recursion
      {
        source: 'bws',
        secretId: '00000000-0000-0000-0000-000000000000',
        accessToken: { source: 'bws', secretId: '00000000-0000-0000-0000-000000000000' },
      },
      { source: 'vault', path: 'p', field: 'f', token: { source: 'vault', path: 'p', field: 'f' } },
      // nested keyring needs an account
      {
        source: 'bws',
        secretId: '00000000-0000-0000-0000-000000000000',
        accessToken: { source: 'keyring' },
      },
      { source: '1password', ref: 'vault/item' },
      { source: 'vault', path: '-field=x', field: 'f' },
      { source: 'vault', path: 'p', field: 'f', address: 'http://192.0.2.1:8200' },
      { source: 'pass', name: '--help' },
      { source: 'pass', name: '../x' },
      { source: 'command', command: [] },
      { source: 'command', command: [''] },
      { source: 'env', name: 'X', extra: 1 },
    ];
    for (const ref of bad) {
      expect(
        settingsSchema.safeParse(base({ tokenSecret: ref })).success,
        JSON.stringify(ref),
      ).toBe(false);
    }
  });

  it('validates tool names and limits', () => {
    expect(
      settingsSchema.safeParse({
        ...base(),
        categories: { guests: { tools: { 'Bad Name': true } } },
      }).success,
    ).toBe(false);
    expect(settingsSchema.safeParse({ ...base(), limits: { maxOutputChars: 1 } }).success).toBe(
      false,
    );
  });
});

describe('settingsJsonSchema', () => {
  it('produces a JSON schema with categories and catalog tools', () => {
    const schema = settingsJsonSchema([
      { name: 'pve_guest_list', category: 'guests', access: 'read', title: 'List guests' },
    ]) as {
      properties: {
        categories: {
          properties: Record<string, { properties: { tools: { properties: object } } }>;
          additionalProperties: boolean;
        };
      };
      additionalProperties: boolean;
    };
    expect(schema.additionalProperties).toBe(false);
    expect(Object.keys(schema.properties.categories.properties)).toHaveLength(14);
    expect(schema.properties.categories.additionalProperties).toBe(false);
    expect(
      schema.properties.categories.properties.guests!.properties.tools.properties,
    ).toHaveProperty('pve_guest_list');
    expect(() => JSON.stringify(schema)).not.toThrow();
  });
});
