import { z } from 'zod';
import { pvePath } from '../proxmox/path.js';
import { taskOutcome } from '../proxmox/tasks.js';
import { defineTool, type AnyToolDef } from '../server/registry.js';
import { nodeSchema, timeframeSchema, waitSchema } from './common.js';
import { summarizeRrd } from './guests.js';
import { defaultNode } from './resolve-node.js';
import { nodeLabel } from './targets.js';

const nodeOptional = nodeSchema
  .optional()
  .describe('Node name. Optional when the host has exactly one node.');

type Row = Record<string, unknown>;

function pick(row: Row, keys: readonly string[]): Row {
  const out: Row = {};
  for (const key of keys) if (row[key] !== undefined && row[key] !== null) out[key] = row[key];
  return out;
}

const NODE_FIELDS = [
  'node',
  'status',
  'cpu',
  'maxcpu',
  'mem',
  'maxmem',
  'uptime',
  'level',
] as const;

const nodeList = defineTool({
  name: 'pve_node_list',
  category: 'nodes',
  title: 'List nodes',
  description:
    'Nodes of the host or cluster with online status, CPU load (0 to 1), memory, uptime and ' +
    'support level. Use it to learn node names for the node argument of other tools.',
  access: 'read',
  input: {},
  handler: async (_args, ctx) => {
    const rows = (await ctx.client.get<Row[]>('/nodes')) ?? [];
    return rows.map((r) => pick(r, NODE_FIELDS));
  },
});

const nodeStatus = defineTool({
  name: 'pve_node_status',
  category: 'nodes',
  title: 'Node status',
  description:
    'Detailed status of one node: CPU model and count, load average, memory, swap, root filesystem, ' +
    'kernel and Proxmox version, uptime.',
  access: 'read',
  input: { node: nodeOptional },
  handler: async (args, ctx) => {
    const node = await defaultNode(ctx.client, args.node);
    const data = await ctx.client.get<Row>(pvePath`/nodes/${node}/status`);
    return { node, ...data };
  },
});

const nodeRrd = defineTool({
  name: 'pve_node_rrd',
  category: 'nodes',
  title: 'Node metrics',
  description:
    'CPU, memory, load, network and disk metrics of a node over a timeframe (hour, day, week, month, year). ' +
    'The result is condensed to min, avg, max and latest per metric plus the last 5 points. ' +
    'cf AVERAGE (default) or MAX (peaks).',
  access: 'read',
  input: {
    node: nodeOptional,
    timeframe: timeframeSchema,
    cf: z.enum(['AVERAGE', 'MAX']).optional().describe('Consolidation function, default AVERAGE'),
  },
  handler: async (args, ctx) => {
    const node = await defaultNode(ctx.client, args.node);
    const cf = args.cf ?? 'AVERAGE';
    const rows =
      (await ctx.client.get<Array<Record<string, number | null | undefined>>>(
        pvePath`/nodes/${node}/rrddata`,
        { timeframe: args.timeframe, cf },
      )) ?? [];
    return { node, timeframe: args.timeframe, cf, ...summarizeRrd(rows) };
  },
});

const nodeServices = defineTool({
  name: 'pve_node_services',
  category: 'nodes',
  title: 'Node services',
  description:
    'System services of a node (pveproxy, pvedaemon, pve-cluster, corosync, sshd, chrony, ...) with ' +
    'their state. Use the service id from the result for pve_node_service_action.',
  access: 'read',
  input: { node: nodeOptional },
  handler: async (args, ctx) => {
    const node = await defaultNode(ctx.client, args.node);
    const rows = (await ctx.client.get<Row[]>(pvePath`/nodes/${node}/services`)) ?? [];
    return {
      node,
      services: rows.map((r) => pick(r, ['service', 'name', 'desc', 'state', 'active-state'])),
    };
  },
});

const SERVICE_ACTIONS = ['start', 'stop', 'restart', 'reload'] as const;

