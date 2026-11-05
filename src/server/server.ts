import { readFileSync } from 'node:fs';
import {
  McpServer,
  type CallToolResult,
  type InputRequiredResult,
  type ToolAnnotations,
} from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { Settings } from '../config/types.js';
import type { HostRegistry, ProxmoxClient } from '../proxmox/types.js';
import {
  capabilitiesOf,
  createConfirmBinder,
  cutMiddle,
  decideConfirmation,
  printableAscii,
} from './confirm.js';
import { errorMessage, errorResult, formatError, formatResult } from './format.js';
import type { AnyToolDef, ToolContext } from './registry.js';

export const SERVER_NAME = 'proxmox-ve-mcp';

export interface CreateServerOptions {
  settings: Settings;
  hosts: HostRegistry;
  tools: AnyToolDef[];
  /** Writes to stderr, never pass secrets. */
  log(message: string): void;
}

export const SERVER_INSTRUCTIONS = [
  'Manage Proxmox VE hosts and clusters: VMs (qemu), containers (lxc), storage, backups, snapshots, tasks and more.',
  'Several Proxmox hosts can be configured. Every tool takes an optional "host" alias, call pve_hosts_list to see the aliases and the default. Without "host" the default is used.',
  'Operations that start a Proxmox task wait for it by default and return the result with the last log lines. Pass wait=false to get the UPID right away, then use pve_task_wait or pve_task_status.',
  'Guest tools find node and type from the VMID. Use pve_cluster_resources or pve_guest_list to discover guests.',
  'Destructive tools may ask the user for confirmation. Do not retry a refused or declined operation.',
  'For anything without a dedicated tool call pve_api_describe to read the API schema of a path, then pve_api_get for reads and pve_api_request for POST, PUT and DELETE.',
].join('\n');

function packageVersion(): string {
  const url = new URL('../../package.json', import.meta.url);
  return (JSON.parse(readFileSync(url, 'utf8')) as { version: string }).version;
}

/** True when no configured host accepts writes. */
function allHostsReadOnly(hosts: HostRegistry): boolean {
  const list = hosts.list();
  return list.length > 0 && list.every((h) => h.readOnly);
}

/**
 * A tool is active when its category is enabled (core always is) and the tool
 * switch is not false. Read-only mode, global or on every host, keeps only
 * read tools.
 */
export function selectTools(
  tools: AnyToolDef[],
  settings: Settings,
  hosts: HostRegistry,
): AnyToolDef[] {
  const readOnly = settings.readOnly || allHostsReadOnly(hosts);
  return tools.filter((def) => {
    if (readOnly && def.access !== 'read') return false;
    const category = settings.categories[def.category];
    if (def.category !== 'core' && category?.enabled === false) return false;
    if (category?.tools[def.name] === false) return false;
    return true;
  });
}

export function hostSchema(hosts: HostRegistry): z.ZodType<string | undefined> {
  const aliases = hosts.aliases();
  const def = hosts.defaultAlias();
  const description =
    `Proxmox host alias${def ? `, default "${def}"` : ''}.` +
    (aliases.length > 1 ? ` Known hosts: ${aliases.join(', ')}.` : '');
  const first = aliases[0];
  if (aliases.length > 1 && first !== undefined) {
    return z
      .enum([first, ...aliases.slice(1)])
      .optional()
      .describe(description);
  }
  return z.string().optional().describe(description);
}

/** Stand-in for tools with `local: true`: any use is a programming error and says so. */
function unusedClient(tool: string): ProxmoxClient {
  return new Proxy({} as ProxmoxClient, {
    get(_target, prop) {
      throw new Error(
        `${tool} is a local tool and has no Proxmox client (accessed ${String(prop)})`,
      );
    },
  });
}

export function annotationsFor(def: AnyToolDef): ToolAnnotations {
  const read = def.access === 'read';
  return {
    title: def.title,
    readOnlyHint: read,
    ...(read
      ? { idempotentHint: true }
      : { destructiveHint: def.access === 'destructive' || def.needsConfirmation !== undefined }),
    openWorldHint: def.openWorld === true,
  };
}

/**
 * The confirmation target of a call. A failing lookup must not block the
 * question, so the message then names the arguments instead.
 */
async function confirmTargetOf(
  def: AnyToolDef,
  args: Parameters<AnyToolDef['handler']>[0],
  ctx: ToolContext,
): Promise<string | undefined> {
  if (!def.confirmTarget) return undefined;
  try {
    return await def.confirmTarget(args, ctx);
  } catch {
    const rest = { ...args } as Record<string, unknown>;
    delete rest.host;
    return `arguments ${cutMiddle(printableAscii(JSON.stringify(rest)), 300)}`;
  }
}

export function createServer(options: CreateServerOptions): McpServer {
  const { settings, hosts, log } = options;
  const binder = createConfirmBinder();
  const server = new McpServer(
    { name: SERVER_NAME, version: packageVersion() },
    { instructions: SERVER_INSTRUCTIONS, requestState: { verify: binder.verify } },
  );
  const host = hostSchema(hosts);
  const active = selectTools(options.tools, settings, hosts);

  for (const def of active) {
    const inputSchema = z.object(def.local ? { ...def.input } : { ...def.input, host });
    server.registerTool(
      def.name,
      {
        title: def.title,
        description: def.description,
        inputSchema,
        annotations: annotationsFor(def),
      },
      async (rawArgs, ctx): Promise<CallToolResult | InputRequiredResult> => {
        const args = rawArgs as Record<string, unknown> & { host?: string };
        try {
          const client = def.local ? unusedClient(def.name) : await hosts.client(args.host);
          if (!def.local && def.access !== 'read' && client.readOnly) {
            return errorResult(
              `Host "${client.alias}" is read-only, ${def.name} was not run. Use another host or change readOnly in the settings file.`,
            );
          }

          const toolArgs = args as Parameters<AnyToolDef['handler']>[0];
          const toolCtx: ToolContext = {
            client,
            hosts,
            settings,
            signal: ctx.mcpReq.signal,
            log,
          };
          if (
            def.access === 'destructive' ||
            (await def.needsConfirmation?.(toolArgs, toolCtx)) === true
          ) {
            const hostAlias = def.local ? 'local' : client.alias;
            const binding = binder.binding(def.name, hostAlias, args);
            const request = {
              mode: settings.confirmDestructive,
              tool: def.name,
              host: hostAlias,
              capabilities: capabilitiesOf(ctx, () => server.server.getClientCapabilities()),
              inputResponses: ctx.mcpReq.inputResponses,
              binding,
              echoedState: ctx.mcpReq.requestState(),
              newState: await binder.mint(binding),
            };
            let decision = decideConfirmation(request);
            if (decision.kind === 'ask') {
              // The target may need Proxmox lookups, so it is only built for a question.
              const target = await confirmTargetOf(def, toolArgs, toolCtx);
              decision = decideConfirmation({ ...request, ...(target ? { target } : {}) });
            }
            if (decision.kind === 'ask') return decision.result;
            if (decision.kind === 'refuse') return errorResult(decision.message);
          }

          const data = await def.handler(toolArgs, toolCtx);
          return formatResult(data, settings.limits.maxOutputChars);
        } catch (err) {
          log(`tool ${def.name} failed: ${errorMessage(err).split('\n')[0]}`);
          return formatError(err);
        }
      },
    );
  }

  log(`registered ${active.length} of ${options.tools.length} tools`);
  return server;
}
