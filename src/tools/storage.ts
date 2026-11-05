import { z } from 'zod';
import { pvePath, volid } from '../proxmox/path.js';
import { taskOutcome } from '../proxmox/tasks.js';
import { defineTool, type AnyToolDef } from '../server/registry.js';
import {
  configValueSchema,
  nodeSchema,
  storageIdSchema,
  vmidSchema,
  waitSchema,
} from './common.js';
import {
  defaultNode,
  isoTime,
  mergeOptions,
  storageNode,
  splitList,
  storageResources,
  type ReservedOptions,
  type StorageResource,
} from './resolve-node.js';
import { quote, storageLabel } from './targets.js';

type Scalar = string | number | boolean;

const nodeOptional = nodeSchema
  .optional()
  .describe('Node. Optional when the storage exists on exactly one node.');

const contentTypes = [
  'images',
  'rootdir',
  'vztmpl',
  'iso',
  'backup',
  'snippets',
  'import',
] as const;

interface StorageDefinition {
  storage?: string;
  type?: string;
  content?: string;
  nodes?: string;
  shared?: number | boolean;
  disable?: number | boolean;
  path?: string;
}

interface NodeStorageRow {
  storage?: string;
  type?: string;
  content?: string;
  active?: number | boolean;
  enabled?: number | boolean;
  shared?: number | boolean;
  total?: number;
  used?: number;
  avail?: number;
}

const storageList = defineTool({
  name: 'pve_storage_list',
  category: 'storage',
  title: 'List storages',
  description:
    'Storages with type, allowed content types and usage. Without node: every storage definition of the ' +
    'cluster with its usage on each node. With node: the storages available on that node with total, used ' +
    'and available bytes. Filters: content (images, rootdir, vztmpl, iso, backup, snippets, import) and ' +
    'enabled. Use it to find a storage id for disks, ISOs, templates or backups.',
  access: 'read',
  input: {
    node: nodeSchema.optional().describe('Only this node, with exact capacity numbers'),
    content: z.enum(contentTypes).optional().describe('Only storages allowing this content type'),
    enabled: z
      .boolean()
      .optional()
      .describe('true: only enabled storages, false: only disabled ones'),
  },
  handler: async (args, ctx) => {
    if (args.node) {
      const rows =
        (await ctx.client.get<NodeStorageRow[]>(pvePath`/nodes/${args.node}/storage`, {
          content: args.content,
          enabled: args.enabled,
        })) ?? [];
      return rows.map((r) => ({
        storage: r.storage,
        type: r.type,
        content: r.content?.split(',').filter(Boolean),
        active: Boolean(r.active),
        enabled: r.enabled === undefined ? undefined : Boolean(r.enabled),
        shared: Boolean(r.shared),
        total: r.total,
        used: r.used,
        avail: r.avail,
      }));
    }
    const [definitions, usage] = await Promise.all([
      ctx.client.get<StorageDefinition[]>('/storage'),
      storageResources(ctx.client),
    ]);
    return (definitions ?? [])
      .filter((d) => !args.content || (d.content ?? '').split(',').includes(args.content))
      .filter((d) => args.enabled === undefined || !d.disable === args.enabled)
      .map((d) => ({
        storage: d.storage,
        type: d.type,
        content: d.content?.split(',').filter(Boolean),
        shared: Boolean(d.shared),
        enabled: !d.disable,
        nodes: d.nodes?.split(',').filter(Boolean),
        path: d.path,
        usage: usage
          .filter((u: StorageResource) => u.storage === d.storage)
          .map((u) => ({ node: u.node, status: u.status, used: u.disk, total: u.maxdisk })),
      }));
  },
});

interface ContentRow {
  volid?: string;
  content?: string;
  format?: string;
  size?: number;
  used?: number;
  vmid?: number;
  ctime?: number;
  notes?: string;
  protected?: number | boolean;
  parent?: string;
}

