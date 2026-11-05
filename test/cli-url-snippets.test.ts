import { describe, expect, it } from 'vitest';
import {
  CLIENTS,
  renderClientSnippet,
  run as runClientConfig,
  shellQuote,
} from '../src/cli/client-config.js';
import { normalizeHostUrl } from '../src/cli/url.js';
import { testCli } from './helpers/cli.js';

describe('normalizeHostUrl', () => {
  it.each([
    ['pve.example.com', 'https://pve.example.com:8006'],
    ['  PVE.Example.com  ', 'https://pve.example.com:8006'],
    ['pve.example.com:443', 'https://pve.example.com'],
    ['pve.example.com:8443', 'https://pve.example.com:8443'],
    ['192.0.2.10', 'https://192.0.2.10:8006'],
    ['192.0.2.10:8006', 'https://192.0.2.10:8006'],
    ['https://pve.example.com', 'https://pve.example.com:8006'],
    ['https://pve.example.com:8006/', 'https://pve.example.com:8006'],
    ['https://pve.example.com:8006/#v1:0:18:4:::::::', 'https://pve.example.com:8006'],
    ['https://pve.example.com:8006/api2/json', 'https://pve.example.com:8006'],
    ['HTTPS://pve.example.com', 'https://pve.example.com:8006'],
    ['2001:db8::1', 'https://[2001:db8::1]:8006'],
    ['[2001:db8::1]:8443', 'https://[2001:db8::1]:8443'],
  ])('%s -> %s', (input, expected) => {
    expect(normalizeHostUrl(input)).toBe(expected);
  });

  it.each([
    ['', /Enter a host/],
    ['http://pve.example.com', /Only https/],
    ['ftp://pve.example.com', /Only https/],
    ['https://user:pw@pve.example.com', /user name or password/],
    ['https://pve.example.com/some/path', /must not contain a path/],
    ['https://pve.example.com/?a=1', /query/],
    ['pve example.com', /spaces/],
    ['pve.example.com:notaport', /not a valid/],
  ])('rejects %j', (input, message) => {
    expect(() => normalizeHostUrl(input)).toThrow(message);
  });
});

describe('client snippets', () => {
  it('claude-code prints the mcp add command', () => {
    const s = renderClientSnippet('claude-code', { platform: 'linux' });
    expect(s.snippet).toBe('claude mcp add --transport stdio proxmox -- npx -y proxmox-ve-mcp');
    expect(s.language).toBe('shell');
  });

  it('adds --config only when a path is given and quotes it for the shell', () => {
    const s = renderClientSnippet('claude-code', {
      platform: 'linux',
      configPath: "/srv/my dir/it's.yaml",
    });
    expect(s.snippet).toBe(
      `claude mcp add --transport stdio proxmox -- npx -y proxmox-ve-mcp --config '/srv/my dir/it'\\''s.yaml'`,
    );
    expect(shellQuote('C:\\a b\\c.yaml', 'win32')).toBe('"C:\\a b\\c.yaml"');
  });

  it('claude-desktop uses mcpServers and the per OS file', () => {
    const mac = renderClientSnippet('claude-desktop', { platform: 'darwin' });
    expect(mac.locations[0]).toBe(
      '~/Library/Application Support/Claude/claude_desktop_config.json',
    );
    expect(renderClientSnippet('claude-desktop', { platform: 'win32' }).locations[0]).toBe(
      '%APPDATA%\\Claude\\claude_desktop_config.json',
    );
    expect(renderClientSnippet('claude-desktop', { platform: 'linux' }).locations[0]).toBe(
      '~/.config/Claude/claude_desktop_config.json',
    );
    expect(JSON.parse(mac.snippet)).toEqual({
      mcpServers: { proxmox: { command: 'npx', args: ['-y', 'proxmox-ve-mcp'] } },
    });
  });

  it('vscode uses servers with type stdio', () => {
    const s = renderClientSnippet('vscode', { name: 'pve', configPath: '/etc/pve-mcp.yaml' });
    expect(JSON.parse(s.snippet)).toEqual({
      servers: {
        pve: {
          type: 'stdio',
          command: 'npx',
          args: ['-y', 'proxmox-ve-mcp', '--config', '/etc/pve-mcp.yaml'],
        },
      },
    });
    expect(s.locations[0]).toContain('.vscode/mcp.json');
  });

  it('cursor and windsurf use mcpServers', () => {
    expect(JSON.parse(renderClientSnippet('cursor', {}).snippet).mcpServers.proxmox.command).toBe(
      'npx',
    );
    const w = renderClientSnippet('windsurf', { platform: 'linux' });
    expect(w.locations[0]).toBe('~/.codeium/windsurf/mcp_config.json');
    expect(JSON.parse(w.snippet).mcpServers.proxmox.args).toEqual(['-y', 'proxmox-ve-mcp']);
  });

  it('codex prints a TOML table', () => {
    const s = renderClientSnippet('codex', { platform: 'linux', configPath: '/a "b".yaml' });
    expect(s.snippet).toBe(
      [
        '[mcp_servers.proxmox]',
        'command = "npx"',
        'args = ["-y", "proxmox-ve-mcp", "--config", "/a \\"b\\".yaml"]',
      ].join('\n'),
    );
    expect(s.locations[0]).toBe('~/.codex/config.toml');
  });

  it('never contains anything secret-like and only ASCII', () => {
    for (const client of CLIENTS) {
      const s = renderClientSnippet(client, { platform: 'linux' });
      const all = [s.snippet, ...s.locations, ...s.notes].join('\n');
      expect(all).not.toMatch(/token|secret|password|env/i);
      expect(all).toMatch(/^[\x20-\x7e\n]*$/);
    }
  });

  it('rejects names that would break the snippet', () => {
    expect(() => renderClientSnippet('codex', { name: 'a b' })).toThrow(/--name/);
    expect(() => renderClientSnippet('codex', { name: 'x]\n[evil' })).toThrow(/--name/);
  });

  it('command writes the snippet to stdout and the location to stderr', async () => {
    const cli = testCli({ configPath: '/srv/custom.yaml' });
    expect(await runClientConfig(['cursor', '--name', 'lab'], cli.ctx)).toBe(0);
    const parsed = JSON.parse(cli.out());
    expect(parsed.mcpServers.lab.args).toEqual([
      '-y',
      'proxmox-ve-mcp',
      '--config',
      '/srv/custom.yaml',
    ]);
    expect(cli.err()).toContain('Cursor');
  });

  it('command leaves out --config for the default path', async () => {
    const cli = testCli({ env: { XDG_CONFIG_HOME: '/xdg' } });
    cli.ctx.configPath = '/xdg/proxmox-ve-mcp/config.yaml';
    expect(await runClientConfig(['claude-code'], cli.ctx)).toBe(0);
    expect(cli.out().trim()).toBe(
      'claude mcp add --transport stdio proxmox -- npx -y proxmox-ve-mcp',
    );
  });

  it('command fails with exit code 2 for an unknown client', async () => {
    const cli = testCli();
    expect(await runClientConfig(['emacs'], cli.ctx)).toBe(2);
    expect(cli.err()).toMatch(/unknown client/);
    expect(cli.err()).not.toMatch(/\n\s+at /);
  });
});
