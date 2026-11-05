import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { untrustedDirProblem, untrustedFileProblem } from '../src/config/file-trust.js';
import { loadSettings, parseSettingsText } from '../src/config/load.js';
import { defaultConfigPath, expandHome, resolveConfigPath } from '../src/config/paths.js';
import type { CatalogEntry } from '../src/config/schema.js';
import { ConfigError } from '../src/proxmox/errors.js';

const catalog: CatalogEntry[] = [
  { name: 'pve_guest_list', category: 'guests', access: 'read', title: 'List guests' },
  { name: 'pve_guest_delete', category: 'guests', access: 'destructive', title: 'Delete a guest' },
];

const YAML = `version: 1
readOnly: false
hosts:
  lab:
    url: https://pve.example.com:8006
    tokenId: mcp@pve!agent
    tokenSecret:
      source: keyring
categories:
  guests:
    enabled: true
    tools:
      pve_guest_delete: true
`;

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'pve-mcp-load-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function writeConfig(text: string, mode = 0o600): string {
  const file = path.join(dir, 'config.yaml');
  writeFileSync(file, text);
  chmodSync(file, mode);
  return file;
}

describe('config paths', () => {
  it('uses XDG_CONFIG_HOME, then ~/.config, and APPDATA on Windows', () => {
    expect(
      defaultConfigPath({ env: { XDG_CONFIG_HOME: '/x' }, platform: 'linux', home: '/h' }),
    ).toBe('/x/proxmox-ve-mcp/config.yaml');
    expect(
      defaultConfigPath({ env: { XDG_CONFIG_HOME: 'rel' }, platform: 'linux', home: '/h' }),
    ).toBe('/h/.config/proxmox-ve-mcp/config.yaml');
    expect(defaultConfigPath({ env: {}, platform: 'darwin', home: '/h' })).toBe(
      '/h/.config/proxmox-ve-mcp/config.yaml',
    );
    expect(
      defaultConfigPath({
        env: { APPDATA: 'C:\\Users\\u\\AppData\\Roaming' },
        platform: 'win32',
        home: 'C:\\Users\\u',
      }),
    ).toBe('C:\\Users\\u\\AppData\\Roaming\\proxmox-ve-mcp\\config.yaml');
  });

  it('prefers --config over PROXMOX_MCP_CONFIG and expands ~', () => {
    expect(
      resolveConfigPath({
        configPath: '~/a.yaml',
        env: { PROXMOX_MCP_CONFIG: '/b.yaml' },
        home: '/h',
      }),
    ).toEqual({
      path: '/h/a.yaml',
      explicit: true,
    });
    expect(resolveConfigPath({ env: { PROXMOX_MCP_CONFIG: '/b.yaml' }, home: '/h' }).path).toBe(
      '/b.yaml',
    );
    expect(expandHome('~', '/h')).toBe('/h');
    expect(expandHome('a/~', '/h')).toBe('a/~');
  });
});

