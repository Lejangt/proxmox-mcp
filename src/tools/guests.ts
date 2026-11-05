import { z } from 'zod';
import { guestPath, resolveGuest, type GuestRef, type GuestType } from '../proxmox/guests.js';
import { pvePath } from '../proxmox/path.js';
import { taskOutcome } from '../proxmox/tasks.js';
import type { Params, ProxmoxClient } from '../proxmox/types.js';
import { defineTool, type AnyToolDef, type ToolContext } from '../server/registry.js';
import {
  configValueSchema,
  guestTypeSchema,
  nodeSchema,
  storageIdSchema,
  timeframeSchema,
  vmidSchema,
  waitSchema,
} from './common.js';
import { defaultNode, mergeOptions, splitList, type ReservedOptions } from './resolve-node.js';
import { guestLabel, jsonText, quote } from './targets.js';

type Scalar = string | number | boolean;

/** Arguments that identify a guest. Node and type are looked up from the VMID when missing. */
const guestTarget = {
  vmid: vmidSchema,
  node: nodeSchema
    .optional()
    .describe('Node the guest runs on. Optional, found from the VMID when omitted.'),
  type: guestTypeSchema
    .optional()
    .describe('qemu (VM) or lxc (container). Optional, found from the VMID.'),
};

function target(
  ctx: ToolContext,
  args: { vmid: number; node?: string | undefined; type?: GuestType | undefined },
): Promise<GuestRef> {
  return resolveGuest(ctx.client, args.vmid, {
    ...(args.node ? { node: args.node } : {}),
    ...(args.type ? { type: args.type } : {}),
  });
}

function requireType(g: GuestRef, type: GuestType, what: string): void {
  if (g.type !== type) {
    throw new Error(
      `${what} only works for ${type === 'qemu' ? 'QEMU VMs' : 'LXC containers'}, but ${g.vmid} is ${g.type}.`,
    );
  }
}

/** Rejects the given options when the guest has this type, because they do not exist for it, instead of letting Proxmox fail on them. */
function forbidFor(g: GuestRef, type: GuestType, given: Record<string, unknown>): void {
  if (g.type !== type) return;
  const bad = Object.entries(given)
    .filter(([, v]) => v !== undefined)
    .map(([k]) => k);
  if (bad.length > 0) {
    throw new Error(
      `${bad.join(', ')} is not supported for ${type === 'qemu' ? 'VMs' : 'containers'}.`,
    );
  }
}

