import { z } from 'zod';
import { defineTool, type AnyToolDef } from '../server/registry.js';
import { nodeSchema } from './common.js';

/** Fields kept per resource unless `full` is requested, enough to pick and judge a resource. */
const BRIEF_FIELDS = [
  'id',
  'type',
  'node',
  'vmid',
  'name',
  'status',
  'pool',
  'tags',
  'template',
  'lock',
  'hastate',
  'cpu',
  'maxcpu',
  'mem',
  'maxmem',
  'disk',
  'maxdisk',
  'uptime',
  'storage',
  'plugintype',
  'content',
  'shared',
] as const;

type Resource = Record<string, unknown>;

function brief(r: Resource): Resource {
  const out: Resource = {};
  for (const key of BRIEF_FIELDS) if (r[key] !== undefined) out[key] = r[key];
  return out;
}

export const clusterTools: AnyToolDef[] = [
  defineTool({
    name: 'pve_cluster_status',
    category: 'cluster',
    title: 'Cluster status',
    description:
      'Cluster membership: cluster name, quorum, and every node with online state and IP. On a standalone node it lists just that node.',
    access: 'read',
    input: {},
    handler: (_args, ctx) => ctx.client.get('/cluster/status'),
  }),

  defineTool({
    name: 'pve_cluster_resources',
    category: 'cluster',
    title: 'Cluster resources',
    description:
      'List resources across the whole cluster with usage: VMs and containers, storages, nodes, pools. ' +
      'Filter with type, node and status to keep the output small. ' +
      'Returns a compact set of fields per resource, set full=true for everything Proxmox reports. ' +
      'Use it to find which node a guest runs on or what is running.',
    access: 'read',
    input: {
      type: z
        .enum(['vm', 'qemu', 'lxc', 'storage', 'node', 'sdn', 'pool'])
        .optional()
        .describe('Resource type. vm means qemu and lxc together. Omit for all types.'),
      node: nodeSchema.optional().describe('Only resources on this node'),
      status: z
        .string()
        .max(32)
        .optional()
        .describe(
          'Only resources with this status, for example running, stopped, online, available',
        ),
      full: z.boolean().optional().describe('Return all fields instead of the compact set'),
    },
    handler: async (args, ctx) => {
      // Proxmox filters server side for vm, storage, node and sdn only, the rest is filtered here.
      const serverTypes = ['vm', 'storage', 'node', 'sdn'];
      const params = args.type && serverTypes.includes(args.type) ? { type: args.type } : undefined;
      const rows = await ctx.client.get<Resource[]>('/cluster/resources', params);
      let list = Array.isArray(rows) ? rows : [];
      if (args.type && !serverTypes.includes(args.type)) {
        list = list.filter((r) => r.type === args.type);
      }
      if (args.node) list = list.filter((r) => r.node === args.node);
      if (args.status) list = list.filter((r) => r.status === args.status);
      return { count: list.length, resources: args.full ? list : list.map(brief) };
    },
  }),

  defineTool({
    name: 'pve_next_vmid',
    category: 'cluster',
    title: 'Next free VMID',
    description:
      'Get the next free VMID of the cluster, to use when creating a VM or container. ' +
      'With vmid set, checks whether that VMID is free instead (errors if it is in use).',
    access: 'read',
    input: {
      vmid: z.number().int().min(100).max(999999999).optional().describe('Check this VMID instead'),
    },
    handler: async (args, ctx) => {
      const data = await ctx.client.get<string | number>(
        '/cluster/nextid',
        args.vmid === undefined ? undefined : { vmid: args.vmid },
      );
      return { vmid: Number(data) };
    },
  }),

  defineTool({
    name: 'pve_cluster_log',
    category: 'cluster',
    title: 'Cluster log',
    description:
      'Recent cluster log entries (task starts and ends, user actions, errors) across all nodes, newest first.',
    access: 'read',
    input: {
      max: z
        .number()
        .int()
        .min(1)
        .max(500)
        .optional()
        .describe('Maximum number of entries, default 50'),
    },
    handler: (args, ctx) => ctx.client.get('/cluster/log', { max: args.max ?? 50 }),
  }),
];
