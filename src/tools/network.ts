import { z } from 'zod';
import { pvePath } from '../proxmox/path.js';
import { taskOutcome } from '../proxmox/tasks.js';
import { defineTool, type AnyToolDef } from '../server/registry.js';
import { nodeSchema, waitSchema } from './common.js';
import { defaultNode, mergeOptions, type ReservedOptions } from './resolve-node.js';

const nodeOptional = nodeSchema
  .optional()
  .describe('Node name. Optional when the host has exactly one node.');

/** Linux interface names are at most 15 characters, aliases may carry a ":" suffix. */
const ifaceSchema = z
  .string()
  .regex(/^[A-Za-z][A-Za-z0-9_.:-]{0,14}$/, 'invalid interface name')
  .describe('Interface name, for example "vmbr1", "bond0" or "eno1.100"');

const IFACE_TYPES = [
  'bridge',
  'bond',
  'eth',
  'alias',
  'vlan',
  'OVSBridge',
  'OVSBond',
  'OVSPort',
  'OVSIntPort',
  'fabric',
  'vnet',
  'unknown',
] as const;

const LIST_TYPES = [
  'bridge',
  'bond',
  'eth',
  'alias',
  'vlan',
  'fabric',
  'OVSBridge',
  'OVSBond',
  'OVSPort',
  'OVSIntPort',
  'vnet',
  'any_bridge',
  'any_local_bridge',
  'include_sdn',
] as const;

const STAGED_NOTE =
  'The change is only staged in /etc/network/interfaces.new. It does not take effect until ' +
  'pve_network_apply runs, and pve_network_revert discards it.';

type Row = Record<string, unknown>;

const networkList = defineTool({
  name: 'pve_network_list',
  category: 'network',
  title: 'List network interfaces',
  description:
    'Network interfaces of a node: bridges, bonds, VLANs, physical NICs with addresses, gateway, ' +
    'bridge ports, bond slaves and whether they are active. type narrows the list. ' +
    'Staged changes that are not applied yet are returned as pendingChanges (the diff between ' +
    '/etc/network/interfaces and interfaces.new as Proxmox reports it), and hasPending is true then. ' +
    'Use it before pve_network_set and pve_network_apply.',
  access: 'read',
  input: {
    node: nodeOptional,
    type: z.enum(LIST_TYPES).optional().describe('Only interfaces of this type'),
  },
  handler: async (args, ctx) => {
    const node = await defaultNode(ctx.client, args.node);
    // The staged diff is a top level "changes" field next to "data".
    const { data, meta } = await ctx.client.getEnvelope<Row[]>(pvePath`/nodes/${node}/network`, {
      type: args.type,
    });
    const rows = Array.isArray(data) ? data : [];
    const changes =
      meta.changes === undefined || meta.changes === null || meta.changes === ''
        ? undefined
        : meta.changes;
    const hasPending =
      changes !== undefined || rows.some((r) => r.pending !== undefined || r.changes !== undefined);
    return {
      node,
      count: rows.length,
      hasPending,
      ...(changes !== undefined ? { pendingChanges: changes } : {}),
      interfaces: rows,
    };
  },
});

/** Keys that identify the call or have their own argument, extra may not set them. */
const NETWORK_RESERVED: ReservedOptions = {
  iface: 'Use the iface argument.',
  type: 'Use the type argument.',
  node: 'Use the node argument.',
  delete: 'Use the delete argument.',
  digest: 'Not supported by this tool.',
};

