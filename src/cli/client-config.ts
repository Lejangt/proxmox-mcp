import { runCommand, maxPositionals, type ContextInput } from './common.js';
import type { CliContext } from './context.js';
import { UsageError } from './errors.js';
import { configLocation } from './settings-file.js';

/*
 * Snippet formats, checked against the official documentation (2026-11):
 * - Claude Code: `claude mcp add [options] <name> -- <command> [args...]`
 *   https://code.claude.com/docs/en/mcp
 * - Claude Desktop: claude_desktop_config.json with "mcpServers"
 *   https://modelcontextprotocol.io/docs/develop/connect-local-servers
 * - Cursor: ~/.cursor/mcp.json or .cursor/mcp.json with "mcpServers"
 *   https://cursor.com/docs/context/mcp
 * - VS Code: .vscode/mcp.json with "servers" and "type": "stdio"
 *   https://code.visualstudio.com/docs/copilot/reference/mcp-configuration
 * - Codex: ~/.codex/config.toml with [mcp_servers.<name>]
 *   https://learn.chatgpt.com/docs/extend/mcp?surface=cli
 * - Windsurf: ~/.codeium/windsurf/mcp_config.json with "mcpServers". The
 *   official page (docs.windsurf.com/windsurf/cascade/mcp) now redirects to
 *   other product docs, so this path follows the established convention.
 */

export const CLIENTS = [
  'claude-code',
  'claude-desktop',
  'cursor',
  'vscode',
  'codex',
  'windsurf',
] as const;
export type ClientId = (typeof CLIENTS)[number];

export const CLIENT_TITLES: Record<ClientId, string> = {
  'claude-code': 'Claude Code',
  'claude-desktop': 'Claude Desktop',
  cursor: 'Cursor',
  vscode: 'VS Code',
  codex: 'Codex',
  windsurf: 'Windsurf',
};

export const PACKAGE_NAME = 'proxmox-ve-mcp';
export const DEFAULT_SERVER_NAME = 'proxmox';
const SERVER_NAME_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

export interface ClientSnippet {
  client: ClientId;
  title: string;
  /** Where the snippet goes, one entry per location. */
  locations: string[];
  /** Text to paste or run. Never contains a secret. */
  snippet: string;
  /** Language hint for the snippet: shell, json or toml. */
  language: 'shell' | 'json' | 'toml';
  notes: string[];
}

export interface SnippetOptions {
  name?: string;
  /** Only set when a non-default settings path is used. */
  configPath?: string;
  platform?: NodeJS.Platform;
}

export function isClientId(value: string): value is ClientId {
  return (CLIENTS as readonly string[]).includes(value);
}

export function validateServerName(name: string): string {
  if (!SERVER_NAME_PATTERN.test(name)) {
    throw new UsageError(
      '--name may only contain letters, digits, "_" and "-" (max 64 characters)',
    );
  }
  return name;
}

