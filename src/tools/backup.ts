import { z } from 'zod';
import { resolveGuest } from '../proxmox/guests.js';
import { pvePath } from '../proxmox/path.js';
import { taskOutcome } from '../proxmox/tasks.js';
import type { Params } from '../proxmox/types.js';
import { defineTool, type AnyToolDef } from '../server/registry.js';
import {
  configValueSchema,
  nodeSchema,
  storageIdSchema,
  vmidSchema,
  waitSchema,
} from './common.js';
import {
  isoTime,
  mergeOptions,
  storageNode,
  storageResources,
  type ReservedOptions,
} from './resolve-node.js';
import { deleteParam, pruneChange, touchesPruneBackups } from './storage.js';
import { guestLabel, quote } from './targets.js';

type Scalar = string | number | boolean;

const backupModeSchema = z
  .enum(['snapshot', 'suspend', 'stop'])
  .describe(
    'snapshot: live backup (default), suspend: short pause, stop: shut the guest down for the backup',
  );

const compressSchema = z
  .enum(['0', 'gzip', 'lzo', 'zstd'])
  .describe('Compression, default zstd. "0" disables it.');

interface ContentRow {
  volid?: string;
  size?: number;
  ctime?: number;
  vmid?: number;
  notes?: string;
  protected?: number | boolean;
  format?: string;
}

const backupList = defineTool({
  name: 'pve_backup_list',
  category: 'backup',
  title: 'List backups',
  description:
    'Backups on all storages that allow backup content, or on one storage. Filter by vmid. Newest first. ' +
    'volid is what pve_backup_restore takes. size is bytes, ctime an ISO timestamp. Shared storages are ' +
    'read once. Returns at most limit entries (default 100). Storages that cannot be read are listed ' +
    'under errors.',
  access: 'read',
  input: {
    storage: storageIdSchema.optional().describe('Only this storage, default: all backup storages'),
    node: nodeSchema.optional().describe('Only read storages through this node'),
    vmid: vmidSchema.optional(),
    limit: z.number().int().min(1).max(1000).optional().describe('Default 100'),
  },
  handler: async (args, ctx) => {
    const resources = (await storageResources(ctx.client))
      .filter((r) => r.storage && r.node)
      .filter((r) => !args.storage || r.storage === args.storage)
      .filter((r) => !args.node || r.node === args.node)
      .filter((r) => r.status === 'available')
      .filter((r) => (r.content ?? '').split(',').includes('backup'));

    // A shared storage shows the same volumes on every node, so one node is enough.
    const seen = new Set<string>();
    const targets = resources.filter((r) => {
      if (!r.shared) return true;
      if (seen.has(r.storage as string)) return false;
      seen.add(r.storage as string);
      return true;
    });

    const errors: string[] = [];
    const lists = await Promise.all(
      targets.map(async (t) => {
        try {
          const rows =
            (await ctx.client.get<ContentRow[]>(
              pvePath`/nodes/${t.node as string}/storage/${t.storage as string}/content`,
              { content: 'backup', vmid: args.vmid },
            )) ?? [];
          return rows.map((r) => ({ ...r, storage: t.storage, node: t.node }));
        } catch (err) {
          errors.push(
            `${t.storage} on ${t.node}: ${err instanceof Error ? err.message : String(err)}`,
          );
          return [];
        }
      }),
    );

    const all = lists
      .flat()
      .filter((r) => args.vmid === undefined || r.vmid === args.vmid)
      .sort((a, b) => (b.ctime ?? 0) - (a.ctime ?? 0));
    const limit = args.limit ?? 100;
    return {
      total: all.length,
      backups: all.slice(0, limit).map((r) => ({
        volid: r.volid,
        vmid: r.vmid,
        size: r.size,
        ctime: isoTime(r.ctime),
        notes: r.notes,
        protected: Boolean(r.protected),
        format: r.format,
        storage: r.storage,
        node: r.node,
      })),
      ...(errors.length > 0 ? { errors } : {}),
    };
  },
});