/** Services whose restart or stop can cut off management access or trigger fencing. */
const CRITICAL_SERVICES = new Set([
  'pveproxy',
  'pvedaemon',
  'sshd',
  'pve-cluster',
  'corosync',
  'pve-firewall',
  'proxmox-firewall',
]);

const nodeServiceAction = defineTool({
  name: 'pve_node_service_action',
  category: 'nodes',
  title: 'Node service action',
  description:
    'Start, stop, restart or reload a system service of a node. Prefer reload over restart where the ' +
    'service supports it. Stopping a service, or restarting pveproxy, pvedaemon, sshd, pve-cluster, ' +
    'corosync or a firewall service, can cut off access or disturb the cluster and asks for ' +
    'confirmation. Waits for the task by default.',
  access: 'write',
  input: {
    node: nodeOptional,
    service: z
      .string()
      .regex(/^[A-Za-z0-9][A-Za-z0-9@._-]{0,63}$/, 'invalid service id')
      .describe('Service id from pve_node_services, for example "pveproxy" or "chrony"'),
    action: z
      .enum(SERVICE_ACTIONS)
      .describe(
        'start, stop, restart, or reload (re-read the config without restart, if supported)',
      ),
    wait: waitSchema,
  },
  needsConfirmation: (args) =>
    args.action === 'stop' || (args.action === 'restart' && CRITICAL_SERVICES.has(args.service)),
  confirmTarget: async (args, ctx) =>
    `${args.action} service ${args.service} on ${await nodeLabel(ctx, args.node)}`,
  handler: async (args, ctx) => {
    const node = await defaultNode(ctx.client, args.node);
    const data = await ctx.client.post(
      pvePath`/nodes/${node}/services/${args.service}/${args.action}`,
    );
    return taskOutcome(ctx, data, args.wait);
  },
});

/** Epoch seconds, or an ISO 8601 timestamp that is converted to epoch seconds. */
const timeSchema = z
  .union([z.number().int().min(0), z.string().min(1).max(40)])
  .describe('Unix epoch seconds or an ISO 8601 timestamp such as 2026-01-31T12:00:00Z');

function toEpoch(value: number | string | undefined, label: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value === 'number') return value;
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) throw new Error(`${label} is not a valid timestamp: ${value}`);
  return Math.floor(ms / 1000);
}

const DEFAULT_LOG_LIMIT = 100;

const nodeSyslog = defineTool({
  name: 'pve_node_syslog',
  category: 'nodes',
  title: 'Node journal',
  description:
    'Systemd journal lines of a node. Without since and until the last `limit` lines are returned ' +
    `(default ${DEFAULT_LOG_LIMIT}). With since and/or until the range is read and only the last ` +
    '`limit` lines of it are kept, narrow the range or filter by unit when lines are missing. ' +
    'unit filters by systemd unit, for example "pveproxy" or "sshd".',
  access: 'read',
  input: {
    node: nodeOptional,
    since: timeSchema.optional(),
    until: timeSchema.optional(),
    limit: z
      .number()
      .int()
      .min(1)
      .max(1000)
      .optional()
      .describe(`Maximum number of lines, default ${DEFAULT_LOG_LIMIT}`),
    unit: z
      .string()
      .regex(/^[A-Za-z0-9@:._-]{1,100}$/, 'invalid unit name')
      .optional()
      .describe('Only messages of this systemd unit (needs a recent Proxmox version)'),
  },
  handler: async (args, ctx) => {
    const node = await defaultNode(ctx.client, args.node);
    const limit = args.limit ?? DEFAULT_LOG_LIMIT;
    const since = toEpoch(args.since, 'since');
    const until = toEpoch(args.until, 'until');
    const ranged = since !== undefined || until !== undefined;
    // Proxmox rejects lastentries together with a range, so the cap is applied here for ranges.
    const data = await ctx.client.get<unknown[]>(pvePath`/nodes/${node}/journal`, {
      since,
      until,
      lastentries: ranged ? undefined : limit,
      unit: args.unit,
    });
    const lines = (Array.isArray(data) ? data : []).map((row) =>
      typeof row === 'string' ? row : String((row as { t?: unknown } | null)?.t ?? ''),
    );
    const kept = lines.length > limit ? lines.slice(lines.length - limit) : lines;
    return {
      node,
      count: kept.length,
      ...(kept.length < lines.length ? { omittedOlderLines: lines.length - kept.length } : {}),
      lines: kept,
    };
  },
});