describe('loadSettings from a file', () => {
  it('loads and validates the file', async () => {
    const file = writeConfig(YAML);
    const result = await loadSettings({ configPath: file, env: {}, catalog });
    expect(result.source).toBe('file');
    expect(result.path).toBe(file);
    expect(result.settings.hosts.lab!.tls.verify).toBe(true);
    expect(result.warnings).toEqual([]);
  });

  it.skipIf(process.platform === 'win32')('warns when the file is readable by others', async () => {
    const file = writeConfig(YAML, 0o644);
    const result = await loadSettings({ configPath: file, env: {}, catalog });
    expect(result.warnings.join('\n')).toMatch(/chmod 600/);
  });

  it.skipIf(process.platform === 'win32')(
    'refuses a file that group or others can write',
    async () => {
      for (const mode of [0o620, 0o602, 0o660, 0o666]) {
        const file = writeConfig(YAML, mode);
        await expect(loadSettings({ configPath: file, env: {}, catalog })).rejects.toThrow(
          /writable by group or others .*chmod go-w/,
        );
      }
    },
  );

  it.skipIf(process.platform === 'win32')(
    'refuses a directory that group or others can write without the sticky bit',
    async () => {
      const file = writeConfig(YAML);
      chmodSync(dir, 0o770);
      await expect(loadSettings({ configPath: file, env: {}, catalog })).rejects.toThrow(
        /directory .* writable by group or others .*sticky bit.*chmod go-w/,
      );
      chmodSync(dir, 0o1777);
      await expect(loadSettings({ configPath: file, env: {}, catalog })).resolves.toMatchObject({
        source: 'file',
      });
      chmodSync(dir, 0o700);
    },
  );

  it.skipIf(process.platform === 'win32')(
    'checks the directory of the real file behind a symlink',
    async () => {
      const shared = path.join(dir, 'shared');
      mkdirSync(shared);
      chmodSync(shared, 0o777);
      const real = path.join(shared, 'config.yaml');
      writeFileSync(real, YAML, { mode: 0o600 });
      chmodSync(real, 0o600);
      const link = path.join(dir, 'link.yaml');
      symlinkSync(real, link);
      await expect(loadSettings({ configPath: link, env: {}, catalog })).rejects.toThrow(
        /shared.* writable by group or others/,
      );
    },
  );

  it('refuses files of other users and accepts own and root files', () => {
    const me = 1000;
    expect(
      untrustedFileProblem('Settings file', { path: '/x', mode: 0o100600, uid: 1234 }, me),
    ).toMatch(/owned by another user \(uid 1234\).*chown 1000/);
    expect(
      untrustedFileProblem('Settings file', { path: '/x', mode: 0o100644, uid: me }, me),
    ).toBeUndefined();
    expect(
      untrustedFileProblem('tls.caFile', { path: '/x', mode: 0o100644, uid: 0 }, me),
    ).toBeUndefined();
    expect(untrustedDirProblem('settings file', { path: '/etc', mode: 0o40755, uid: 0 })).toBe(
      undefined,
    );
    expect(
      untrustedDirProblem('settings file', { path: '/tmp', mode: 0o41777, uid: 0 }),
    ).toBeUndefined();
    expect(untrustedDirProblem('settings file', { path: '/d', mode: 0o40775, uid: me })).toMatch(
      /chmod go-w/,
    );
  });

  it('errors for unknown keys, duplicate keys and unknown tools', async () => {
    await expect(
      loadSettings({
        configPath: writeConfig(YAML.replace('readOnly: false', 'readonly: true')),
        env: {},
        catalog,
      }),
    ).rejects.toThrow(/readonly|Unrecognized/i);
    await expect(
      loadSettings({ configPath: writeConfig(`${YAML}readOnly: true\n`), env: {}, catalog }),
    ).rejects.toBeInstanceOf(ConfigError);
    await expect(
      loadSettings({
        configPath: writeConfig(YAML.replace('pve_guest_delete: true', 'pve_guest_delet: false')),
        env: {},
        catalog,
      }),
    ).rejects.toThrow(/unknown tool/);
  });

  it('does not echo values in schema errors', () => {
    expect(() =>
      parseSettingsText(
        YAML.replace('source: keyring', 'source: plaintext\n      value: hunter2-secret'),
      ),
    ).toThrow(ConfigError);
    try {
      parseSettingsText(
        YAML.replace('source: keyring', 'source: plaintext\n      value: hunter2-secret'),
      );
    } catch (err) {
      expect(String(err)).not.toContain('hunter2-secret');
    }
  });

  it('wins over PROXMOX_URL with a warning', async () => {
    const file = writeConfig(YAML);
    const result = await loadSettings({
      configPath: file,
      env: { PROXMOX_URL: 'https://192.0.2.1:8006' },
      catalog,
    });
    expect(result.source).toBe('file');
    expect(result.warnings.join('\n')).toMatch(/settings file wins/);
  });

  it('fails clearly when an explicit file is missing', async () => {
    await expect(
      loadSettings({
        configPath: path.join(dir, 'missing.yaml'),
        env: { PROXMOX_URL: 'https://192.0.2.1' },
        catalog,
      }),
    ).rejects.toThrow(/does not exist/);
  });

  it('fails with a setup hint when neither file nor env exist', async () => {
    await expect(loadSettings({ env: { XDG_CONFIG_HOME: dir }, catalog })).rejects.toThrow(
      /proxmox-ve-mcp setup/,
    );
  });
});