const backupCreate = defineTool({
  name: 'pve_backup_create',
  category: 'backup',
  title: 'Back up guests now',
  description:
    'Run a vzdump backup now for one or more guests (vmids). Guests on different nodes are backed up ' +
    'with one task per node, the result lists each task. storage is the backup storage id (default: the ' +
    'node dump storage). mode snapshot keeps the guest running, compress defaults to zstd. notes sets the ' +
    'backup note and may use {{guestname}}, {{node}}, {{vmid}}, {{cluster}}. protected: true keeps the ' +
    'backup from pruning and deletion. remove: false skips pruning old backups of the retention setting.',
  access: 'write',
  input: {
    vmids: z
      .array(vmidSchema)
      .min(1)
      .max(100)
      .describe('VMIDs of the guests to back up, 1 to 100 entries'),
    storage: storageIdSchema.optional(),
    mode: backupModeSchema.optional(),
    compress: compressSchema.optional(),
    notes: z.string().max(1024).optional().describe('Notes template'),
    protected: z.boolean().optional().describe('Protect the backup from pruning and deletion'),
    remove: z.boolean().optional().describe('Prune old backups per the retention settings'),
    wait: waitSchema,
  },
  handler: async (args, ctx) => {
    const vmids = [...new Set(args.vmids)];
    const guests = await Promise.all(vmids.map((id) => resolveGuest(ctx.client, id)));
    const byNode = new Map<string, number[]>();
    for (const g of guests) {
      byNode.set(g.node, [...(byNode.get(g.node) ?? []), g.vmid]);
    }
    const tasks = await Promise.all(
      [...byNode.entries()].map(async ([node, ids]) => {
        const data = await ctx.client.post(pvePath`/nodes/${node}/vzdump`, {
          vmid: ids.join(','),
          storage: args.storage,
          mode: args.mode,
          compress: args.compress ?? 'zstd',
          'notes-template': args.notes,
          protected: args.protected,
          remove: args.remove,
        });
        return { node, vmids: ids, task: await taskOutcome(ctx, data, args.wait) };
      }),
    );
    return { tasks };
  },
});

