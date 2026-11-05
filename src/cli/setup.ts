import {
  CLIENT_TITLES,
  CLIENTS,
  renderClientSnippet,
  snippetOptionsFor,
  type ClientId,
} from './client-config.js';
import { maxPositionals, requireInteractive, runCommand, type ContextInput } from './common.js';
import type { CliContext } from './context.js';
import { promptNewHost, saveHost } from './host-wizard.js';
import { configLocation, readConfigText, validateText } from './settings-file.js';

async function showClientSnippet(ctx: CliContext): Promise<void> {
  const p = ctx.prompter;
  const client = await p.select<ClientId | 'skip'>({
    message: 'Which MCP client do you use?',
    options: [
      ...CLIENTS.map((id) => ({ value: id, label: CLIENT_TITLES[id] })),
      {
        value: 'skip' as const,
        label: 'Skip',
        hint: 'later: proxmox-ve-mcp client-config <client>',
      },
    ],
  });
  if (client === 'skip') return;
  const snippet = renderClientSnippet(client, snippetOptionsFor(ctx));
  p.note(
    `${snippet.locations.join('\nor ')}\n\n${snippet.snippet}${
      snippet.notes.length > 0 ? `\n\n${snippet.notes.join('\n')}` : ''
    }`,
    snippet.title,
  );
}

const HELP = `Usage: proxmox-ve-mcp setup [--config <path>]

Interactive setup: checks the TLS certificate of your Proxmox host, asks for
the API token and where its secret should live (OS keychain, Bitwarden
Secrets Manager, 1Password, Vault or OpenBao, pass, a file, an environment
variable or a custom command), tests the connection and the token
permissions, writes the settings file and shows the snippet for your MCP
client. Run it again to add another host.

Options:
  --config <path>   settings file (default: platform config directory, or PROXMOX_MCP_CONFIG)
  -h, --help        show this help
`;

export function run(args: string[], ctx?: ContextInput): Promise<number> {
  return runCommand(
    {
      help: HELP,
      async run(parsed, ctx) {
        maxPositionals(parsed, 0);
        requireInteractive(ctx, 'setup');
        const p = ctx.prompter;
        const c = ctx.color;
        const location = configLocation(ctx);
        p.intro(c.inverse(' proxmox-ve-mcp setup '));

        const text = await readConfigText(location.path);
        const existing =
          text === undefined
            ? undefined
            : validateText(text, await ctx.catalog(), `Settings file ${location.path}`);
        if (existing) {
          const aliases = Object.keys(existing.hosts);
          p.info(
            `Settings file ${location.path} already exists with ${aliases.length} host${aliases.length === 1 ? '' : 's'}${
              aliases.length > 0 ? ` (${aliases.join(', ')})` : ''
            }.`,
          );
          const next = await p.select({
            message: 'What do you want to do?',
            options: [
              { value: 'add', label: 'Add another host' },
              { value: 'client', label: 'Show the MCP client configuration' },
              { value: 'exit', label: 'Exit', hint: 'change hosts with proxmox-ve-mcp host edit' },
            ],
          });
          if (next === 'exit') {
            p.outro('Nothing was changed.');
            return 0;
          }
          if (next === 'client') {
            await showClientSnippet(ctx);
            p.outro(`Check everything with: ${c.cyan('proxmox-ve-mcp doctor')}`);
            return 0;
          }
        } else {
          p.note(
            'This sets up one Proxmox host. You need its address and an API token.\n' +
              'Nothing is saved until the end, Ctrl+C cancels at any time.\n' +
              `Settings file: ${location.path}`,
            'Welcome',
          );
        }

        const aliases = new Set(Object.keys(existing?.hosts ?? {}));
        const draft = await promptNewHost(ctx, {
          location,
          existingAliases: aliases,
          keyringAvailable: await ctx.keyring.available(),
        });
        let makeDefault = false;
        if (aliases.size > 0) {
          makeDefault = await p.confirm({
            message: `Make "${draft.alias}" the default host (used when a tool call names no host)?`,
            initialValue: existing?.defaultHost === undefined,
          });
        }
        const saved = await saveHost(ctx, location, draft, { makeDefault });
        for (const entry of saved.keyringStored)
          p.success(`Stored the ${entry} in the OS keychain.`);
        if (draft.caFile) p.success(`Saved the CA certificate to ${draft.caFile.path}`);
        p.success(
          `${saved.created ? 'Created' : 'Updated'} ${saved.path}` +
            (saved.created
              ? ' (every category and tool is listed there and can be switched off)'
              : ''),
        );

        await showClientSnippet(ctx);
        p.outro(`Done. Check everything with: ${c.cyan('proxmox-ve-mcp doctor')}`);
        return 0;
      },
    },
    args,
    ctx,
  );
}
