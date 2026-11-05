import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { hostRows, run as runHost } from '../src/cli/host.js';
import { readFirstLine, run as runSecret } from '../src/cli/secret.js';
import { parseSettingsText, validateSettings } from '../src/config/load.js';
import { renderSettingsDocument } from '../src/config/write.js';
import { fakeKeyring, TEST_CATALOG, tempDir, testCli } from './helpers/cli.js';

const SECRET = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

let tmp: ReturnType<typeof tempDir>;
let file: string;

function writeSettings(input: Record<string, unknown>): void {
  const settings = validateSettings({ version: 1, ...input });
  writeFileSync(file, renderSettingsDocument(settings, TEST_CATALOG), { mode: 0o600 });
}

function current() {
  return parseSettingsText(readFileSync(file, 'utf8'));
}

beforeEach(() => {
  tmp = tempDir();
  file = tmp.file('config.yaml');
  writeSettings({
    defaultHost: 'lab',
    hosts: {
      lab: {
        description: 'Lab',
        url: 'https://pve.example.com:8006',
        tokenId: 'mcp@pve!agent',
        tokenSecret: { source: 'keyring' },
        tls: { fingerprint: 'ab'.repeat(32) },
      },
      office: {
        url: 'https://192.0.2.10:8006',
        tokenId: 'auto@pve!mcp',
        tokenSecret: { source: 'file', path: '/run/secrets/pve' },
        tls: { verify: false },
        readOnly: true,
      },
    },
  });
});
afterEach(() => tmp.cleanup());

describe('host list', () => {
  it('prints a table with mode, secret source and default', async () => {
    const cli = testCli({ configPath: file });
    expect(await runHost(['list'], cli.ctx)).toBe(0);
    const lines = cli.out().trim().split('\n');
    expect(lines[0]).toMatch(/^ALIAS\s+URL\s+READ-ONLY\s+TLS\s+SECRET\s+DEFAULT$/);
    expect(lines[1]).toMatch(
      /^lab\s+https:\/\/pve\.example\.com:8006\s+no\s+pinned\s+keyring\s+yes$/,
    );
    expect(lines[2]).toMatch(
      /^office\s+https:\/\/192\.0\.2\.10:8006\s+yes\s+off\s+file \/run\/secrets\/pve$/,
    );
  });

  it('prints JSON and marks global read-only', async () => {
    const cli = testCli({ configPath: file, env: { PROXMOX_MCP_READ_ONLY: '1' } });
    expect(await runHost(['list', '--json'], cli.ctx)).toBe(0);
    const rows = JSON.parse(cli.out()) as ReturnType<typeof hostRows>;
    expect(rows.map((r) => [r.alias, r.readOnly, r.default])).toEqual([
      ['lab', 'yes (global)', true],
      ['office', 'yes (global)', false],
    ]);
  });

  it('fails cleanly without a settings file', async () => {
    const cli = testCli({ configPath: tmp.file('none.yaml') });
    expect(await runHost(['list'], cli.ctx)).toBe(1);
    expect(cli.err()).toMatch(/does not exist/);
  });
});

