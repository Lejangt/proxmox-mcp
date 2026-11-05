import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { editorCommand, run as runConfig, splitCommandLine } from '../src/cli/config.js';
import { computeToolStates, run as runTools } from '../src/cli/tools.js';
import { validateSettings } from '../src/config/load.js';
import { renderSettingsDocument } from '../src/config/write.js';
import { selectTools } from '../src/server/server.js';
import { ALL_TOOLS } from '../src/tools/catalog.js';
import { fakeHosts } from './helpers/fixtures.js';
import { TEST_CATALOG, tempDir, testCli } from './helpers/cli.js';
import type { ProxmoxClient } from '../src/proxmox/types.js';

const HOST = {
  url: 'https://pve.example.com:8006',
  tokenId: 'mcp@pve!agent',
  tokenSecret: { source: 'keyring' as const },
  tls: { fingerprint: 'ab'.repeat(32) },
};

let tmp: ReturnType<typeof tempDir>;
beforeEach(() => {
  tmp = tempDir();
});
afterEach(() => tmp.cleanup());

describe('computeToolStates', () => {
  it('marks tools off with the reason', () => {
    const settings = validateSettings({
      version: 1,
      hosts: { lab: HOST },
      categories: {
        guests: { enabled: true, tools: { pve_guest_delete: false } },
        core: { enabled: false },
      },
    });
    const states = computeToolStates(settings, TEST_CATALOG);
    const by = Object.fromEntries(states.map((s) => [s.name, s]));
    expect(by.pve_hosts_list!.active).toBe(true); // core cannot be disabled
    expect(by.pve_guest_delete).toMatchObject({ active: false, reason: 'tool' });
    expect(by.pve_guest_power!.active).toBe(true);

    const ro = computeToolStates({ ...settings, readOnly: true }, TEST_CATALOG);
    expect(ro.find((s) => s.name === 'pve_guest_power')).toMatchObject({
      active: false,
      reason: 'read-only',
    });
    const off = computeToolStates(
      { ...settings, categories: { guests: { enabled: false, tools: {} } } },
      TEST_CATALOG,
    );
    expect(off.find((s) => s.name === 'pve_guest_list')?.reason).toBe('category');
    const allRo = computeToolStates(
      { ...settings, hosts: { lab: { ...settings.hosts.lab!, readOnly: true } } },
      TEST_CATALOG,
    );
    expect(allRo.find((s) => s.name === 'pve_guest_power')?.reason).toBe('all-hosts-read-only');
  });

  it('agrees with the server tool selection for the real catalog', () => {
    const variants = [
      validateSettings({ version: 1, hosts: { lab: HOST } }),
      validateSettings({ version: 1, readOnly: true, hosts: { lab: HOST } }),
      validateSettings({ version: 1, hosts: { lab: { ...HOST, readOnly: true } } }),
      validateSettings({
        version: 1,
        hosts: { lab: HOST },
        categories: { guests: { enabled: false }, core: { enabled: false } },
      }),
    ];
    for (const settings of variants) {
      const client = {} as ProxmoxClient;
      const readOnly = Object.fromEntries(
        Object.entries(settings.hosts).map(([a, h]) => [a, h.readOnly]),
      );
      const hosts = fakeHosts({ lab: client }, { readOnly });
      const expected = selectTools(ALL_TOOLS, settings, hosts).map((t) => t.name);
      const actual = computeToolStates(settings, ALL_TOOLS)
        .filter((s) => s.active)
        .map((s) => s.name);
      expect(actual).toEqual(expected);
    }
  });
});

describe('tools command', () => {
  it('shows defaults when there is no settings file', async () => {
    const cli = testCli({ configPath: tmp.file('missing.yaml') });
    expect(await runTools([], cli.ctx)).toBe(0);
    expect(cli.out()).toContain('pve_guest_delete');
    expect(cli.out()).toContain('4 of 4 tools active');
    expect(cli.err()).toContain('defaults');
  });

  it('prints JSON with states from the settings file', async () => {
    const file = tmp.file('config.yaml');
    const settings = validateSettings({
      version: 1,
      hosts: { lab: HOST },
      categories: { guests: { enabled: true, tools: { pve_guest_delete: false } } },
    });
    writeFileSync(file, renderSettingsDocument(settings, TEST_CATALOG), { mode: 0o600 });
    const cli = testCli({ configPath: file });
    expect(await runTools(['--json'], cli.ctx)).toBe(0);
    const states = JSON.parse(cli.out()) as { name: string; active: boolean; reason?: string }[];
    expect(states.find((s) => s.name === 'pve_guest_delete')).toMatchObject({
      active: false,
      reason: 'tool',
    });
    expect(states).toHaveLength(4);
  });

  it('applies PROXMOX_MCP_DISABLE even without a file', async () => {
    const cli = testCli({
      configPath: tmp.file('missing.yaml'),
      env: { PROXMOX_MCP_DISABLE: 'guests' },
    });
    expect(await runTools(['--json'], cli.ctx)).toBe(0);
    const states = JSON.parse(cli.out()) as { name: string; active: boolean }[];
    expect(states.filter((s) => s.active).map((s) => s.name)).toEqual(['pve_hosts_list']);
  });
});

