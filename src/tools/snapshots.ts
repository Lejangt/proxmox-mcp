import { z } from 'zod';
import { guestPath, resolveGuest, type GuestRef, type GuestType } from '../proxmox/guests.js';
import { pvePath } from '../proxmox/path.js';
import { taskOutcome } from '../proxmox/tasks.js';
import { defineTool, type AnyToolDef, type ToolContext } from '../server/registry.js';
import { guestTypeSchema, nodeSchema, vmidSchema, waitSchema } from './common.js';
import { isoTime } from './resolve-node.js';
import { guestLabel } from './targets.js';

const guestTarget = {
  vmid: vmidSchema,
  node: nodeSchema
    .optional()
    .describe('Node the guest runs on. Optional, found from the VMID when omitted.'),
  type: guestTypeSchema
    .optional()
    .describe('qemu (VM) or lxc (container). Optional, found from the VMID.'),
};

const snapnameSchema = z
  .string()
  .regex(/^[A-Za-z][A-Za-z0-9_-]*$/, 'letters, digits, "-" and "_", starting with a letter')
  .max(40)
  .describe('Snapshot name: letters, digits, "-" and "_", starting with a letter');

function target(
  ctx: ToolContext,
  args: { vmid: number; node?: string | undefined; type?: GuestType | undefined },
): Promise<GuestRef> {
  return resolveGuest(ctx.client, args.vmid, {
    ...(args.node ? { node: args.node } : {}),
    ...(args.type ? { type: args.type } : {}),
  });
}

interface SnapshotRow {
  name?: string;
  description?: string;
  snaptime?: number;
  parent?: string;
  vmstate?: number | boolean;
  running?: number | boolean;
}

const snapshotList = defineTool({
  name: 'pve_snapshot_list',
  category: 'snapshots',
  title: 'List snapshots',
  description:
    'Snapshots of a VM or container with name, description, time, parent and whether RAM state is ' +
    'included. currentParent is the snapshot the live guest is based on.',
  access: 'read',
  input: guestTarget,
  handler: async (args, ctx) => {
    const g = await target(ctx, args);
    const rows = (await ctx.client.get<SnapshotRow[]>(guestPath(g, '/snapshot'))) ?? [];
    // Proxmox lists the live state as a pseudo snapshot named "current".
    const current = rows.find((r) => r.name === 'current');
    return {
      node: g.node,
      type: g.type,
      currentParent: current?.parent,
      snapshots: rows
        .filter((r) => r.name !== 'current')
        .map((r) => ({
          name: r.name,
          description: r.description || undefined,
          time: isoTime(r.snaptime),
          parent: r.parent,
          vmstate: Boolean(r.vmstate),
        })),
    };
  },
});

const snapshotCreate = defineTool({
  name: 'pve_snapshot_create',
  category: 'snapshots',
  title: 'Create snapshot',
  description:
    'Create a snapshot of a VM or container. vmstate: true also saves the RAM of a running VM so a ' +
    'rollback resumes the running state (VMs only, needs more space and time). Snapshots need storage ' +
    'that supports them (LVM-thin, ZFS, qcow2, Ceph) and are not backups.',
  access: 'write',
  input: {
    ...guestTarget,
    snapname: snapnameSchema,
    description: z.string().optional().describe('Free text description of the snapshot'),
    vmstate: z.boolean().optional().describe('VM only: include RAM state'),
    wait: waitSchema,
  },
  handler: async (args, ctx) => {
    const g = await target(ctx, args);
    if (args.vmstate && g.type === 'lxc') {
      throw new Error('vmstate is not supported for containers.');
    }
    const data = await ctx.client.post(guestPath(g, '/snapshot'), {
      snapname: args.snapname,
      description: args.description,
      ...(g.type === 'qemu' ? { vmstate: args.vmstate } : {}),
    });
    return taskOutcome(ctx, data, args.wait);
  },
});

const snapshotRollback = defineTool({
  name: 'pve_snapshot_rollback',
  category: 'snapshots',
  title: 'Roll back to snapshot',
  description:
    'Roll a guest back to a snapshot. All changes since the snapshot are lost, and snapshots newer ' +
    'than the target are removed. start: true boots the guest afterwards.',
  access: 'destructive',
  input: {
    ...guestTarget,
    snapname: snapnameSchema,
    start: z.boolean().optional().describe('Start the guest after the rollback'),
    wait: waitSchema,
  },
  confirmTarget: async (args, ctx) =>
    `roll back ${await guestLabel(ctx, args)} to snapshot "${args.snapname}", later changes are lost`,
  handler: async (args, ctx) => {
    const g = await target(ctx, args);
    const data = await ctx.client.post(guestPath(g, pvePath`/snapshot/${args.snapname}/rollback`), {
      start: args.start,
    });
    return taskOutcome(ctx, data, args.wait);
  },
});

const snapshotDelete = defineTool({
  name: 'pve_snapshot_delete',
  category: 'snapshots',
  title: 'Delete snapshot',
  description:
    'Delete a snapshot. force: true removes the snapshot from the config even if deleting its disk ' +
    'data fails, which can leave orphaned volumes behind. Use only after a normal delete failed.',
  access: 'destructive',
  input: {
    ...guestTarget,
    snapname: snapnameSchema,
    force: z
      .boolean()
      .optional()
      .describe('Remove the snapshot from the config even if deleting its disk data fails'),
    wait: waitSchema,
  },
  confirmTarget: async (args, ctx) =>
    `delete snapshot "${args.snapname}" of ${await guestLabel(ctx, args)}` +
    (args.force ? ' (force: drop it from the config even if its data cannot be deleted)' : ''),
  handler: async (args, ctx) => {
    const g = await target(ctx, args);
    const data = await ctx.client.delete(guestPath(g, pvePath`/snapshot/${args.snapname}`), {
      force: args.force,
    });
    return taskOutcome(ctx, data, args.wait);
  },
});

export const snapshotTools: AnyToolDef[] = [
  snapshotList,
  snapshotCreate,
  snapshotRollback,
  snapshotDelete,
];