/** Quotes one argument for display in a shell command. */
export function shellQuote(arg: string, platform: NodeJS.Platform): string {
  if (/^[A-Za-z0-9_@%+=:,./\\-]+$/.test(arg)) return arg;
  if (platform === 'win32') return `"${arg.replace(/"/g, '\\"')}"`;
  return `'${arg.replace(/'/g, `'\\''`)}'`;
}

function serverArgs(configPath: string | undefined): string[] {
  return ['-y', PACKAGE_NAME, ...(configPath !== undefined ? ['--config', configPath] : [])];
}

function jsonSnippet(
  key: 'mcpServers' | 'servers',
  name: string,
  args: string[],
  withType: boolean,
): string {
  const entry: Record<string, unknown> = withType
    ? { type: 'stdio', command: 'npx', args }
    : { command: 'npx', args };
  return JSON.stringify({ [key]: { [name]: entry } }, null, 2);
}

function homePath(platform: NodeJS.Platform, ...parts: string[]): string {
  return platform === 'win32' ? `%USERPROFILE%\\${parts.join('\\')}` : `~/${parts.join('/')}`;
}

/** Builds the configuration snippet for one MCP client. */
export function renderClientSnippet(client: ClientId, options: SnippetOptions = {}): ClientSnippet {
  const name = validateServerName(options.name ?? DEFAULT_SERVER_NAME);
  const platform = options.platform ?? process.platform;
  const args = serverArgs(options.configPath);
  const title = CLIENT_TITLES[client];
  const base = { client, title };
  const mergeNote =
    'If the file already has other servers, add only the inner entry to the existing object.';

  switch (client) {
    case 'claude-code': {
      const argv = ['claude', 'mcp', 'add', '--transport', 'stdio', name, '--', 'npx', ...args];
      return {
        ...base,
        locations: ['Run in a terminal'],
        snippet: argv.map((a) => shellQuote(a, platform)).join(' '),
        language: 'shell',
        notes: [
          'Add --scope user (before the name) to use the server in every project, the default scope is the current project only.',
        ],
      };
    }
    case 'claude-desktop': {
      const file =
        platform === 'darwin'
          ? '~/Library/Application Support/Claude/claude_desktop_config.json'
          : platform === 'win32'
            ? '%APPDATA%\\Claude\\claude_desktop_config.json'
            : '~/.config/Claude/claude_desktop_config.json';
      return {
        ...base,
        locations: [file],
        snippet: jsonSnippet('mcpServers', name, args, false),
        language: 'json',
        notes: [
          'Open it from Claude Desktop: Settings > Developer > Edit Config.',
          mergeNote,
          'Restart Claude Desktop completely afterwards.',
        ],
      };
    }
    case 'cursor':
      return {
        ...base,
        locations: [
          `${homePath(platform, '.cursor', 'mcp.json')} (all projects)`,
          '.cursor/mcp.json in the project (this project only)',
        ],
        snippet: jsonSnippet('mcpServers', name, args, true),
        language: 'json',
        notes: [mergeNote],
      };
    case 'vscode':
      return {
        ...base,
        locations: ['.vscode/mcp.json in the workspace'],
        snippet: jsonSnippet('servers', name, args, true),
        language: 'json',
        notes: [
          'For all workspaces use the command palette: MCP: Add Server.',
          'VS Code uses "servers", not "mcpServers".',
          mergeNote,
        ],
      };
    case 'codex': {
      const toml = [
        `[mcp_servers.${name}]`,
        'command = "npx"',
        `args = [${args.map((a) => JSON.stringify(a)).join(', ')}]`,
      ].join('\n');
      const cli = ['codex', 'mcp', 'add', name, '--', 'npx', ...args]
        .map((a) => shellQuote(a, platform))
        .join(' ');
      return {
        ...base,
        locations: [homePath(platform, '.codex', 'config.toml')],
        snippet: toml,
        language: 'toml',
        notes: [`Or run: ${cli}`],
      };
    }
    case 'windsurf':
      return {
        ...base,
        locations: [homePath(platform, '.codeium', 'windsurf', 'mcp_config.json')],
        snippet: jsonSnippet('mcpServers', name, args, false),
        language: 'json',
        notes: [mergeNote, 'Restart Windsurf or refresh the MCP servers afterwards.'],
      };
  }
}

/** Snippet options for the current settings path (adds --config only for a custom path). */
export function snippetOptionsFor(ctx: CliContext, name?: string): SnippetOptions {
  const location = configLocation(ctx);
  return {
    platform: ctx.platform,
    ...(name !== undefined ? { name } : {}),
    ...(location.custom ? { configPath: location.path } : {}),
  };
}

export const HELP = `Usage: proxmox-ve-mcp client-config <client> [--name <name>] [--config <path>]

Prints the configuration snippet that registers this server in an MCP client.
The snippet goes to stdout, where to put it goes to stderr.

Clients: ${CLIENTS.join(', ')}

Options:
  --name <name>     server name in the client (default: ${DEFAULT_SERVER_NAME})
  --config <path>   settings file, only added to the snippet when it is not the default
  -h, --help        show this help
`;

export function run(args: string[], ctx?: ContextInput): Promise<number> {
  return runCommand(
    {
      help: HELP,
      options: { name: { type: 'string' } },
      async run(parsed, ctx) {
        maxPositionals(parsed, 1);
        const client = parsed.positionals[0];
        if (client === undefined) throw new UsageError(`name a client: ${CLIENTS.join(', ')}`);
        if (!isClientId(client)) {
          throw new UsageError(
            `unknown client "${client.slice(0, 40)}", known: ${CLIENTS.join(', ')}`,
          );
        }
        const name = parsed.values.name as string | undefined;
        const result = renderClientSnippet(client, snippetOptionsFor(ctx, name));
        const c = ctx.color;
        ctx.stderr(`${c.bold(result.title)}: ${result.locations.join(' or ')}\n\n`);
        ctx.stdout(`${result.snippet}\n`);
        if (result.notes.length > 0) {
          ctx.stderr(`\n${result.notes.map((n) => c.dim(n)).join('\n')}\n`);
        }
        return 0;
      },
    },
    args,
    ctx,
  );
}