const storageContent = defineTool({
  name: 'pve_storage_content',
  category: 'storage',
  title: 'Storage content',
  description:
    'Volumes on a storage: disk images, ISO files, container templates, backups, snippets. Filters: ' +
    'content (type) and vmid. Each volume has a volid such as "local:iso/debian.iso" that other tools ' +
    'take as input. Sizes are bytes.',
  access: 'read',
  input: {
    storage: storageIdSchema,
    node: nodeOptional,
    content: z
      .enum(contentTypes)
      .optional()
      .describe(
        'Only volumes of this content type: images, rootdir, vztmpl, iso, backup, snippets or import',
      ),
    vmid: vmidSchema.optional().describe('Only volumes of this guest'),
  },
  handler: async (args, ctx) => {
    const node = await storageNode(ctx.client, args.storage, args.node);
    const rows =
      (await ctx.client.get<ContentRow[]>(pvePath`/nodes/${node}/storage/${args.storage}/content`, {
        content: args.content,
        vmid: args.vmid,
      })) ?? [];
    return rows.map((r) => ({
      volid: r.volid,
      content: r.content,
      format: r.format,
      size: r.size,
      used: r.used,
      vmid: r.vmid,
      ctime: isoTime(r.ctime),
      notes: r.notes,
      protected: r.protected === undefined ? undefined : Boolean(r.protected),
    }));
  },
});