const DISK_FIELDS = [
  'devpath',
  'model',
  'serial',
  'size',
  'type',
  'used',
  'health',
  'wearout',
  'rpm',
  'vendor',
  'gpt',
  'osdid',
  'parent',
] as const;

const nodeDisks = defineTool({
  name: 'pve_node_disks',
  category: 'nodes',
  title: 'Node disks',
  description:
    'Physical disks of a node with model, serial, size, type (ssd, hdd, nvme), usage and SMART health. ' +
    'partitions: true also lists partitions. With smartDisk (a device such as /dev/sda from the list) ' +
    'the SMART details of that disk are returned instead, healthOnly: true cuts them to the health verdict.',
  access: 'read',
  input: {
    node: nodeOptional,
    partitions: z.boolean().optional().describe('Also list partitions'),
    smartDisk: z
      .string()
      .regex(/^[A-Za-z0-9/_.:-]{1,64}$/, 'invalid device name')
      .optional()
      .describe('Device such as /dev/sda: return SMART data of this disk instead of the list'),
    healthOnly: z.boolean().optional().describe('With smartDisk: only the health status'),
  },
  handler: async (args, ctx) => {
    const node = await defaultNode(ctx.client, args.node);
    if (args.smartDisk) {
      const smart = await ctx.client.get<unknown>(pvePath`/nodes/${node}/disks/smart`, {
        disk: args.smartDisk,
        healthonly: args.healthOnly,
      });
      return { node, disk: args.smartDisk, smart };
    }
    const rows =
      (await ctx.client.get<Row[]>(pvePath`/nodes/${node}/disks/list`, {
        'include-partitions': args.partitions,
      })) ?? [];
    return { node, disks: rows.map((r) => pick(r, DISK_FIELDS)) };
  },
});

const nodeAptUpdates = defineTool({
  name: 'pve_node_apt_updates',
  category: 'nodes',
  title: 'Pending package updates',
  description:
    'Packages with an available update on a node: name, installed version, new version and priority. ' +
    'Reads the package index as last synchronized, it does not refresh it and installs nothing.',
  access: 'read',
  input: { node: nodeOptional },
  handler: async (args, ctx) => {
    const node = await defaultNode(ctx.client, args.node);
    const rows = (await ctx.client.get<Row[]>(pvePath`/nodes/${node}/apt/update`)) ?? [];
    return {
      node,
      count: rows.length,
      updates: rows.map((r) => pick(r, ['Package', 'OldVersion', 'Version', 'Priority'])),
    };
  },
});

const nodePower = defineTool({
  name: 'pve_node_power',
  category: 'nodes',
  title: 'Reboot or shut down node',
  description:
    'Reboot or shut down a whole node. Running guests are stopped or migrated according to the ' +
    'node configuration, and a shut down node does not come back without physical or out-of-band ' +
    'access. The node must be named explicitly. Returns when Proxmox accepted the command, the node ' +
    'then goes offline on its own.',
  access: 'destructive',
  input: {
    node: nodeSchema,
    command: z
      .enum(['reboot', 'shutdown'])
      .describe('reboot: restart the node. shutdown: power the node off'),
  },
  confirmTarget: (args) => `${args.command} of node ${args.node}`,
  handler: async (args, ctx) => {
    await ctx.client.post(pvePath`/nodes/${args.node}/status`, { command: args.command });
    return { node: args.node, command: args.command, accepted: true };
  },
});

export const nodeTools: AnyToolDef[] = [
  nodeList,
  nodeStatus,
  nodeRrd,
  nodeServices,
  nodeServiceAction,
  nodeSyslog,
  nodeDisks,
  nodeAptUpdates,
  nodePower,
];