// Proxmox accepts the sshkeys value of a VM only in percent-encoded form and
// rejects every character outside this set.
const SSHKEYS_SAFE = /^[-%a-zA-Z0-9_.!~*'()]*$/;

/**
 * Encodes a QEMU sshkeys value the way Proxmox expects it. Plain text (spaces,
 * newlines, plus signs) is percent-encoded, a value that already consists only
 * of allowed characters is treated as encoded and left alone.
 */
export function encodeSshKeys(value: string): string {
  return SSHKEYS_SAFE.test(value) ? value : encodeURIComponent(value);
}

function encodeForQemu(key: string, value: Scalar): Scalar {
  return key === 'sshkeys' && typeof value === 'string' ? encodeSshKeys(value) : value;
}

/** The given VMID or the next free one of the cluster. */
async function nextVmid(client: ProxmoxClient, vmid?: number): Promise<number> {
  if (vmid !== undefined) return vmid;
  const id = await client.get<string | number>('/cluster/nextid');
  const n = Number(id);
  if (!Number.isInteger(n)) throw new Error('Proxmox did not return a usable next VMID.');
  return n;
}

function joinList(list: string[] | undefined): string | undefined {
  return list && list.length > 0 ? list.join(',') : undefined;
}

/** Config keys that hold a volume: deleting them detaches or (unusedN, force) destroys data. */
const QEMU_DISK_CONFIG_KEY =
  /^(?:(?:ide|sata|scsi|virtio|unused)\d+|efidisk\d+|tpmstate\d+|vmstate)$/;
const LXC_DISK_CONFIG_KEY = /^(?:rootfs|mp\d+|unused\d+)$/;

/**
 * The disk keys in a delete list, split like Proxmox splits it (splitList,
 * which refuses control characters). The guest type is not known before the
 * lookup, so the keys of both types count.
 */
export function diskKeysIn(list: readonly string[] | undefined): string[] {
  return splitList(list, 'delete').filter(
    (key) => QEMU_DISK_CONFIG_KEY.test(key) || LXC_DISK_CONFIG_KEY.test(key),
  );
}

const RESTORE_HINT = 'Restoring a backup can replace an existing guest, use pve_backup_restore.';

/**
 * Create options that turn a create into a restore or let it overwrite an
 * existing guest. pve_backup_restore is the only, confirmed way to do that.
 */
const CREATE_RESERVED: ReservedOptions = {
  archive: RESTORE_HINT,
  restore: RESTORE_HINT,
  'live-restore': RESTORE_HINT,
  unique: RESTORE_HINT,
  force: 'Overwriting an existing guest is only possible through pve_backup_restore.',
};

/** Returns true when an LXC ostemplate names a backup archive instead of a template. */
export function isBackupVolume(volid: string): boolean {
  return /(?:^|[/:])vzdump-/.test(volid) || /:backup\//.test(volid);
}

// ---------------------------------------------------------------------------
// Read tools
// ---------------------------------------------------------------------------

interface ResourceRow {
  vmid?: number;
  name?: string;
  node?: string;
  type?: string;
  status?: string;
  cpu?: number;
  maxcpu?: number;
  mem?: number;
  maxmem?: number;
  disk?: number;
  maxdisk?: number;
  uptime?: number;
  tags?: string;
  template?: number | boolean;
  pool?: string;
}

function splitTags(tags: string | undefined): string[] {
  return (tags ?? '')
    .split(/[;,\s]+/)
    .map((t) => t.trim())
    .filter(Boolean);
}

const guestList = defineTool({
  name: 'pve_guest_list',
  category: 'guests',
  title: 'List guests',
  description:
    'List QEMU VMs and LXC containers of the whole cluster with status and usage. ' +
    'Use it to find a VMID, node or type. Filters: node, type, status (running, stopped), pool, ' +
    'tag, template (true: only templates, false: no templates). Memory and disk values are bytes, ' +
    'cpu is a fraction of maxcpu.',
  access: 'read',
  input: {
    node: nodeSchema.optional().describe('Only guests on this node'),
    type: guestTypeSchema.optional(),
    status: z
      .enum(['running', 'stopped', 'paused'])
      .optional()
      .describe('Only guests in this state: running, stopped or paused'),
    pool: z.string().optional().describe('Only members of this resource pool'),
    tag: z.string().optional().describe('Only guests carrying this tag (case insensitive)'),
    template: z.boolean().optional().describe('true: only templates, false: hide templates'),
  },
  handler: async (args, ctx) => {
    const rows = (await ctx.client.get<ResourceRow[]>('/cluster/resources', { type: 'vm' })) ?? [];
    const tag = args.tag?.toLowerCase();
    return rows
      .filter((r) => r.type === 'qemu' || r.type === 'lxc')
      .filter((r) => !args.node || r.node === args.node)
      .filter((r) => !args.type || r.type === args.type)
      .filter((r) => !args.status || r.status === args.status)
      .filter((r) => !args.pool || r.pool === args.pool)
      .filter((r) => !tag || splitTags(r.tags).some((t) => t.toLowerCase() === tag))
      .filter((r) => args.template === undefined || Boolean(r.template) === args.template)
      .sort((a, b) => (a.vmid ?? 0) - (b.vmid ?? 0))
      .map((r) => ({
        vmid: r.vmid,
        name: r.name,
        node: r.node,
        type: r.type,
        status: r.status,
        cpu: r.cpu,
        maxcpu: r.maxcpu,
        mem: r.mem,
        maxmem: r.maxmem,
        disk: r.disk,
        maxdisk: r.maxdisk,
        uptime: r.uptime,
        tags: splitTags(r.tags),
        template: Boolean(r.template),
        pool: r.pool,
      }));
  },
});

const guestStatus = defineTool({
  name: 'pve_guest_status',
  category: 'guests',
  title: 'Guest status',
  description:
    'Current runtime status of one VM or container: state, uptime, CPU, memory, disk, network ' +
    'counters, HA state. For the configuration use pve_guest_config.',
  access: 'read',
  input: guestTarget,
  handler: async (args, ctx) => {
    const g = await target(ctx, args);
    const status = await ctx.client.get<Record<string, unknown>>(guestPath(g, '/status/current'));
    return { node: g.node, type: g.type, ...status };
  },
});

const guestConfig = defineTool({
  name: 'pve_guest_config',
  category: 'guests',
  title: 'Guest configuration',
  description:
    'Configuration of a VM or container (cores, memory, disks, network, cloud-init, tags, ...). ' +
    'With pending: true only the changes that are not applied yet are returned (they take effect ' +
    'after a restart). With current: true the running values are returned instead of pending ones. ' +
    'The digest in the result can be passed to pve_guest_update_config to detect concurrent edits.',
  access: 'read',
  input: {
    ...guestTarget,
    pending: z
      .boolean()
      .optional()
      .describe('Return the pending changes list instead of the config'),
    current: z.boolean().optional().describe('Show running values instead of pending ones'),
  },
  handler: async (args, ctx) => {
    const g = await target(ctx, args);
    if (args.pending) return ctx.client.get(guestPath(g, '/pending'));
    return ctx.client.get(guestPath(g, '/config'), { current: args.current });
  },
});

type RrdRow = Record<string, number | null | undefined>;

function round(n: number): number {
  return Number(n.toPrecision(6));
}

/** Min, average, max and latest value per metric plus the last few raw points. */
export function summarizeRrd(rows: RrdRow[], recent = 5): Record<string, unknown> {
  const keys = new Set<string>();
  for (const row of rows) for (const k of Object.keys(row)) if (k !== 'time') keys.add(k);
  const metrics: Record<string, { min: number; avg: number; max: number; last: number }> = {};
  for (const key of keys) {
    const values = rows
      .map((r) => r[key])
      .filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
    if (values.length === 0) continue;
    const sum = values.reduce((a, b) => a + b, 0);
    metrics[key] = {
      min: round(Math.min(...values)),
      avg: round(sum / values.length),
      max: round(Math.max(...values)),
      last: round(values[values.length - 1] as number),
    };
  }
  const times = rows.map((r) => r.time).filter((t): t is number => typeof t === 'number');
  const iso = (t: number | undefined): string | undefined =>
    t === undefined ? undefined : new Date(t * 1000).toISOString();
  return {
    points: rows.length,
    from: iso(times[0]),
    to: iso(times[times.length - 1]),
    metrics,
    recent: rows.slice(-recent).map((r) => {
      const out: Record<string, unknown> = { time: iso(r.time ?? undefined) };
      for (const [k, v] of Object.entries(r)) {
        if (k !== 'time' && typeof v === 'number') out[k] = round(v);
      }
      return out;
    }),
  };
}

const guestRrd = defineTool({
  name: 'pve_guest_rrd',
  category: 'guests',
  title: 'Guest metrics',
  description:
    'CPU, memory, disk and network metrics of a guest over a timeframe (hour, day, week, month, year). ' +
    'The result is condensed to min, avg, max and latest per metric plus the last 5 points. ' +
    'cf AVERAGE (default) or MAX (peaks).',
  access: 'read',
  input: {
    ...guestTarget,
    timeframe: timeframeSchema,
    cf: z.enum(['AVERAGE', 'MAX']).optional().describe('Consolidation function, default AVERAGE'),
  },
  handler: async (args, ctx) => {
    const g = await target(ctx, args);
    const cf = args.cf ?? 'AVERAGE';
    const rows =
      (await ctx.client.get<RrdRow[]>(guestPath(g, '/rrddata'), {
        timeframe: args.timeframe,
        cf,
      })) ?? [];
    return { node: g.node, type: g.type, timeframe: args.timeframe, cf, ...summarizeRrd(rows) };
  },
});

// ---------------------------------------------------------------------------
// Power, configuration, disks
// ---------------------------------------------------------------------------

const POWER_ACTIONS = [
  'start',
  'shutdown',
  'reboot',
  'suspend',
  'resume',
  'stop',
  'reset',
] as const;

const guestPower = defineTool({
  name: 'pve_guest_power',
  category: 'guests',
  title: 'Guest power action',
  description:
    'Change the power state of a VM or container. start, shutdown (clean, via ACPI or the container init), ' +
    'reboot, suspend and resume are always allowed. stop (hard power off) and reset (hard reset, VMs only) ' +
    'can lose data and need force: true, prefer shutdown. shutdown accepts timeout (seconds) and forceStop ' +
    '(hard stop after the timeout). reboot accepts timeout. Waits for the task by default.',
  access: 'write',
  input: {
    ...guestTarget,
    action: z
      .enum(POWER_ACTIONS)
      .describe(
        'start, shutdown (clean, via ACPI or container init), reboot, suspend, resume, stop (hard power off, needs force: true), or reset (hard, VMs only, needs force: true)',
      ),
    force: z.boolean().optional().describe('Required for stop and reset'),
    timeout: z
      .number()
      .int()
      .min(1)
      .max(3600)
      .optional()
      .describe('Seconds, for shutdown and reboot'),
    forceStop: z.boolean().optional().describe('shutdown only: hard stop when the timeout expires'),
    wait: waitSchema,
  },
  handler: async (args, ctx) => {
    const g = await target(ctx, args);
    if ((args.action === 'stop' || args.action === 'reset') && args.force !== true) {
      throw new Error(
        `${args.action} cuts the power of the guest without a clean shutdown and can lose data. ` +
          'Use action shutdown instead, or repeat the call with force: true if a hard stop is really intended.',
      );
    }
    if (args.action === 'reset' && g.type === 'lxc') {
      throw new Error(
        'Containers have no reset. Use action reboot, or stop with force: true and start.',
      );
    }
    const params: Params = {};
    if (args.action === 'shutdown' || args.action === 'reboot') params.timeout = args.timeout;
    if (args.action === 'shutdown') params.forceStop = args.forceStop;
    const data = await ctx.client.post(guestPath(g, pvePath`/status/${args.action}`), params);
    return taskOutcome(ctx, data, args.wait);
  },
});

const UPDATE_RESERVED: ReservedOptions = {
  delete: 'It is not a config key, use the delete argument.',
  revert: 'It is not a config key, use the revert argument.',
  digest: 'It is not a config key, use the digest argument.',
  force:
    'force makes Proxmox destroy the volumes of deleted disk keys without asking. Delete disks ' +
    'without force (they become unusedN) and delete unusedN afterwards.',
};

const guestUpdateConfig = defineTool({
  name: 'pve_guest_update_config',
  category: 'guests',
  title: 'Update guest configuration',
  description:
    'Change the configuration of a VM or container. set: key/value pairs such as cores, memory, ' +
    'net0 ("virtio,bridge=vmbr0"), scsi0, tags (semicolon separated), onboot, description, ciuser. ' +
    'delete: keys to remove. revert: pending keys to discard. digest: from pve_guest_config, rejects the ' +
    'change when the config changed meanwhile. Many changes only apply after a restart (see pve_guest_config ' +
    'with pending: true). A VM sshkeys value may be plain text, it is URL-encoded as Proxmox requires. ' +
    'Booleans are sent as 1 or 0. Deleting a disk key (ide/sata/scsi/virtio/efidisk/tpmstate/unused ' +
    'and vmstate for VMs, rootfs/mp/unused for containers) asks the user first, unusedN deletes the ' +
    'volume. ' +
    'force is not accepted in set.',
  access: 'write',
  input: {
    ...guestTarget,
    set: z.record(z.string(), configValueSchema).optional().describe('Keys to set'),
    delete: z
      .array(z.string())
      .optional()
      .describe(
        'Keys to delete. Deleting a disk key (scsi0, unused0, rootfs, mp0, ...) asks first',
      ),
    revert: z.array(z.string()).optional().describe('Pending keys to revert'),
    digest: z.string().max(64).optional().describe('Config digest for optimistic locking'),
    wait: waitSchema,
  },
  needsConfirmation: (args) => diskKeysIn(args.delete).length > 0,
  confirmTarget: async (args, ctx) =>
    `delete ${diskKeysIn(args.delete).join(', ')} from ${await guestLabel(ctx, args)}`,
  handler: async (args, ctx) => {
    const g = await target(ctx, args);
    const params: Record<string, Scalar | undefined> = {};
    mergeOptions(params, args.set, 'set', {
      ...(g.type === 'qemu' ? { transform: encodeForQemu } : {}),
      reserved: UPDATE_RESERVED,
    });
    params.delete = joinList(splitList(args.delete, 'delete'));
    params.revert = joinList(args.revert);
    params.digest = args.digest;
    if (Object.values(params).every((v) => v === undefined)) {
      throw new Error('Nothing to change: pass set, delete or revert.');
    }
    const data = await ctx.client.put(guestPath(g, '/config'), params);
    return taskOutcome(ctx, data ?? { updated: true }, args.wait);
  },
});

const guestResizeDisk = defineTool({
  name: 'pve_guest_resize_disk',
  category: 'guests',
  title: 'Resize guest disk',
  description:
    'Grow a disk of a VM (scsi0, virtio0, sata0, ide0) or container (rootfs, mp0). size is relative ' +
    '("+10G") or an absolute target ("50G"). Disks can only grow. Afterwards the partition and ' +
    'filesystem inside a VM still need to be extended.',
  access: 'write',
  input: {
    ...guestTarget,
    disk: z.string().min(1).describe('Disk key such as scsi0, virtio0, rootfs or mp0'),
    size: z
      .string()
      .regex(/^\+?\d+(\.\d+)?[KMGT]?$/, 'use a size such as +10G or 50G')
      .describe('"+10G" to grow by 10 GiB, "50G" to grow to 50 GiB'),
    wait: waitSchema,
  },
  handler: async (args, ctx) => {
    const g = await target(ctx, args);
    const data = await ctx.client.put(guestPath(g, '/resize'), {
      disk: args.disk,
      size: args.size,
    });
    return taskOutcome(ctx, data ?? { resized: true }, args.wait);
  },
});

const guestMoveDisk = defineTool({
  name: 'pve_guest_move_disk',
  category: 'guests',
  title: 'Move guest disk',
  description:
    'Move a disk (VM: scsi0, virtio0, ...) or volume (container: rootfs, mp0) to another storage. ' +
    'deleteSource: true removes the source volume afterwards, otherwise it stays as an unused disk. ' +
    'format (raw, qcow2, vmdk) applies to VMs only. Can take long for big disks.',
  access: 'write',
  input: {
    ...guestTarget,
    disk: z.string().min(1).describe('Disk key such as scsi0, rootfs or mp0'),
    storage: storageIdSchema.describe('Target storage id'),
    deleteSource: z.boolean().optional().describe('Delete the source volume after copying'),
    format: z.enum(['raw', 'qcow2', 'vmdk']).optional().describe('VM only: target format'),
    wait: waitSchema,
  },
  handler: async (args, ctx) => {
    const g = await target(ctx, args);
    forbidFor(g, 'lxc', { format: args.format });
    const data =
      g.type === 'qemu'
        ? await ctx.client.post(guestPath(g, '/move_disk'), {
            disk: args.disk,
            storage: args.storage,
            delete: args.deleteSource,
            format: args.format,
          })
        : await ctx.client.post(guestPath(g, '/move_volume'), {
            volume: args.disk,
            storage: args.storage,
            delete: args.deleteSource,
          });
    return taskOutcome(ctx, data, args.wait);
  },
});

const guestMigrate = defineTool({
  name: 'pve_guest_migrate',
  category: 'guests',
  title: 'Migrate guest',
  description:
    'Migrate a guest to another cluster node. VM: online: true live-migrates a running VM, ' +
    'withLocalDisks copies local disks, targetStorage maps disks to a storage on the target. ' +
    'Container: a running container cannot be live-migrated, restart: true shuts it down, moves it and ' +
    'starts it again (timeout is the shutdown wait in seconds). targetStorage also applies to containers. ' +
    'Options for the other guest type are rejected.',
  access: 'write',
  input: {
    ...guestTarget,
    target: nodeSchema.describe('Target node'),
    online: z.boolean().optional().describe('VM only: live migration of a running VM'),
    withLocalDisks: z.boolean().optional().describe('VM only: also migrate local disks'),
    targetStorage: storageIdSchema.optional().describe('Storage on the target node'),
    restart: z
      .boolean()
      .optional()
      .describe('Container only: restart migration of a running container'),
    timeout: z
      .number()
      .int()
      .min(1)
      .optional()
      .describe('Container only: shutdown timeout in seconds'),
    wait: waitSchema,
  },
  handler: async (args, ctx) => {
    const g = await target(ctx, args);
    let data: unknown;
    if (g.type === 'qemu') {
      forbidFor(g, 'qemu', { restart: args.restart, timeout: args.timeout });
      data = await ctx.client.post(guestPath(g, '/migrate'), {
        target: args.target,
        online: args.online,
        'with-local-disks': args.withLocalDisks,
        targetstorage: args.targetStorage,
      });
    } else {
      forbidFor(g, 'lxc', { online: args.online, withLocalDisks: args.withLocalDisks });
      data = await ctx.client.post(guestPath(g, '/migrate'), {
        target: args.target,
        restart: args.restart,
        'target-storage': args.targetStorage,
        timeout: args.timeout,
      });
    }
    return taskOutcome(ctx, data, args.wait);
  },
});

const guestClone = defineTool({
  name: 'pve_guest_clone',
  category: 'guests',
  title: 'Clone guest',
  description:
    'Clone a VM or container (or a template) to a new VMID. newid defaults to the next free VMID. ' +
    'name is the VM name or container hostname. full: true makes an independent full copy, linked clones ' +
    'need a template as source and are only possible on some storages (a normal guest is always cloned ' +
    'in full). target is the node for the clone, storage the target storage, snapname clones from a snapshot. ' +
    'Returns the new VMID with the task result.',
  access: 'write',
  input: {
    ...guestTarget,
    newid: vmidSchema.optional().describe('VMID of the clone, default: next free VMID'),
    name: z
      .string()
      .min(1)
      .max(63)
      .optional()
      .describe('VM name or container hostname of the clone'),
    full: z
      .boolean()
      .optional()
      .describe('Full clone with copied disks. Without it, a template makes a linked clone'),
    target: nodeSchema.optional().describe('Node for the clone, default: the source node'),
    storage: storageIdSchema.optional().describe('Target storage for a full clone'),
    pool: z.string().optional().describe('Resource pool to add the clone to'),
    description: z.string().optional().describe('Description of the clone'),
    snapname: z.string().optional().describe('Clone from this snapshot'),
    wait: waitSchema,
  },
  handler: async (args, ctx) => {
    const g = await target(ctx, args);
    const newid = await nextVmid(ctx.client, args.newid);
    const data = await ctx.client.post(guestPath(g, '/clone'), {
      newid,
      [g.type === 'qemu' ? 'name' : 'hostname']: args.name,
      full: args.full,
      target: args.target,
      storage: args.storage,
      pool: args.pool,
      description: args.description,
      snapname: args.snapname,
    });
    return { newid, task: await taskOutcome(ctx, data, args.wait) };
  },
});

const guestTemplate = defineTool({
  name: 'pve_guest_template',
  category: 'guests',
  title: 'Convert guest to template',
  description:
    'Convert a stopped VM or container into a template. This cannot be undone: a template can no longer ' +
    'be started, only cloned. Stop the guest first.',
  access: 'write',
  input: { ...guestTarget, wait: waitSchema },
  handler: async (args, ctx) => {
    const g = await target(ctx, args);
    const data = await ctx.client.post(guestPath(g, '/template'));
    return taskOutcome(ctx, data ?? { converted: true }, args.wait);
  },
});

const guestDelete = defineTool({
  name: 'pve_guest_delete',
  category: 'guests',
  title: 'Delete guest',
  description:
    'Permanently delete a stopped VM or container with its disks. purge: true also removes it from ' +
    'backup jobs, replication and HA configuration. destroyUnreferencedDisks: true also deletes disks of ' +
    'the same VMID that are no longer referenced by the config. Backups are not deleted.',
  access: 'destructive',
  input: {
    ...guestTarget,
    purge: z.boolean().optional().describe('Also remove from backup jobs, replication and HA'),
    destroyUnreferencedDisks: z
      .boolean()
      .optional()
      .describe('Also delete unreferenced disks with this VMID on all storages'),
    wait: waitSchema,
  },
  confirmTarget: async (args, ctx) => {
    const extras = [
      args.purge ? 'purge from jobs, replication and HA' : undefined,
      args.destroyUnreferencedDisks ? 'also destroy unreferenced disks' : undefined,
    ].filter(Boolean);
    return `delete ${await guestLabel(ctx, args)} with its disks${extras.length ? `, ${extras.join(', ')}` : ''}`;
  },
  handler: async (args, ctx) => {
    const g = await target(ctx, args);
    const data = await ctx.client.delete(guestPath(g), {
      purge: args.purge,
      'destroy-unreferenced-disks': args.destroyUnreferencedDisks,
    });
    return taskOutcome(ctx, data, args.wait);
  },
});

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

const scalar = z.union([z.string(), z.number(), z.boolean()]);

const DISK_KEY = /^(?:(?:scsi|virtio|sata|ide)\d{1,2}|efidisk0|tpmstate0)$/;

const vmCreate = defineTool({
  name: 'pve_vm_create',
  category: 'guests',
  title: 'Create VM',
  description:
    'Create a QEMU VM. node may be omitted on a single node host, vmid defaults to the next free VMID. ' +
    'memory is MiB. disks maps a drive key to "storage:sizeGiB" (new disk), for example ' +
    '{"scsi0": "local-lvm:32"}. A cloud-init drive is {"ide2": "local-lvm:cloudinit"}. net0 is a Proxmox ' +
    'network string such as "virtio,bridge=vmbr0" (add ",tag=20" or ",firewall=1" as needed). iso is an ' +
    'ISO volume id such as "local:iso/debian.iso", attached as CD-ROM on ide2 (use ide3 etc. in disks for ' +
    'a cloud-init drive then). Cloud-init fields: ciuser, cipassword, sshkeys (plain text, encoded ' +
    'automatically), ipconfig0 ("ip=192.0.2.10/24,gw=192.0.2.1" or "ip=dhcp"), nameserver, searchdomain. ' +
    'tags is a list. start: true boots the VM after creation. extra holds any other Proxmox option ' +
    '(for example efidisk0, tpmstate0 is also allowed in disks) and may not repeat a typed field. ' +
    'archive, restore, live-restore, unique and force are refused in extra, restore backups with ' +
    'pve_backup_restore.',
  access: 'write',
  input: {
    node: nodeSchema.optional().describe('Target node, optional on a single node host'),
    vmid: vmidSchema.optional().describe('New VMID, default: next free VMID'),
    name: z.string().min(1).max(63).optional().describe('VM name, up to 63 characters'),
    memory: z.number().int().min(16).optional().describe('RAM in MiB'),
    cores: z.number().int().min(1).optional().describe('CPU cores per socket'),
    sockets: z
      .number()
      .int()
      .min(1)
      .optional()
      .describe('CPU sockets, vCPUs are sockets times cores'),
    cpu: z.string().optional().describe('CPU type, for example "x86-64-v2-AES" or "host"'),
    ostype: z.string().optional().describe('Guest OS type, for example "l26" (Linux) or "win11"'),
    machine: z.string().optional().describe('Machine type, for example "q35"'),
    bios: z
      .enum(['seabios', 'ovmf'])
      .optional()
      .describe('Firmware: seabios (BIOS) or ovmf (UEFI)'),
    scsihw: z.string().optional().describe('SCSI controller, for example "virtio-scsi-single"'),
    boot: z.string().optional().describe('Boot order, for example "order=scsi0;ide2"'),
    agent: z
      .union([z.boolean(), z.string()])
      .optional()
      .describe('QEMU guest agent: true or a string like "enabled=1,fstrim_cloned_disks=1"'),
    net0: z.string().optional().describe('For example "virtio,bridge=vmbr0"'),
    disks: z
      .record(z.string(), z.string())
      .optional()
      .describe('Drive key to volume spec, e.g. {"scsi0": "local-lvm:32"}'),
    iso: z
      .string()
      .optional()
      .describe('ISO volume id, e.g. "local:iso/debian.iso", attached as ide2 CD-ROM'),
    ciuser: z.string().optional().describe('Cloud-init user name'),
    cipassword: z.string().optional().describe('Cloud-init password, stored by Proxmox'),
    sshkeys: z.string().optional().describe('Public keys, one per line, plain text'),
    ipconfig0: z
      .string()
      .optional()
      .describe('Cloud-init network config for net0, for example "ip=dhcp"'),
    nameserver: z.string().optional().describe('DNS server for cloud-init'),
    searchdomain: z.string().optional().describe('DNS search domain for cloud-init'),
    tags: z.array(z.string()).optional().describe('Tags for the VM'),
    pool: z.string().optional().describe('Resource pool to add the VM to'),
    description: z.string().optional().describe('Description of the VM, free text'),
    onboot: z.boolean().optional().describe('Start the VM when the node boots'),
    start: z.boolean().optional().describe('Start the VM after creation'),
    extra: z.record(z.string(), scalar).optional().describe('Any other Proxmox option'),
    wait: waitSchema,
  },
  handler: async (args, ctx) => {
    const node = await defaultNode(ctx.client, args.node);
    const vmid = await nextVmid(ctx.client, args.vmid);
    const params: Record<string, Scalar | undefined> = {
      vmid,
      name: args.name,
      memory: args.memory,
      cores: args.cores,
      sockets: args.sockets,
      cpu: args.cpu,
      ostype: args.ostype,
      machine: args.machine,
      bios: args.bios,
      scsihw: args.scsihw,
      boot: args.boot,
      agent: args.agent,
      net0: args.net0,
      ciuser: args.ciuser,
      cipassword: args.cipassword,
      sshkeys: args.sshkeys === undefined ? undefined : encodeSshKeys(args.sshkeys),
      ipconfig0: args.ipconfig0,
      nameserver: args.nameserver,
      searchdomain: args.searchdomain,
      tags: joinList(args.tags),
      pool: args.pool,
      description: args.description,
      onboot: args.onboot,
      start: args.start,
    };
    for (const [key, spec] of Object.entries(args.disks ?? {})) {
      if (!DISK_KEY.test(key)) {
        throw new Error(
          `disks: "${key}" is not a drive key. Use scsiN, virtioN, sataN, ideN, efidisk0 or tpmstate0.`,
        );
      }
      params[key] = spec;
    }
    if (args.iso !== undefined) {
      if (params.ide2 !== undefined) {
        throw new Error(
          'iso uses ide2, but disks also defines ide2. Move the other drive to another key.',
        );
      }
      params.ide2 = `${args.iso},media=cdrom`;
    }
    mergeOptions(params, args.extra, 'extra', {
      transform: encodeForQemu,
      reserved: CREATE_RESERVED,
    });
    const data = await ctx.client.post(pvePath`/nodes/${node}/qemu`, params);
    return { vmid, node, task: await taskOutcome(ctx, data, args.wait) };
  },
});

const lxcCreate = defineTool({
  name: 'pve_lxc_create',
  category: 'guests',
  title: 'Create container',
  description:
    'Create an LXC container from a template. ostemplate is a volume id such as ' +
    '"local:vztmpl/debian-12-standard_12.7-1_amd64.tar.zst" (find or download templates with ' +
    'pve_storage_templates and pve_storage_template_download). node may be omitted on a single node host, ' +
    'vmid defaults to the next free VMID. Root disk: rootfs as "local-lvm:8" (size in GiB) or storage ' +
    'plus diskSizeGB. net0 example: "name=eth0,bridge=vmbr0,ip=dhcp" or ' +
    '"name=eth0,bridge=vmbr0,ip=192.0.2.20/24,gw=192.0.2.1". Containers are unprivileged unless ' +
    'unprivileged is false. features example: "nesting=1". Set password or sshPublicKeys to be able to ' +
    'log in. memory and swap are MiB. extra holds any other Proxmox option (mp0, cpulimit, ...). ' +
    'A backup archive is not a template: restore backups with pve_backup_restore, archive, restore, ' +
    'live-restore, unique and force are refused in extra.',
  access: 'write',
  input: {
    node: nodeSchema.optional().describe('Target node, optional on a single node host'),
    vmid: vmidSchema.optional().describe('New VMID, default: next free VMID'),
    ostemplate: z.string().min(1).describe('Template volume id, e.g. local:vztmpl/<file>'),
    hostname: z
      .string()
      .min(1)
      .max(63)
      .optional()
      .describe('Container hostname, up to 63 characters'),
    rootfs: z.string().optional().describe('Root volume, e.g. "local-lvm:8" (size in GiB)'),
    storage: storageIdSchema.optional().describe('Root disk storage, together with diskSizeGB'),
    diskSizeGB: z
      .number()
      .min(0.001)
      .optional()
      .describe('Root disk size in GiB, together with storage'),
    memory: z.number().int().min(16).optional().describe('RAM in MiB'),
    swap: z.number().int().min(0).optional().describe('Swap in MiB'),
    cores: z.number().int().min(1).optional().describe('CPU cores for the container'),
    net0: z.string().optional().describe('For example "name=eth0,bridge=vmbr0,ip=dhcp"'),
    password: z.string().optional().describe('Root password'),
    sshPublicKeys: z.string().optional().describe('Public keys for root, one per line'),
    unprivileged: z.boolean().optional().describe('Default true'),
    features: z.string().optional().describe('For example "nesting=1" or "keyctl=1,nesting=1"'),
    onboot: z.boolean().optional().describe('Start the container when the node boots'),
    start: z.boolean().optional().describe('Start the container after creation'),
    nameserver: z.string().optional().describe('DNS server for the container'),
    searchdomain: z.string().optional().describe('DNS search domain for the container'),
    tags: z.array(z.string()).optional().describe('Tags for the container'),
    pool: z.string().optional().describe('Resource pool to add the container to'),
    description: z.string().optional().describe('Description of the container, free text'),
    extra: z.record(z.string(), scalar).optional().describe('Any other Proxmox option'),
    wait: waitSchema,
  },
  handler: async (args, ctx) => {
    if (isBackupVolume(args.ostemplate)) {
      throw new Error(
        `ostemplate ${quote(args.ostemplate)} is a backup archive, not a container template. ` +
          'Restore backups with pve_backup_restore.',
      );
    }
    const node = await defaultNode(ctx.client, args.node);
    const vmid = await nextVmid(ctx.client, args.vmid);
    if (
      args.rootfs !== undefined &&
      (args.storage !== undefined || args.diskSizeGB !== undefined)
    ) {
      throw new Error('Use either rootfs or storage with diskSizeGB, not both.');
    }
    if ((args.storage === undefined) !== (args.diskSizeGB === undefined)) {
      throw new Error('storage and diskSizeGB belong together, pass both or use rootfs.');
    }
    const params: Record<string, Scalar | undefined> = {
      vmid,
      ostemplate: args.ostemplate,
      hostname: args.hostname,
      rootfs:
        args.rootfs ??
        (args.storage !== undefined ? `${args.storage}:${args.diskSizeGB}` : undefined),
      memory: args.memory,
      swap: args.swap,
      cores: args.cores,
      net0: args.net0,
      password: args.password,
      'ssh-public-keys': args.sshPublicKeys,
      unprivileged: args.unprivileged ?? true,
      features: args.features,
      onboot: args.onboot,
      start: args.start,
      nameserver: args.nameserver,
      searchdomain: args.searchdomain,
      tags: joinList(args.tags),
      pool: args.pool,
      description: args.description,
    };
    mergeOptions(params, args.extra, 'extra', { reserved: CREATE_RESERVED });
    const data = await ctx.client.post(pvePath`/nodes/${node}/lxc`, params);
    return { vmid, node, task: await taskOutcome(ctx, data, args.wait) };
  },
});

// ---------------------------------------------------------------------------
// QEMU guest agent and cloud-init
// ---------------------------------------------------------------------------

const AGENT_COMMANDS = [
  'info',
  'get-osinfo',
  'network-get-interfaces',
  'get-fsinfo',
  'get-users',
  'get-time',
  'get-host-name',
] as const;

const vmAgentInfo = defineTool({
  name: 'pve_vm_agent_info',
  category: 'guests',
  title: 'VM guest agent info',
  description:
    'Query the QEMU guest agent of a running VM: info (agent version and supported commands), ' +
    'get-osinfo, network-get-interfaces (IPs and MACs), get-fsinfo, get-users, get-time, get-host-name. ' +
    'Needs agent=1 in the VM config and the agent running inside the guest, otherwise Proxmox answers ' +
    'with "QEMU guest agent is not running". Read only commands.',
  access: 'read',
  input: {
    ...guestTarget,
    command: z
      .enum(AGENT_COMMANDS)
      .describe(
        'Agent command: info, get-osinfo, network-get-interfaces, get-fsinfo, get-users, get-time, or get-host-name',
      ),
  },
  handler: async (args, ctx) => {
    const g = await target(ctx, args);
    requireType(g, 'qemu', 'The guest agent');
    const data = await ctx.client.get<unknown>(guestPath(g, pvePath`/agent/${args.command}`));
    // Proxmox wraps every agent answer in { result: ... }.
    if (data && typeof data === 'object' && Object.keys(data).length === 1 && 'result' in data) {
      return (data as { result: unknown }).result;
    }
    return data;
  },
});

interface ExecStatus {
  exited?: number | boolean;
  exitcode?: number;
  signal?: number;
  'out-data'?: string;
  'err-data'?: string;
  'out-truncated'?: number | boolean;
  'err-truncated'?: number | boolean;
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason instanceof Error ? signal.reason : new Error('Request was cancelled'));
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(signal.reason instanceof Error ? signal.reason : new Error('Request was cancelled'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

const EXEC_POLL_MS = 500;

const vmAgentExec = defineTool({
  name: 'pve_vm_agent_exec',
  category: 'guests',
  title: 'Run command in VM',
  description:
    'Run a command inside a running VM through the QEMU guest agent and return exitcode, stdout and ' +
    'stderr. command is an argument vector, not a shell line: ["ls", "-l", "/tmp"]. For pipes or ' +
    'redirects use ["/bin/sh", "-c", "..."] (Windows: ["cmd.exe", "/c", "..."]). input is written to ' +
    'stdin. Output is cut off by the agent (truncated flags). If the command runs longer than ' +
    'timeoutSeconds the result has exited: false and the command keeps running in the guest. The command ' +
    'runs with the rights of the agent (usually root), so this can change or destroy anything in the VM.',
  access: 'destructive',
  input: {
    ...guestTarget,
    command: z.array(z.string()).min(1).describe('Program followed by its arguments'),
    input: z.string().optional().describe('Data for stdin'),
    timeoutSeconds: z
      .number()
      .int()
      .min(1)
      .optional()
      .describe('How long to wait for the command, default 30, capped by the server task limit'),
  },
  confirmTarget: async (args, ctx) =>
    `run ${jsonText(args.command)} in ${await guestLabel(ctx, args)}` +
    (args.input !== undefined
      ? ` with stdin ${quote(args.input)} (${args.input.length} characters)`
      : ''),
  handler: async (args, ctx) => {
    const g = await target(ctx, args);
    requireType(g, 'qemu', 'The guest agent');
    if (!args.command[0]) throw new Error('command[0] must be the program to run.');
    const started = await ctx.client.post<{ pid?: number }>(guestPath(g, '/agent/exec'), {
      command: args.command,
      'input-data': args.input,
    });
    const pid = started?.pid;
    if (typeof pid !== 'number') throw new Error('The guest agent did not return a process id.');

    const seconds = Math.min(args.timeoutSeconds ?? 30, ctx.settings.limits.taskWaitSeconds);
    const deadline = Date.now() + seconds * 1000;
    for (;;) {
      const st = await ctx.client.get<ExecStatus>(guestPath(g, '/agent/exec-status'), { pid });
      if (st?.exited) {
        return {
          pid,
          exited: true,
          exitcode: st.exitcode,
          ...(st.signal !== undefined ? { signal: st.signal } : {}),
          'out-data': st['out-data'] ?? '',
          'err-data': st['err-data'] ?? '',
          truncated: Boolean(st['out-truncated'] || st['err-truncated']),
        };
      }
      if (Date.now() >= deadline) {
        return {
          pid,
          exited: false,
          note: `The command did not finish within ${seconds} seconds and keeps running in the guest (pid ${pid}).`,
        };
      }
      await sleep(EXEC_POLL_MS, ctx.signal);
    }
  },
});

const vmCloudinit = defineTool({
  name: 'pve_vm_cloudinit',
  category: 'guests',
  title: 'VM cloud-init',
  description:
    'Cloud-init state of a VM: the pending list shows current and pending values of the cloud-init ' +
    'options (changes apply after the cloud-init drive is regenerated, usually on the next start). ' +
    'dump: user, network or meta additionally returns the rendered cloud-init document of that type.',
  access: 'read',
  input: {
    ...guestTarget,
    dump: z
      .enum(['user', 'network', 'meta'])
      .optional()
      .describe('Also return this rendered document'),
  },
  handler: async (args, ctx) => {
    const g = await target(ctx, args);
    requireType(g, 'qemu', 'Cloud-init');
    const pending = await ctx.client.get(guestPath(g, '/cloudinit'));
    if (!args.dump) return { pending };
    const dump = await ctx.client.get(guestPath(g, '/cloudinit/dump'), { type: args.dump });
    return { pending, dump: { type: args.dump, content: dump } };
  },
});

export const guestTools: AnyToolDef[] = [
  guestList,
  guestStatus,
  guestConfig,
  guestRrd,
  guestPower,
  guestUpdateConfig,
  guestResizeDisk,
  guestMoveDisk,
  guestMigrate,
  guestClone,
  guestTemplate,
  guestDelete,
  vmCreate,
  lxcCreate,
  vmAgentInfo,
  vmAgentExec,
  vmCloudinit,
];