const storageDownloadUrl = defineTool({
  name: 'pve_storage_download_url',
  category: 'storage',
  title: 'Download file from URL to storage',
  description:
    'Let the Proxmox node download an ISO image, container template or disk image (content import) ' +
    'from an http or https URL into a storage that allows that content type. filename is the target name ' +
    '(for example "debian-12.iso"). Provide checksum and checksumAlgorithm (sha256, sha512, md5, ...) ' +
    'to verify the download. TLS certificates of the source are verified unless verifyCertificates is ' +
    'false. The node must reach the URL itself.',
  access: 'write',
  openWorld: true,
  input: {
    storage: storageIdSchema,
    node: nodeOptional,
    url: z
      .string()
      .url()
      .refine((u) => /^https?:\/\//i.test(u), 'only http and https URLs are allowed')
      .describe('HTTP or HTTPS URL of the file to download'),
    filename: z
      .string()
      .min(1)
      .max(255)
      .regex(/^[^/\\\0]+$/, 'a file name without path separators')
      .describe('File name to store the download as, without a path'),
    content: z
      .enum(['iso', 'vztmpl', 'import'])
      .describe('Content type of the download: iso, vztmpl (container template) or import'),
    checksum: z
      .string()
      .optional()
      .describe('Expected checksum of the download, see checksumAlgorithm'),
    checksumAlgorithm: z
      .enum(['md5', 'sha1', 'sha224', 'sha256', 'sha384', 'sha512'])
      .optional()
      .describe('Required together with checksum'),
    verifyCertificates: z.boolean().optional().describe('Default true'),
    wait: waitSchema,
  },
  handler: async (args, ctx) => {
    if ((args.checksum === undefined) !== (args.checksumAlgorithm === undefined)) {
      throw new Error('checksum and checksumAlgorithm belong together, pass both or neither.');
    }
    const node = await storageNode(ctx.client, args.storage, args.node);
    const data = await ctx.client.post(
      pvePath`/nodes/${node}/storage/${args.storage}/download-url`,
      {
        url: args.url,
        filename: args.filename,
        content: args.content,
        checksum: args.checksum,
        'checksum-algorithm': args.checksumAlgorithm,
        'verify-certificates': args.verifyCertificates ?? true,
      },
    );
    return taskOutcome(ctx, data, args.wait);
  },
});

interface AplRow {
  template?: string;
  package?: string;
  headline?: string;
  os?: string;
  section?: string;
  version?: string;
  description?: string;
  architecture?: string;
}

const DEFAULT_TEMPLATE_LIMIT = 50;

const storageTemplates = defineTool({
  name: 'pve_storage_templates',
  category: 'storage',
  title: 'Available container templates',
  description:
    'Container templates that Proxmox offers for download (appliance list). Filters: section ' +
    '(system for plain OS images, turnkeylinux), os (for example debian, ubuntu, alpine) and a search ' +
    'text matched against package, headline and description. The template name goes to ' +
    'pve_storage_template_download. Returns at most limit entries (default 50). Already downloaded ' +
    'templates are listed by pve_storage_content with content vztmpl.',
  access: 'read',
  input: {
    node: nodeSchema.optional().describe('Node, optional on a single node host'),
    section: z.string().optional().describe('For example "system" or "turnkeylinux"'),
    os: z.string().optional().describe('For example "debian", "ubuntu", "alpine"'),
    search: z.string().optional().describe('Case insensitive text'),
    limit: z.number().int().min(1).max(500).optional().describe('Default 50'),
  },
  handler: async (args, ctx) => {
    const node = await defaultNode(ctx.client, args.node);
    const rows = (await ctx.client.get<AplRow[]>(pvePath`/nodes/${node}/aplinfo`)) ?? [];
    const search = args.search?.toLowerCase();
    const os = args.os?.toLowerCase();
    const matches = rows
      .filter((r) => !args.section || r.section === args.section)
      .filter((r) => !os || (r.os ?? '').toLowerCase() === os)
      .filter(
        (r) =>
          !search ||
          [r.package, r.headline, r.description, r.template].some((f) =>
            (f ?? '').toLowerCase().includes(search),
          ),
      );
    const limit = args.limit ?? DEFAULT_TEMPLATE_LIMIT;
    return {
      total: matches.length,
      shown: Math.min(limit, matches.length),
      templates: matches.slice(0, limit).map((r) => ({
        template: r.template,
        package: r.package,
        os: r.os,
        version: r.version,
        section: r.section,
        architecture: r.architecture,
        headline: r.headline,
      })),
    };
  },
});

const storageTemplateDownload = defineTool({
  name: 'pve_storage_template_download',
  category: 'storage',
  title: 'Download container template',
  description:
    'Download a container template from the Proxmox appliance list to a storage with content type ' +
    'vztmpl (usually "local"). template is the file name from pve_storage_templates, for example ' +
    '"debian-12-standard_12.7-1_amd64.tar.zst". Afterwards the volume id is "<storage>:vztmpl/<template>".',
  access: 'write',
  input: {
    storage: storageIdSchema,
    node: nodeOptional,
    template: z.string().min(1).describe('Template file name from pve_storage_templates'),
    wait: waitSchema,
  },
  handler: async (args, ctx) => {
    const node = await storageNode(ctx.client, args.storage, args.node);
    const data = await ctx.client.post(pvePath`/nodes/${node}/aplinfo`, {
      storage: args.storage,
      template: args.template,
    });
    return taskOutcome(ctx, data, args.wait);
  },
});

const storageVolumeDelete = defineTool({
  name: 'pve_storage_volume_delete',
  category: 'storage',
  title: 'Delete volume',
  description:
    'Permanently delete a volume (disk image, ISO, template, backup, snippet) from a storage. volume is ' +
    'the volid from pve_storage_content, for example "local:iso/debian.iso" or ' +
    '"local-lvm:vm-100-disk-1". Protected backups and volumes still used by a guest are refused by ' +
    'Proxmox. Deleted data cannot be recovered.',
  access: 'destructive',
  input: {
    storage: storageIdSchema,
    node: nodeOptional,
    volume: z.string().min(1).describe('Volume id as listed by pve_storage_content'),
    wait: waitSchema,
  },
  confirmTarget: async (args, ctx) =>
    `delete volume ${quote(args.volume)} from ${await storageLabel(ctx, args.storage, args.node)}`,
  handler: async (args, ctx) => {
    const prefix = args.volume.includes(':')
      ? args.volume.slice(0, args.volume.indexOf(':'))
      : undefined;
    if (prefix !== undefined && prefix !== args.storage) {
      throw new Error(
        `Volume ${args.volume} belongs to storage "${prefix}", not "${args.storage}".`,
      );
    }
    const node = await storageNode(ctx.client, args.storage, args.node);
    const data = await ctx.client.delete(
      pvePath`/nodes/${node}/storage/${args.storage}/content/${volid(prefix === undefined ? `${args.storage}:${args.volume}` : args.volume)}`,
    );
    return taskOutcome(ctx, data ?? { deleted: args.volume }, args.wait);
  },
});

const STORAGE_RESERVED: ReservedOptions = {
  storage: '"storage" is not an option, use the storage argument.',
  type: '"type" is not an option, use the type argument.',
  delete: '"delete" is not an option, use the delete argument.',
  digest: '"digest" is not supported by this tool.',
};

/** The delete list as Proxmox splits it, joined with commas, undefined when empty. */
export function deleteParam(remove: readonly string[] | undefined): string | undefined {
  const keys = splitList(remove, 'delete');
  return keys.length > 0 ? keys.join(',') : undefined;
}

/** True when a call sets or removes the backup retention of a storage or backup job. */
export function touchesPruneBackups(
  options: Record<string, unknown> | undefined,
  remove: readonly string[] | undefined,
): boolean {
  return (
    (options !== undefined && Object.prototype.hasOwnProperty.call(options, 'prune-backups')) ||
    splitList(remove, 'delete').includes('prune-backups')
  );
}

/** Describes a prune-backups change for the confirmation question. */
export function pruneChange(
  options: Record<string, unknown> | undefined,
  remove: readonly string[] | undefined,
): string {
  const value = options?.['prune-backups'];
  if (value !== undefined) return `set prune-backups to ${quote(String(value))}`;
  return remove?.length
    ? 'remove prune-backups (back to the default retention)'
    : 'change prune-backups';
}

const storageDefine = defineTool({
  name: 'pve_storage_define',
  category: 'storage',
  title: 'Create or update storage',
  description:
    'Create a storage definition (update: false, default) or change an existing one (update: true). ' +
    'type is required on creation (dir, lvm, lvmthin, zfspool, nfs, cifs, pbs, cephfs, rbd, iscsi, ' +
    'btrfs, ...) and cannot change later. content lists allowed types, nodes restricts it to nodes, ' +
    'disable turns it off. options holds all type specific keys, for example dir: {path: "/mnt/data"}, ' +
    'nfs: {server: "192.0.2.10", export: "/srv/share"}, zfspool: {pool: "tank"}, ' +
    'cifs: {server, share, username, password}. delete (update only) removes keys. This only changes ' +
    'the definition, it does not create the underlying directory, pool or volume group. Setting or ' +
    'removing prune-backups (backup retention, for example "keep-last=3") asks the user first, because ' +
    'the next backup prunes older backups by it.',
  access: 'write',
  input: {
    storage: storageIdSchema,
    type: z
      .string()
      .min(1)
      .optional()
      .describe('Required when creating, for example "dir" or "nfs"'),
    update: z.boolean().optional().describe('true: change an existing storage'),
    content: z
      .array(z.enum(contentTypes))
      .optional()
      .describe(
        'Content types the storage holds: images, rootdir, vztmpl, iso, backup, snippets or import',
      ),
    nodes: z.array(nodeSchema).optional().describe('Restrict the storage to these nodes'),
    disable: z
      .boolean()
      .optional()
      .describe('true: disable the storage, so Proxmox does not use it'),
    options: z.record(z.string(), configValueSchema).optional().describe('Type specific options'),
    delete: z.array(z.string()).optional().describe('Update only: option keys to remove'),
  },
  needsConfirmation: (args) => touchesPruneBackups(args.options, args.delete),
  confirmTarget: (args) =>
    `${pruneChange(args.options, args.delete)} on ${args.update ? 'existing' : 'new'} storage ${args.storage}`,
  handler: async (args, ctx) => {
    const params: Record<string, Scalar | undefined> = {
      content: args.content?.join(','),
      nodes: args.nodes?.join(','),
      disable: args.disable,
    };
    mergeOptions(params, args.options, 'options', { reserved: STORAGE_RESERVED });
    if (args.update) {
      if (args.type !== undefined) {
        throw new Error(
          'The storage type cannot be changed. Remove type, or remove and recreate the storage.',
        );
      }
      const result = await ctx.client.put(pvePath`/storage/${args.storage}`, {
        ...params,
        delete: deleteParam(args.delete),
      });
      return result ?? { updated: args.storage };
    }
    if (args.type === undefined) throw new Error('type is required to create a storage.');
    if (args.delete && args.delete.length > 0) {
      throw new Error('delete only works together with update: true.');
    }
    return ctx.client.post('/storage', { storage: args.storage, type: args.type, ...params });
  },
});

const storageRemove = defineTool({
  name: 'pve_storage_remove',
  category: 'storage',
  title: 'Remove storage definition',
  description:
    'Remove a storage definition from the cluster. The data on the storage is not deleted, but guests ' +
    'and jobs that reference it lose access, and its backups disappear from the Proxmox views. ' +
    'Check pve_storage_content first.',
  access: 'destructive',
  input: { storage: storageIdSchema },
  confirmTarget: (args) => `remove the definition of storage ${args.storage} (cluster wide)`,
  handler: async (args, ctx) => {
    const result = await ctx.client.delete(pvePath`/storage/${args.storage}`);
    return result ?? { removed: args.storage };
  },
});

export const storageTools: AnyToolDef[] = [
  storageList,
  storageContent,
  storageDownloadUrl,
  storageTemplates,
  storageTemplateDownload,
  storageVolumeDelete,
  storageDefine,
  storageRemove,
];