describe('config command', () => {
  function writeConfig(text: string): string {
    const file = tmp.file('config.yaml');
    writeFileSync(file, text, { mode: 0o600 });
    return file;
  }

  it('path prints the resolved path', async () => {
    const cli = testCli({ configPath: tmp.file('x.yaml') });
    expect(await runConfig(['path'], cli.ctx)).toBe(0);
    expect(cli.out().trim()).toBe(tmp.file('x.yaml'));
  });

  it('validate accepts a valid file and reports unlisted tools', async () => {
    const file = writeConfig('version: 1\nhosts: {}\n');
    const cli = testCli({ configPath: file });
    expect(await runConfig(['validate'], cli.ctx)).toBe(0);
    expect(cli.out()).toContain('valid');
    expect(cli.out()).toMatch(/config sync/);
  });

  it('validate fails on unknown keys and unknown tools without a stack trace', async () => {
    const cli = testCli({ configPath: writeConfig('version: 1\nreadonly: true\n') });
    expect(await runConfig(['validate'], cli.ctx)).toBe(1);
    expect(cli.err()).toMatch(/readonly/);
    expect(cli.err()).not.toMatch(/\n\s+at /);

    const cli2 = testCli({
      configPath: writeConfig(
        'version: 1\ncategories:\n  guests:\n    tools:\n      pve_guest_nuke: false\n',
      ),
    });
    expect(await runConfig(['validate'], cli2.ctx)).toBe(1);
    expect(cli2.err()).toMatch(/pve_guest_nuke: unknown tool/);
  });

  it('sync adds missing categories and tools and keeps comments and values', async () => {
    const file = writeConfig(
      '# my comment\nversion: 1\nreadOnly: true # keep me\ncategories:\n  guests:\n    enabled: false\n    tools:\n      pve_guest_list: false\n',
    );
    const dry = testCli({ configPath: file });
    expect(await runConfig(['sync', '--dry-run'], dry.ctx)).toBe(0);
    expect(dry.out()).toContain('Would add');
    expect(readFileSync(file, 'utf8')).not.toContain('pve_guest_delete');

    const cli = testCli({ configPath: file });
    expect(await runConfig(['sync'], cli.ctx)).toBe(0);
    expect(cli.out()).toContain('guests.pve_guest_delete');
    expect(cli.out()).toContain('core');
    const text = readFileSync(file, 'utf8');
    expect(text).toContain('# my comment');
    expect(text).toContain('readOnly: true # keep me');
    expect(text).toMatch(/pve_guest_list: false/);
    expect(text).toMatch(/pve_guest_delete: true # \[D\] Delete a guest/);
    expect(statSync(file).mode & 0o777).toBe(0o600);

    const again = testCli({ configPath: file });
    expect(await runConfig(['sync'], again.ctx)).toBe(0);
    expect(again.out()).toContain('already lists every category and tool');
  });

  it('sync refuses an invalid file and leaves it alone', async () => {
    const file = writeConfig('version: 1\nbogus: 1\n');
    const cli = testCli({ configPath: file });
    expect(await runConfig(['sync'], cli.ctx)).toBe(1);
    expect(readFileSync(file, 'utf8')).toBe('version: 1\nbogus: 1\n');
  });

  it('edit needs a terminal and subcommands are checked', async () => {
    const cli = testCli({ configPath: writeConfig('version: 1\n') });
    expect(await runConfig(['edit'], cli.ctx)).toBe(1);
    expect(cli.err()).toMatch(/interactive terminal/);
    expect(await runConfig(['frob'], testCli().ctx)).toBe(2);
    expect(await runConfig([], testCli().ctx)).toBe(2);
  });
});

describe('editor command line', () => {
  it('splits without a shell', () => {
    expect(splitCommandLine('code --wait', 'linux')).toEqual(['code', '--wait']);
    expect(splitCommandLine(`"/opt/my editor/bin" -n 'a b'`, 'linux')).toEqual([
      '/opt/my editor/bin',
      '-n',
      'a b',
    ]);
    expect(splitCommandLine('vim\\ x', 'linux')).toEqual(['vim x']);
    expect(splitCommandLine('C:\\Tools\\ed.exe /x', 'win32')).toEqual(['C:\\Tools\\ed.exe', '/x']);
    expect(splitCommandLine('nano; rm -rf /', 'linux')).toEqual(['nano;', 'rm', '-rf', '/']);
    expect(() => splitCommandLine('"open', 'linux')).toThrow(/unterminated/);
  });

  it('prefers VISUAL over EDITOR and has a default', () => {
    expect(editorCommand({ VISUAL: 'code -w', EDITOR: 'nano' }, 'linux')).toEqual(['code', '-w']);
    expect(editorCommand({ EDITOR: 'nano' }, 'linux')).toEqual(['nano']);
    expect(editorCommand({}, 'linux')).toEqual(['vi']);
    expect(editorCommand({}, 'win32')).toEqual(['notepad']);
  });
});
