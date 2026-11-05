import { accessLetter, type CatalogEntry } from '../config/schema.js';
import { applyEnvTightening, validateSettings } from '../config/load.js';
import type { Settings } from '../config/types.js';
import { CATEGORIES } from '../server/registry.js';
import { maxPositionals, pad, runCommand, type ContextInput } from './common.js';
import type { CliContext } from './context.js';
import { loadForCli, readConfigText, configLocation } from './settings-file.js';

export type ToolOffReason = 'category' | 'tool' | 'read-only' | 'all-hosts-read-only';

export interface ToolState {
  name: string;
  category: string;
  access: 'read' | 'write' | 'destructive';
  title: string;
  active: boolean;
  reason?: ToolOffReason;
}

export const REASON_TEXT: Record<ToolOffReason, string> = {
  category: 'category disabled',
  tool: 'tool disabled',
  'read-only': 'global read-only',
  'all-hosts-read-only': 'all hosts read-only',
};

/**
 * Mirrors selectTools in src/server/server.ts: core is always enabled, a
 * tool is off when its category or its own switch is off, and read-only
 * mode (global or on every host) keeps only read tools.
 */
export function computeToolStates(
  settings: Settings,
  catalog: readonly CatalogEntry[],
): ToolState[] {
  const hosts = Object.values(settings.hosts);
  const allHostsReadOnly = hosts.length > 0 && hosts.every((h) => h.readOnly);
  return catalog.map((tool) => {
    const state: ToolState = {
      name: tool.name,
      category: tool.category,
      access: tool.access,
      title: tool.title,
      active: true,
    };
    const category = settings.categories[tool.category];
    let reason: ToolOffReason | undefined;
    if (tool.category !== 'core' && category?.enabled === false) reason = 'category';
    else if (category?.tools[tool.name] === false) reason = 'tool';
    else if (tool.access !== 'read' && settings.readOnly) reason = 'read-only';
    else if (tool.access !== 'read' && allHostsReadOnly) reason = 'all-hosts-read-only';
    if (reason !== undefined) {
      state.active = false;
      state.reason = reason;
    }
    return state;
  });
}

export function renderToolStates(
  states: ToolState[],
  settings: Settings,
  c: CliContext['color'],
): string {
  const nameWidth = Math.max(...states.map((s) => s.name.length), 4);
  let out = '';
  for (const category of CATEGORIES) {
    const tools = states.filter((s) => s.category === category.id);
    if (tools.length === 0) continue;
    const enabled = category.id === 'core' || settings.categories[category.id]?.enabled !== false;
    const active = tools.filter((t) => t.active).length;
    out += `${c.bold(category.title)} ${c.dim(`(${category.id})`)}  ${
      enabled ? c.dim(`${active}/${tools.length} active`) : c.yellow('category disabled')
    }\n`;
    for (const tool of tools) {
      const letter = accessLetter(tool.access);
      const access =
        letter === 'R' ? c.green(letter) : letter === 'W' ? c.yellow(letter) : c.red(letter);
      const state = tool.active
        ? c.green('on ')
        : c.dim(`off (${REASON_TEXT[tool.reason ?? 'tool']})`);
      const name = tool.active ? pad(tool.name, nameWidth) : c.dim(pad(tool.name, nameWidth));
      out += `  ${access}  ${name}  ${state}  ${c.dim(tool.title)}\n`;
    }
    out += '\n';
  }
  const total = states.filter((s) => s.active).length;
  out += `${total} of ${states.length} tools active. Access: R read, W write, D destructive.\n`;
  return out;
}

const HELP = `Usage: proxmox-ve-mcp tools [--json] [--config <path>]

Lists every category and tool with its access level (R read, W write,
D destructive) and whether it is active with the current settings.
Without a settings file the defaults are shown.

Options:
  --json            machine readable output
  -h, --help        show this help
`;

export function run(args: string[], ctx?: ContextInput): Promise<number> {
  return runCommand(
    {
      help: HELP,
      options: { json: { type: 'boolean' } },
      async run(parsed, ctx) {
        maxPositionals(parsed, 0);
        const catalog = await ctx.catalog();
        const location = configLocation(ctx);
        let settings: Settings;
        let source: string;
        const exists = (await readConfigText(location.path)) !== undefined;
        if (exists || ctx.env.PROXMOX_URL) {
          const loaded = await loadForCli(ctx);
          settings = loaded.settings;
          source = loaded.path ?? 'environment';
        } else {
          settings = applyEnvTightening(
            validateSettings({ version: 1 }, 'defaults'),
            ctx.env,
            catalog,
          );
          source = 'defaults (no settings file)';
        }
        const states = computeToolStates(settings, catalog);
        if (parsed.values.json) {
          ctx.stdout(`${JSON.stringify(states, null, 2)}\n`);
          return 0;
        }
        ctx.stderr(`${ctx.color.dim(`Settings: ${source}`)}\n\n`);
        ctx.stdout(renderToolStates(states, settings, ctx.color));
        return 0;
      },
    },
    args,
    ctx,
  );
}