describe('env tightening', () => {
  it('PROXMOX_MCP_READ_ONLY forces read-only and cannot loosen', async () => {
    const file = writeConfig(YAML.replace('readOnly: false', 'readOnly: true'));
    const loose = await loadSettings({
      configPath: file,
      env: { PROXMOX_MCP_READ_ONLY: '0' },
      catalog,
    });
    expect(loose.settings.readOnly).toBe(true);
    const file2 = writeConfig(YAML);
    const tight = await loadSettings({
      configPath: file2,
      env: { PROXMOX_MCP_READ_ONLY: '1' },
      catalog,
    });
    expect(tight.settings.readOnly).toBe(true);
    await expect(
      loadSettings({ configPath: file2, env: { PROXMOX_MCP_READ_ONLY: 'maybe' }, catalog }),
    ).rejects.toBeInstanceOf(ConfigError);
  });

  it('PROXMOX_MCP_DISABLE disables categories and tools and rejects unknown names', async () => {
    const file = writeConfig(YAML);
    const result = await loadSettings({
      configPath: file,
      env: { PROXMOX_MCP_DISABLE: 'nodes, pve_guest_delete' },
      catalog,
    });
    expect(result.settings.categories.nodes).toEqual({ enabled: false, tools: {} });
    expect(result.settings.categories.guests!.tools.pve_guest_delete).toBe(false);
    expect(result.settings.categories.guests!.enabled).toBe(true);
    await expect(
      loadSettings({ configPath: file, env: { PROXMOX_MCP_DISABLE: 'pve_guest_delet' }, catalog }),
    ).rejects.toThrow(/unknown/);
  });
});

describe('env-only mode', () => {
  const env = {
    XDG_CONFIG_HOME: '/nonexistent-for-test',
    PROXMOX_URL: 'https://192.0.2.10:8006',
    PROXMOX_TOKEN_ID: 'mcp@pve!agent',
    PROXMOX_TOKEN_SECRET: 'not-copied',
  };

  it('builds a single default host that references the env secret', async () => {
    const result = await loadSettings({ env, catalog });
    expect(result.source).toBe('env');
    expect(result.path).toBeUndefined();
    expect(result.settings.defaultHost).toBe('default');
    const host = result.settings.hosts.default!;
    expect(host.tokenSecret).toEqual({ source: 'env', name: 'PROXMOX_TOKEN_SECRET' });
    expect(JSON.stringify(result.settings)).not.toContain('not-copied');
    expect(host.readOnly).toBe(false);
  });

  it('supports the secret file, TLS and read-only variables', async () => {
    const result = await loadSettings({
      env: {
        ...env,
        PROXMOX_TOKEN_SECRET: undefined,
        PROXMOX_TOKEN_SECRET_FILE: '/run/secrets/pve',
        PROXMOX_TLS_FINGERPRINT: 'ab'.repeat(32),
        PROXMOX_READ_ONLY: '1',
        PROXMOX_MCP_READ_ONLY: 'true',
      },
      catalog,
    });
    const host = result.settings.hosts.default!;
    expect(host.tokenSecret).toEqual({ source: 'file', path: '/run/secrets/pve' });
    expect(host.tls.fingerprint).toMatch(/^AB:/);
    expect(host.readOnly).toBe(true);
    expect(result.settings.readOnly).toBe(true);
  });

  it('warns about disabled TLS verification', async () => {
    const result = await loadSettings({ env: { ...env, PROXMOX_TLS_VERIFY: '0' }, catalog });
    expect(result.settings.hosts.default!.tls.verify).toBe(false);
    expect(result.warnings.join('\n')).toMatch(/verification is disabled/);
  });

  it('rejects both secret variables, a missing secret and http URLs', async () => {
    await expect(
      loadSettings({ env: { ...env, PROXMOX_TOKEN_SECRET_FILE: '/x' }, catalog }),
    ).rejects.toThrow(/not both/);
    await expect(
      loadSettings({ env: { ...env, PROXMOX_TOKEN_SECRET: undefined }, catalog }),
    ).rejects.toThrow(/PROXMOX_TOKEN_SECRET/);
    await expect(
      loadSettings({ env: { ...env, PROXMOX_URL: 'http://192.0.2.10' }, catalog }),
    ).rejects.toThrow(/https/);
  });
});