describe('host remove', () => {
  it('needs --yes without a terminal', async () => {
    const cli = testCli({ configPath: file });
    expect(await runHost(['remove', 'office'], cli.ctx)).toBe(2);
    expect(Object.keys(current().hosts)).toEqual(['lab', 'office']);
  });

  it('removes a host with --yes, keeps comments and 0600', async () => {
    const cli = testCli({ configPath: file });
    expect(await runHost(['remove', 'office', '--yes'], cli.ctx)).toBe(0);
    expect(Object.keys(current().hosts)).toEqual(['lab']);
    expect(current().defaultHost).toBe('lab');
    expect(readFileSync(file, 'utf8')).toContain('# Settings for proxmox-ve-mcp');
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it('removing the default host removes defaultHost, keychain entry stays by default', async () => {
    const keyring = fakeKeyring();
    keyring.entries.set('proxmox-ve-mcp/lab', SECRET);
    const cli = testCli({ configPath: file, keyring });
    expect(await runHost(['remove', 'lab', '--yes'], cli.ctx)).toBe(0);
    expect(current().defaultHost).toBeUndefined();
    expect(cli.out()).toContain('defaultHost was removed');
    expect(cli.out()).toContain('stays in the OS keychain');
    expect(keyring.entries.has('proxmox-ve-mcp/lab')).toBe(true);
  });

  it('deletes the keychain entry and the managed CA file on request', async () => {
    const ca = path.join(tmp.dir, 'ca', 'lab.pem');
    mkdirSync(path.dirname(ca));
    writeFileSync(ca, 'pem');
    writeSettings({
      hosts: {
        lab: {
          url: 'https://pve.example.com:8006',
          tokenId: 'mcp@pve!agent',
          tokenSecret: { source: 'keyring' },
          tls: { caFile: ca },
        },
      },
    });
    const keyring = fakeKeyring();
    keyring.entries.set('proxmox-ve-mcp/lab', SECRET);
    const cli = testCli({ configPath: file, keyring });
    expect(await runHost(['remove', 'lab', '--yes', '--delete-secret'], cli.ctx)).toBe(0);
    expect(keyring.entries.size).toBe(0);
    expect(existsSync(ca)).toBe(false);
    expect(current().hosts).toEqual({});
  });

  it('asks for confirmation in a terminal and can be declined', async () => {
    const cli = testCli({ configPath: file, interactive: true, answers: [false] });
    expect(await runHost(['remove', 'lab'], cli.ctx)).toBe(0);
    expect(cli.out()).toContain('Nothing was removed');
    expect(Object.keys(current().hosts)).toEqual(['lab', 'office']);

    const keyring = fakeKeyring();
    keyring.entries.set('proxmox-ve-mcp/lab', SECRET);
    const yes = testCli({ configPath: file, interactive: true, answers: [true, true], keyring });
    expect(await runHost(['remove', 'lab'], yes.ctx)).toBe(0);
    expect(keyring.entries.size).toBe(0);
    expect(Object.keys(current().hosts)).toEqual(['office']);
  });

  it('rejects an unknown alias', async () => {
    const cli = testCli({ configPath: file });
    expect(await runHost(['remove', 'nope', '--yes'], cli.ctx)).toBe(1);
    expect(cli.err()).toMatch(/Unknown host "nope"/);
  });
});

describe('secret set', () => {
  it('reads one line from stdin and stores it under the host alias', async () => {
    const cli = testCli({ configPath: file, stdin: `${SECRET}\nignored\n` });
    expect(await runSecret(['set', 'lab', '--stdin'], cli.ctx)).toBe(0);
    expect(cli.keyring.entries.get('proxmox-ve-mcp/lab')).toBe(SECRET);
    expect(cli.out()).not.toContain(SECRET);
    expect(cli.err()).not.toContain(SECRET);
  });

  it('switches another source to the keychain only with --use-keyring', async () => {
    const plain = testCli({ configPath: file, stdin: SECRET });
    expect(await runSecret(['set', 'office', '--stdin'], plain.ctx)).toBe(0);
    expect(current().hosts.office!.tokenSecret).toEqual({
      source: 'file',
      path: '/run/secrets/pve',
    });
    expect(plain.out()).toContain('--use-keyring');

    const cli = testCli({ configPath: file, stdin: `${SECRET}\r\n` });
    expect(await runSecret(['set', 'office', '--stdin', '--use-keyring'], cli.ctx)).toBe(0);
    expect(cli.keyring.entries.get('proxmox-ve-mcp/office')).toBe(SECRET);
    expect(current().hosts.office!.tokenSecret).toEqual({ source: 'keyring' });
    expect(current().hosts.office!.readOnly).toBe(true);
    expect(readFileSync(file, 'utf8')).not.toContain(SECRET);
  });

  it('never takes the secret as an argument and does not echo it', async () => {
    const cli = testCli({ configPath: file });
    expect(await runSecret(['set', 'lab', SECRET], cli.ctx)).toBe(2);
    expect(cli.err()).not.toContain(SECRET);
    expect(cli.err()).toMatch(/no value argument/);
    expect(cli.keyring.entries.size).toBe(0);
  });

  it('refuses --stdin from a terminal and a missing terminal without --stdin', async () => {
    const tty = Object.assign(Readable.from([]), { isTTY: true });
    const cli = testCli({ configPath: file, stdin: tty });
    expect(await runSecret(['set', 'lab', '--stdin'], cli.ctx)).toBe(2);
    const noTty = testCli({ configPath: file });
    expect(await runSecret(['set', 'lab'], noTty.ctx)).toBe(2);
  });

  it('uses the hidden prompt in a terminal', async () => {
    const cli = testCli({ configPath: file, interactive: true, answers: [SECRET] });
    expect(await runSecret(['set', 'lab'], cli.ctx)).toBe(0);
    expect(cli.keyring.entries.get('proxmox-ve-mcp/lab')).toBe(SECRET);
    expect(cli.prompter.messages[0]).toMatch(/^password:/);
  });

  it('rejects empty or invalid input, unknown hosts and a missing keychain', async () => {
    const empty = testCli({ configPath: file, stdin: '\n' });
    expect(await runSecret(['set', 'lab', '--stdin'], empty.ctx)).toBe(1);
    expect(empty.err()).toMatch(/empty/);
    const spaced = testCli({ configPath: file, stdin: 'a b c d\n' });
    expect(await runSecret(['set', 'lab', '--stdin'], spaced.ctx)).toBe(1);
    const unknown = testCli({ configPath: file, stdin: SECRET });
    expect(await runSecret(['set', 'nope', '--stdin'], unknown.ctx)).toBe(1);
    const noKeyring = testCli({ configPath: file, stdin: SECRET, keyring: fakeKeyring(false) });
    expect(await runSecret(['set', 'lab', '--stdin'], noKeyring.ctx)).toBe(1);
    expect(noKeyring.err()).toMatch(/keychain is not available/);
  });

  it('readFirstLine stops at the newline and limits the size', async () => {
    expect(await readFirstLine(Readable.from([Buffer.from('ab'), Buffer.from('c\nrest')]))).toBe(
      'abc',
    );
    await expect(readFirstLine(Readable.from([Buffer.alloc(5000, 0x61)]))).rejects.toThrow(/4 KiB/);
  });
});
