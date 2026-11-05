import pc from 'picocolors';
import type { Colors } from './context.js';

const COMMANDS: [string, string][] = [
  ['setup', 'interactive setup: host, TLS, token, secret store, client snippet'],
  ['host list|add|edit|remove|test [alias]', 'manage Proxmox hosts'],
  ['secret set <alias> [--stdin]', 'store or replace a token secret in the OS keychain'],
  ['tools [--json]', 'list categories and tools with access level and state'],
  ['config path|validate|sync|edit', 'work with the settings file'],
  ['doctor [alias]', 'check settings, secrets, TLS, connection and permissions'],
  ['client-config <client> [--name <n>]', 'print the snippet for an MCP client'],
  ['help [command]', 'show help, also: <command> --help'],
];

export function renderHelp(version: string, c: Colors): string {
  const width = Math.max(...COMMANDS.map(([cmd]) => cmd.length));
  const lines = [
    `${c.bold('proxmox-ve-mcp')} ${c.dim(version)}  MCP server for Proxmox VE`,
    '',
    c.bold('Usage'),
    `  proxmox-ve-mcp ${c.dim('[--config <path>]')}         start the MCP server on stdio (what MCP clients run)`,
    `  proxmox-ve-mcp <command> ${c.dim('[options]')}`,
    '',
    c.bold('Commands'),
    ...COMMANDS.map(([cmd, text]) => `  ${c.cyan(cmd.padEnd(width))}  ${text}`),
    '',
    c.bold('Options'),
    `  ${'--config <path>'.padEnd(width)}  settings file (default: platform config directory, or PROXMOX_MCP_CONFIG)`,
    `  ${'-v, --version'.padEnd(width)}  print the version`,
    `  ${'-h, --help'.padEnd(width)}  show this help`,
    '',
    c.bold('Getting started'),
    `  ${c.cyan('npx -y proxmox-ve-mcp setup')}`,
    `  ${c.cyan('npx -y proxmox-ve-mcp doctor')}`,
    '',
    `Clients: claude-code, claude-desktop, cursor, vscode, codex, windsurf`,
    '',
  ];
  return lines.join('\n');
}

export function plainColors(): Colors {
  return pc.createColors(false);
}