/** Guest type of a backup volume id, from the vzdump file name or the PBS backup group. */
export function backupType(volid: string): 'qemu' | 'lxc' | undefined {
  if (/vzdump-qemu-/.test(volid) || /:backup\/vm\//.test(volid)) return 'qemu';
  if (/vzdump-(?:lxc|openvz)-/.test(volid) || /:backup\/ct\//.test(volid)) return 'lxc';
  return undefined;
}

const backupRestore = defineTool({
  name: 'pve_backup_restore',
  category: 'backup',
  title: 'Restore backup',
  description:
    'Restore a backup (volid from pve_backup_list) to a VMID. The guest type is derived from the volid ' +
    '(vzdump-qemu-... is a VM, vzdump-lxc-... a container), pass type if the name does not tell. vmid ' +
    'defaults to the next free VMID, so by default nothing is overwritten. An existing VMID is replaced ' +
    'only with force: true and its current data is lost. unique: true gives a restored VM new MAC ' +
    'addresses (use it when the original keeps running). storage is the target storage for the disks, ' +
    'start boots the guest afterwards, pool adds it to a resource pool. node defaults to the single node ' +
    'that holds the backup storage.',
  access: 'destructive',
  input: {
    archive: z
      .string()
      .regex(/^[^:\s]+:\S+$/, 'a volume id such as local:backup/vzdump-qemu-100-....vma.zst')
      .describe('Backup volume id as listed by pve_backup_list'),
    vmid: vmidSchema.optional().describe('Target VMID, default: next free VMID'),
    type: z
      .enum(['qemu', 'lxc'])
      .optional()
      .describe('Only needed when the volid does not show the type'),
    node: nodeSchema.optional().describe('Node to restore on'),
    storage: storageIdSchema.optional().describe('Target storage for the restored disks'),
    force: z.boolean().optional().describe('Overwrite an existing guest with this VMID'),
    unique: z.boolean().optional().describe('Generate new unique properties such as MAC addresses'),
    start: z.boolean().optional().describe('Start the restored guest after the restore'),
    pool: z.string().optional().describe('Resource pool to add the restored guest to'),
    wait: waitSchema,
  },
  confirmTarget: async (args, ctx) => {
    const into =
      args.vmid === undefined
        ? 'the next free VMID'
        : args.force
          ? `${await guestLabel(ctx, { vmid: args.vmid })}, overwriting the existing guest and its disks`
          : `VMID ${args.vmid} (refused by Proxmox if it exists, force is not set)`;
    const where = [
      args.node ? `on node ${args.node}` : undefined,
      args.storage ? `disks on storage ${args.storage}` : undefined,
    ]
      .filter(Boolean)
      .join(', ');
    return `restore ${quote(args.archive)} to ${into}${where ? `, ${where}` : ''}`;
  },
  handler: async (args, ctx) => {
    const type = args.type ?? backupType(args.archive);
    if (!type) {
      throw new Error(
        'Cannot tell from the volume id whether this is a VM or container backup. Pass type "qemu" or "lxc".',
      );
    }
    const storage = args.archive.slice(0, args.archive.indexOf(':'));
    const node = args.node ?? (await storageNode(ctx.client, storage));
    const vmid = args.vmid ?? Number(await ctx.client.get<string | number>('/cluster/nextid'));
    if (!Number.isInteger(vmid)) throw new Error('Proxmox did not return a usable next VMID.');

    const common = {
      vmid,
      storage: args.storage,
      force: args.force,
      unique: args.unique,
      start: args.start,
      pool: args.pool,
    };
    const data =
      type === 'qemu'
        ? await ctx.client.post(pvePath`/nodes/${node}/qemu`, { ...common, archive: args.archive })
        : await ctx.client.post(pvePath`/nodes/${node}/lxc`, {
            ...common,
            ostemplate: args.archive,
            restore: true,
          });
    return { vmid, node, type, task: await taskOutcome(ctx, data, args.wait) };
  },
});

const backupJobsList = defineTool({
  name: 'pve_backup_jobs_list',
  category: 'backup',
  title: 'List backup jobs',
  description:
    'Scheduled backup jobs of the cluster: id, schedule, storage, mode, selected guests (vmid, all, ' +
    'pool, exclude), retention (prune-backups), enabled. Use the id with pve_backup_job_set or ' +
    'pve_backup_job_delete.',
  access: 'read',
  input: {},
  handler: async (_args, ctx) => (await ctx.client.get('/cluster/backup')) ?? [],
});

const JOB_RESERVED: ReservedOptions = {
  id: 'Use the id argument.',
  delete: 'Use the delete argument.',
};

const backupJobSet = defineTool({
  name: 'pve_backup_job_set',
  category: 'backup',
  title: 'Create or update backup job',
  description:
    'Create a scheduled backup job (no id) or change one (id from pve_backup_jobs_list). schedule uses ' +
    'the Proxmox calendar syntax: "daily", "mon..fri 02:30", "sat 03:00", "*-*-01 04:00". Select guests ' +
    'with vmid (list) or all: true, optionally node, pool or exclude. prune-backups example: ' +
    '"keep-last=3,keep-weekly=4,keep-monthly=6". Other keys go into extra (for example repeat-missed, ' +
    'bwlimit, fleecing). On update, delete lists keys to remove. Setting or removing prune-backups asks ' +
    'the user first, because the job prunes older backups by it.',
  access: 'write',
  input: {
    id: z.string().min(1).optional().describe('Existing job id to update, omit to create'),
    schedule: z.string().optional().describe('For example "daily" or "sat 03:00"'),
    storage: storageIdSchema.optional(),
    vmid: z.array(vmidSchema).optional().describe('Guests to back up'),
    all: z.boolean().optional().describe('Back up all guests'),
    exclude: z.array(vmidSchema).optional().describe('With all: guests to skip'),
    node: nodeSchema.optional().describe('Only guests on this node'),
    pool: z.string().optional().describe('Back up the guests of this pool'),
    mode: backupModeSchema.optional(),
    compress: compressSchema.optional(),
    enabled: z.boolean().optional().describe('Whether the job runs on its schedule'),
    mailto: z.string().optional().describe('Comma separated e-mail addresses'),
    notesTemplate: z.string().optional().describe('Notes template, e.g. "{{guestname}}"'),
    pruneBackups: z.string().optional().describe('Retention, e.g. "keep-last=3,keep-weekly=4"'),
    comment: z.string().optional().describe('Free text comment for the job'),
    delete: z.array(z.string()).optional().describe('Update only: keys to remove'),
    extra: z.record(z.string(), configValueSchema).optional().describe('Any other job option'),
  },
  needsConfirmation: (args) =>
    args.pruneBackups !== undefined || touchesPruneBackups(args.extra, args.delete),
  confirmTarget: (args) => {
    const options =
      args.pruneBackups !== undefined ? { 'prune-backups': args.pruneBackups } : args.extra;
    const job = args.id === undefined ? 'a new backup job' : `backup job ${quote(args.id)}`;
    return `${pruneChange(options, args.delete)} on ${job}${args.storage ? ` (storage ${args.storage})` : ''}`;
  },
  handler: async (args, ctx) => {
    if (args.all && args.vmid && args.vmid.length > 0) {
      throw new Error('Use either vmid or all: true, not both.');
    }
    const params: Record<string, Scalar | undefined> = {
      schedule: args.schedule,
      storage: args.storage,
      vmid: args.vmid && args.vmid.length > 0 ? args.vmid.join(',') : undefined,
      all: args.all,
      exclude: args.exclude && args.exclude.length > 0 ? args.exclude.join(',') : undefined,
      node: args.node,
      pool: args.pool,
      mode: args.mode,
      compress: args.compress,
      enabled: args.enabled,
      mailto: args.mailto,
      'notes-template': args.notesTemplate,
      'prune-backups': args.pruneBackups,
      comment: args.comment,
    };
    mergeOptions(params, args.extra, 'extra', { reserved: JOB_RESERVED });
    if (args.id === undefined) {
      if (args.delete && args.delete.length > 0) {
        throw new Error('delete only works when updating an existing job (pass id).');
      }
      const result = await ctx.client.post('/cluster/backup', params as Params);
      return result ?? { created: true };
    }
    const result = await ctx.client.put(pvePath`/cluster/backup/${args.id}`, {
      ...params,
      delete: deleteParam(args.delete),
    });
    return result ?? { updated: args.id };
  },
});

const backupJobDelete = defineTool({
  name: 'pve_backup_job_delete',
  category: 'backup',
  title: 'Delete backup job',
  description:
    'Delete a scheduled backup job. Existing backup files stay. Guests lose their automatic backup ' +
    'unless another job covers them.',
  access: 'destructive',
  input: { id: z.string().min(1).describe('Job id from pve_backup_jobs_list') },
  confirmTarget: async (args, ctx) => {
    let details = '';
    try {
      const job = await ctx.client.get<Record<string, unknown>>(
        pvePath`/cluster/backup/${args.id}`,
      );
      const parts = [
        typeof job?.schedule === 'string' ? `schedule ${quote(job.schedule, 60)}` : undefined,
        typeof job?.storage === 'string' ? `storage ${quote(job.storage, 60)}` : undefined,
        job?.all
          ? 'all guests'
          : typeof job?.vmid === 'string'
            ? `VMIDs ${quote(job.vmid, 100)}`
            : undefined,
      ].filter(Boolean);
      if (parts.length > 0) details = ` (${parts.join(', ')})`;
    } catch {
      details = '';
    }
    return `delete backup job ${quote(args.id)}${details}`;
  },
  handler: async (args, ctx) => {
    const result = await ctx.client.delete(pvePath`/cluster/backup/${args.id}`);
    return result ?? { deleted: args.id };
  },
});

export const backupTools: AnyToolDef[] = [
  backupList,
  backupCreate,
  backupRestore,
  backupJobsList,
  backupJobSet,
  backupJobDelete,
];
