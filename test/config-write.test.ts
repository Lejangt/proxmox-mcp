import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseSettingsText } from '../src/config/load.js';
import { type CatalogEntry, settingsSchema } from '../src/config/schema.js';
import {
  removeHostFromDocument,
  renderSettingsDocument,
  SETTINGS_SCHEMA_URL,
  setDefaultHostInDocument,
  syncSettingsDocument,
  upsertHostInDocument,
  writeSettingsFile,
} from '../src/config/write.js';
import { ConfigError } from '../src/proxmox/errors.js';
import { CATEGORIES } from '../src/server/registry.js';

const catalog: CatalogEntry[] = [
  { name: 'pve_hosts_list', category: 'core', access: 'read', title: 'List configured hosts' },
  { name: 'pve_guest_list', category: 'guests', access: 'read', title: 'List guests' },
  { name: 'pve_guest_power', category: 'guests', access: 'write', title: 'Power actions' },
  { name: 'pve_guest_delete', category: 'guests', access: 'destructive', title: 'Delete a guest' },
];

const settings = settingsSchema.parse({
  version: 1,
  defaultHost: 'lab',
  hosts: {
    lab: {
      description: 'Lab cluster',
      url: 'https://pve.example.com:8006',
      tokenId: 'mcp@pve!agent',
      tokenSecret: { source: 'keyring' },
      tls: { fingerprint: 'ab'.repeat(32) },
    },
  },
  categories: { guests: { enabled: true, tools: { pve_guest_delete: false } } },
});

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'pve-mcp-write-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('renderSettingsDocument', () => {
  const text = renderSettingsDocument(settings, catalog);

  it('starts with the schema comment and round-trips through the loader', () => {
    expect(text.startsWith(`# yaml-language-server: $schema=${SETTINGS_SCHEMA_URL}`)).toBe(true);
    const parsed = parseSettingsText(text);
    expect(parsed.hosts).toEqual(settings.hosts);
    expect(parsed.categories.guests!.tools).toEqual({
      pve_guest_list: true,
      pve_guest_power: true,
      pve_guest_delete: false,
    });
  });

  it('lists every category and every tool with access and title', () => {
    for (const category of CATEGORIES) {
      expect(text).toContain(`  ${category.id}:\n    enabled: true`);
    }
    expect(text).toContain('pve_guest_list: true # [R] List guests');
    expect(text).toContain('pve_guest_power: true # [W] Power actions');
    expect(text).toContain('pve_guest_delete: false # [D] Delete a guest');
    expect(text).toMatch(/readOnly: false # /);
    expect(text).toMatch(/confirmDestructive: auto # /);
  });

  it('is plain ASCII', () => {
    expect([...text].every((c) => c === '\n' || (c >= ' ' && c <= '~'))).toBe(true);
  });
});

describe('syncSettingsDocument', () => {
  it('adds new tools and categories without touching values or comments', () => {
    const original = renderSettingsDocument(settings, catalog.slice(0, 2))
      .replace('pve_guest_list: true # [R] List guests', 'pve_guest_list: false # my own note')
      .replace(/\n {2}# Raw API:[^\n]*\n {2}api:\n {4}enabled: true\n {4}tools: \{\}\n/, '\n');
    expect(original).not.toContain('  api:');
    const { text, added } = syncSettingsDocument(original, catalog);
    // pve_guest_delete was already listed (false) because the settings named it.
    expect(added).toEqual(['guests.pve_guest_power', 'api']);
    expect(text).toContain('pve_guest_delete: false');
    expect(text).toContain('pve_guest_list: false # my own note');
    expect(text).toContain('pve_guest_power: true # [W] Power actions');
    expect(text).toContain('  api:');
    expect(text.startsWith('# yaml-language-server')).toBe(true);
    // Running it again changes nothing.
    expect(syncSettingsDocument(text, catalog)).toEqual({ text, added: [] });
    expect(parseSettingsText(text).categories.guests!.tools.pve_guest_list).toBe(false);
  });

  it('creates categories in a minimal file', () => {
    const { text } = syncSettingsDocument('version: 1 # keep me\nhosts: {}\n', catalog);
    expect(text).toContain('version: 1 # keep me');
    expect(parseSettingsText(text).categories.core!.tools.pve_hosts_list).toBe(true);
  });

  it('rejects invalid YAML', () => {
    expect(() => syncSettingsDocument('a: [', catalog)).toThrow(ConfigError);
  });
});

describe('host editing', () => {
  const text = renderSettingsDocument(settings, catalog).replace(
    'url: https://pve.example.com:8006',
    'url: https://pve.example.com:8006 # main node',
  );

  it('adds a host', () => {
    const out = upsertHostInDocument(text, 'office', {
      url: 'https://192.0.2.5:8006',
      tokenId: 'automation@pve!mcp',
      tokenSecret: { source: 'bws', secretId: '00000000-0000-0000-0000-000000000000' },
      readOnly: true,
    });
    const parsed = parseSettingsText(out);
    expect(parsed.hosts.office).toMatchObject({ readOnly: true, tls: { verify: true } });
    expect(parsed.hosts.lab).toEqual(settings.hosts.lab);
  });

  it('edits a host and keeps comments on unchanged keys', () => {
    const out = upsertHostInDocument(text, 'lab', {
      url: 'https://pve.example.com:8006',
      tokenId: 'other@pve!agent',
      tokenSecret: { source: 'file', path: '~/pve.secret' },
    });
    expect(out).toContain('url: https://pve.example.com:8006 # main node');
    const host = parseSettingsText(out).hosts.lab!;
    expect(host.tokenId).toBe('other@pve!agent');
    expect(host.tokenSecret).toEqual({ source: 'file', path: '~/pve.secret' });
    expect(host.description).toBeUndefined();
    expect(host.tls.fingerprint).toBeUndefined();
  });

  it('validates hosts before writing', () => {
    expect(() =>
      upsertHostInDocument(text, 'x', {
        url: 'http://a',
        tokenId: 'x',
        tokenSecret: { source: 'keyring' },
      }),
    ).toThrow(ConfigError);
  });

  it('removes a host and its defaultHost entry', () => {
    const out = removeHostFromDocument(text, 'lab');
    const parsed = parseSettingsText(out);
    expect(parsed.hosts).toEqual({});
    expect(parsed.defaultHost).toBeUndefined();
    expect(() => removeHostFromDocument(text, 'missing')).toThrow(ConfigError);
  });

  it('sets the default host only to existing hosts', () => {
    expect(() => setDefaultHostInDocument(text, 'missing')).toThrow(ConfigError);
    expect(
      parseSettingsText(setDefaultHostInDocument(text, undefined)).defaultHost,
    ).toBeUndefined();
  });
});

describe('writeSettingsFile', () => {
  it.skipIf(process.platform === 'win32')(
    'writes atomically with 0600 and creates the directory with 0700',
    async () => {
      const file = path.join(dir, 'nested', 'proxmox-ve-mcp', 'config.yaml');
      await writeSettingsFile(file, 'version: 1\n');
      expect(readFileSync(file, 'utf8')).toBe('version: 1\n');
      expect(statSync(file).mode & 0o777).toBe(0o600);
      expect(statSync(path.dirname(file)).mode & 0o777).toBe(0o700);
      // Replacing a file with wider permissions results in 0600 again.
      writeFileSync(file, 'old', { mode: 0o644 });
      await writeSettingsFile(file, 'version: 1\n# new\n');
      expect(statSync(file).mode & 0o777).toBe(0o600);
      expect(readdirSync(path.dirname(file))).toEqual(['config.yaml']);
    },
  );
});