const networkSet = defineTool({
  name: 'pve_network_set',
  category: 'network',
  title: 'Create or update network interface',
  description:
    'Stage a node network interface. Without update a new interface is created (iface and type ' +
    'required), with update: true an existing one is changed (type is read from the current ' +
    'config when omitted, fields not given stay as they are, `delete` removes settings). ' +
    STAGED_NOTE +
    ' Address: address with netmask, or cidr (for example 192.0.2.10/24). Bridges take bridge_ports ' +
    '(space separated) and bridge_vlan_aware, bonds take slaves, bond_mode and bond-primary, VLAN ' +
    'interfaces take vlan-id and vlan-raw-device. `extra` passes further Proxmox options ' +
    '(ovs_*, bond_xmit_hash_policy, bridge_vids, address6, netmask6, comments6). ' +
    'Check the result with pve_network_list before applying, a wrong gateway or bridge port cuts the host off.',
  access: 'write',
  input: {
    node: nodeOptional,
    iface: ifaceSchema,
    update: z
      .boolean()
      .optional()
      .describe('true: change an existing interface instead of creating'),
    type: z.enum(IFACE_TYPES).optional().describe('Interface type, required when creating'),
    address: z.string().max(64).optional().describe('IPv4 address, use with netmask'),
    netmask: z.string().max(64).optional().describe('IPv4 netmask, for example 255.255.255.0'),
    cidr: z
      .string()
      .max(64)
      .optional()
      .describe('IPv4 address with prefix, for example 192.0.2.10/24'),
    cidr6: z.string().max(100).optional().describe('IPv6 address with prefix'),
    gateway: z.string().max(64).optional().describe('IPv4 default gateway, for example 192.0.2.1'),
    gateway6: z.string().max(100).optional().describe('IPv6 default gateway address'),
    autostart: z.boolean().optional().describe('Bring the interface up on boot'),
    bridge_ports: z.string().max(200).optional().describe('Bridge ports, space separated'),
    bridge_vlan_aware: z
      .boolean()
      .optional()
      .describe('Make the bridge VLAN aware, so guest NICs can carry VLAN tags'),
    'bond-primary': z
      .string()
      .max(64)
      .optional()
      .describe('Primary slave of an active-backup bond'),
    bond_mode: z
      .enum([
        'balance-rr',
        'active-backup',
        'balance-xor',
        'broadcast',
        '802.3ad',
        'balance-tlb',
        'balance-alb',
        'balance-slb',
        'lacp-balance-slb',
        'lacp-balance-tcp',
      ])
      .optional()
      .describe('Bond mode, for example active-backup, or 802.3ad for LACP'),
    slaves: z.string().max(200).optional().describe('Bond slave interfaces, space separated'),
    'vlan-id': z.number().int().min(1).max(4094).optional().describe('VLAN tag, 1 to 4094'),
    'vlan-raw-device': z.string().max(64).optional().describe('Parent interface of a VLAN'),
    mtu: z.number().int().min(68).max(65535).optional().describe('MTU in bytes, 68 to 65535'),
    comments: z.string().max(500).optional().describe('Comment stored with the interface'),
    extra: z
      .record(z.string(), z.union([z.string(), z.number(), z.boolean()]))
      .optional()
      .describe('Further Proxmox network options by name'),
    delete: z
      .array(z.string().regex(/^[A-Za-z][A-Za-z0-9_-]*$/))
      .max(30)
      .optional()
      .describe('update only: settings to remove, for example ["gateway", "comments"]'),
  },
  handler: async (args, ctx) => {
    const node = await defaultNode(ctx.client, args.node);
    const update = args.update === true;
    if (!update && args.delete?.length) {
      throw new Error('delete only applies together with update: true.');
    }
    if (!update && !args.type) {
      throw new Error(
        'type is required when creating an interface. Pass update: true to change one.',
      );
    }

    const params: Record<string, string | number | boolean | undefined> = {
      address: args.address,
      netmask: args.netmask,
      cidr: args.cidr,
      cidr6: args.cidr6,
      gateway: args.gateway,
      gateway6: args.gateway6,
      autostart: args.autostart,
      bridge_ports: args.bridge_ports,
      bridge_vlan_aware: args.bridge_vlan_aware,
      'bond-primary': args['bond-primary'],
      bond_mode: args.bond_mode,
      slaves: args.slaves,
      'vlan-id': args['vlan-id'],
      'vlan-raw-device': args['vlan-raw-device'],
      mtu: args.mtu,
      comments: args.comments,
    };
    mergeOptions(params, args.extra, 'pve_network_set', { reserved: NETWORK_RESERVED });

    if (!update) {
      await ctx.client.post(pvePath`/nodes/${node}/network`, {
        iface: args.iface,
        type: args.type,
        ...params,
      });
      return { node, iface: args.iface, action: 'created', staged: true, note: STAGED_NOTE };
    }

    // PUT requires the type, and it cannot change, so it is read from the current config.
    let type = args.type;
    if (!type) {
      const current = await ctx.client.get<{ type?: string }>(
        pvePath`/nodes/${node}/network/${args.iface}`,
      );
      type = current?.type as typeof args.type;
      if (!type) throw new Error(`Could not read the type of interface ${args.iface}. Pass type.`);
    }
    await ctx.client.put(pvePath`/nodes/${node}/network/${args.iface}`, {
      type,
      ...params,
      delete: args.delete?.length ? args.delete.join(',') : undefined,
    });
    return { node, iface: args.iface, action: 'updated', staged: true, note: STAGED_NOTE };
  },
});

const networkDelete = defineTool({
  name: 'pve_network_delete',
  category: 'network',
  title: 'Delete network interface',
  description:
    'Stage the removal of a node network interface. ' +
    STAGED_NOTE +
    ' Do not remove the bridge or NIC that carries the management address.',
  access: 'write',
  input: { node: nodeOptional, iface: ifaceSchema },
  handler: async (args, ctx) => {
    const node = await defaultNode(ctx.client, args.node);
    await ctx.client.delete(pvePath`/nodes/${node}/network/${args.iface}`);
    return { node, iface: args.iface, action: 'deleted', staged: true, note: STAGED_NOTE };
  },
});

const networkApply = defineTool({
  name: 'pve_network_apply',
  category: 'network',
  title: 'Apply network changes',
  description:
    'Apply all staged network changes of a node (ifreload). WARNING: a wrong or incomplete ' +
    'configuration can drop the management connection and make the node unreachable, including for ' +
    'this tool. Review pve_network_list first, and set wait: false when the change touches the address ' +
    'this server connects to. Revert staged changes with pve_network_revert instead. The node must be ' +
    'named explicitly.',
  access: 'destructive',
  input: { node: nodeSchema, wait: waitSchema },
  confirmTarget: (args) => `apply staged network changes on node ${args.node}`,
  handler: async (args, ctx) => {
    const data = await ctx.client.put(pvePath`/nodes/${args.node}/network`);
    return taskOutcome(ctx, data, args.wait);
  },
});

const networkRevert = defineTool({
  name: 'pve_network_revert',
  category: 'network',
  title: 'Revert staged network changes',
  description:
    'Discard all staged, not yet applied network changes of a node. The running network and the ' +
    'active configuration are not touched.',
  access: 'write',
  input: { node: nodeOptional },
  handler: async (args, ctx) => {
    const node = await defaultNode(ctx.client, args.node);
    await ctx.client.delete(pvePath`/nodes/${node}/network`);
    return { node, reverted: true };
  },
});

export const networkTools: AnyToolDef[] = [
  networkList,
  networkSet,
  networkDelete,
  networkApply,
  networkRevert,
];
