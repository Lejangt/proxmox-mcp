import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { settingsSchema } from '../src/config/schema.js';
import { ConfigError, ReadOnlyError, SecretError } from '../src/proxmox/errors.js';
import { createHostRegistry } from '../src/proxmox/hosts.js';
import { createTestPki, type TestPki } from './helpers/certs.js';
import { json, startServer, type TestServer } from './helpers/server.js';

let pki: TestPki;
let server: TestServer;

beforeAll(async () => {
  pki = createTestPki();
  server = await startServer(pki.selfSigned, (req, res) =>
    json(res, 200, { data: { auth: req.headers.authorization } }),
  );
});
afterAll(async () => {
  await server.close();
  pki.cleanup();
});

function settings(extra: Record<string, unknown> = {}) {
  const tls = { fingerprint: pki.selfSigned.fingerprint256 };
  return settingsSchema.parse({
    version: 1,
    defaultHost: 'lab',
    hosts: {
      lab: {
        url: server.url,
        tokenId: 'mcp@pve!agent',
        tokenSecret: { source: 'env', name: 'LAB_SECRET' },
        tls,
      },
      broken: {
        url: server.url,
        tokenId: 'mcp@pve!agent',
        tokenSecret: { source: 'env', name: 'MISSING' },
        tls,
      },
      ro: {
        description: 'read only',
        url: server.url,
        tokenId: 'mcp@pve!agent',
        tokenSecret: { source: 'env', name: 'LAB_SECRET' },
        tls,
        readOnly: true,
      },
    },
    ...extra,
  });
}

describe('createHostRegistry', () => {
  it('lists hosts with effective read-only flags and the default', () => {
    const registry = createHostRegistry(settings(), { env: {}, log: () => undefined });
    expect(registry.aliases()).toEqual(['lab', 'broken', 'ro']);
    expect(registry.defaultAlias()).toBe('lab');
    expect(registry.list()).toEqual([
      { alias: 'lab', url: server.url, readOnly: false, isDefault: true },
      { alias: 'broken', url: server.url, readOnly: false, isDefault: false },
      { alias: 'ro', description: 'read only', url: server.url, readOnly: true, isDefault: false },
    ]);
    const global = createHostRegistry(settings({ readOnly: true }), {
      env: {},
      log: () => undefined,
    });
    expect(global.list().every((h) => h.readOnly)).toBe(true);
  });

  it('resolves secrets lazily and isolates broken hosts', async () => {
    const registry = createHostRegistry(settings(), {
      env: { LAB_SECRET: 'lab-secret-1' },
      log: () => undefined,
    });
    const broken = await registry.client('broken');
    const err = await broken.get('/version').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SecretError);
    expect(String(err)).toMatch(/host "broken"/);
    const lab = await registry.client();
    await expect(lab.get('/version')).resolves.toEqual({
      auth: 'PVEAPIToken=mcp@pve!agent=lab-secret-1',
    });
    registry.close();
  });

  it('enforces read-only per host and globally', async () => {
    const registry = createHostRegistry(settings(), {
      env: { LAB_SECRET: 'x-secret' },
      log: () => undefined,
    });
    const ro = await registry.client('ro');
    expect(ro.readOnly).toBe(true);
    await expect(ro.post('/nodes/pve/qemu/100/status/start')).rejects.toBeInstanceOf(ReadOnlyError);
    const global = createHostRegistry(settings({ readOnly: true }), {
      env: {},
      log: () => undefined,
    });
    await expect((await global.client('lab')).delete('/nodes/pve/qemu/100')).rejects.toBeInstanceOf(
      ReadOnlyError,
    );
    registry.close();
  });

  it('names known aliases for unknown hosts and missing defaults', async () => {
    const registry = createHostRegistry(settings(), { env: {}, log: () => undefined });
    await expect(registry.client('nope')).rejects.toThrow(/Known hosts: lab, broken, ro/);
    const noDefault = createHostRegistry(
      settingsSchema.parse({ ...settings(), defaultHost: undefined }),
      {
        env: {},
        log: () => undefined,
      },
    );
    expect(noDefault.defaultAlias()).toBeUndefined();
    await expect(noDefault.client()).rejects.toBeInstanceOf(ConfigError);
    const empty = createHostRegistry(settingsSchema.parse({ version: 1 }), {
      log: () => undefined,
    });
    await expect(empty.client()).rejects.toThrow(/setup/);
  });

  it('uses the only host as default and warns about disabled TLS verification', () => {
    const logs: string[] = [];
    const single = settingsSchema.parse({
      version: 1,
      hosts: {
        only: {
          url: server.url,
          tokenId: 'a@pve!b',
          tokenSecret: { source: 'env', name: 'X' },
          tls: { verify: false },
        },
      },
    });
    const registry = createHostRegistry(single, { log: (m) => logs.push(m) });
    expect(registry.defaultAlias()).toBe('only');
    expect(logs.join('\n')).toMatch(/host "only" has TLS verification disabled/);
  });
});
