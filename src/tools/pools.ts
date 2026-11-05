import { z } from 'zod';
import { ProxmoxApiError } from '../proxmox/errors.js';
import { pvePath } from '../proxmox/path.js';
import type { Params, ProxmoxClient } from '../proxmox/types.js';
import { defineTool, type AnyToolDef } from '../server/registry.js';
import { storageIdSchema, vmidSchema } from './common.js';

type Row = Record<string, unknown>;

/** Pool ids may contain "/" for nested pools (Proxmox VE 9). */
const poolIdSchema = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/, 'invalid pool id')
  .describe('Pool id, for example "web". Nested pools use "parent/child" on Proxmox VE 9.');

/*
 * Proxmox VE 9 moved the pool calls to the collection (GET, PUT and DELETE on
 * /pools with a poolid parameter) to support nested pools and deprecated the
 * /pools/{poolid} forms. Older versions only know the path form. Each call
 * tries the new form first and falls back to the old one when Proxmox says the
 * new form does not exist.
 */
function isUnsupported(err: unknown): boolean {
  if (!(err instanceof ProxmoxApiError)) return false;
  if (err.status === 404 || err.status === 405 || err.status === 501) return true;
  return err.status === 400 && err.errors !== undefined && 'poolid' in err.errors;
}

/**
 * Path of the legacy /pools/{poolid} form. Nested pool ids contain "/", which
 * the legacy form cannot carry, and only exist where the modern form works.
 */
function legacyPoolPath(poolid: string): string {
  if (poolid.includes('/')) {
    throw new Error(
      `Pool "${poolid}" is a nested pool id, which needs Proxmox VE 9 and its /pools API.`,
    );
  }
  return pvePath`/pools/${poolid}`;
}

async function withFallback<T>(modern: () => Promise<T>, legacy: () => Promise<T>): Promise<T> {
  try {
    return await modern();
  } catch (err) {
    if (!isUnsupported(err)) throw err;
    return legacy();
  }
}

/** Reads one pool in either API form and returns it as `{ poolid, comment, members }`. */
export async function readPool(client: ProxmoxClient, poolid: string, type?: string): Promise<Row> {
  const normalize = (data: unknown): Row | undefined => {
    const list = Array.isArray(data)
      ? (data as Row[])
      : data && typeof data === 'object'
        ? [data as Row]
        : [];
    const hit = list.find((p) => p.poolid === undefined || p.poolid === poolid);
    return hit ? { poolid, ...hit } : undefined;
  };
  const params: Params = { poolid, type };
  try {
    const found = normalize(await client.get('/pools', params));
    if (found) return found;
  } catch (err) {
    if (!isUnsupported(err)) throw err;
  }
  if (poolid.includes('/')) throw new Error(`Pool "${poolid}" was not found.`);
  const legacy = normalize(await client.get(legacyPoolPath(poolid), { type }));
  if (!legacy) throw new Error(`Pool "${poolid}" was not found.`);
  return legacy;
}

function brief(member: Row): Row {
  const out: Row = {};
  for (const key of ['type', 'vmid', 'id', 'node', 'storage'] as const) {
    if (member[key] !== undefined) out[key] = member[key];
  }
  return out;
}

const poolList = defineTool({
  name: 'pve_pool_list',
  category: 'pools',
  title: 'List resource pools',
  description:
    'Resource pools with comment. Without poolid every pool is listed with its member count. ' +
    'With poolid the pool is returned with its members (VMs, containers and storages), type ' +
    'narrows the members to qemu, lxc or storage. Works on Proxmox VE 8 and 9.',
  access: 'read',
  input: {
    poolid: poolIdSchema.optional(),
    type: z.enum(['qemu', 'lxc', 'storage']).optional().describe('With poolid: only these members'),
  },
  handler: async (args, ctx) => {
    if (args.poolid) {
      const pool = await readPool(ctx.client, args.poolid, args.type);
      const members = Array.isArray(pool.members) ? (pool.members as Row[]) : [];
      return {
        poolid: args.poolid,
        comment: pool.comment,
        memberCount: members.length,
        members: members.map(brief),
      };
    }
    const rows = (await ctx.client.get<Row[]>('/pools')) ?? [];
    return {
      count: rows.length,
      pools: rows.map((r) => ({
        poolid: r.poolid,
        comment: r.comment,
        ...(Array.isArray(r.members) ? { memberCount: r.members.length } : {}),
      })),
    };
  },
});

const poolSet = defineTool({
  name: 'pve_pool_set',
  category: 'pools',
  title: 'Create or change a pool',
  description:
    'Create a pool when poolid does not exist yet, otherwise change it. comment sets the description. ' +
    'vms (VMIDs) and storage (storage ids) are added to the pool, with remove: true they are ' +
    'removed from it instead. A guest that is already in another pool is refused unless ' +
    'allowMove: true moves it. Removing members is the way to empty a pool before pve_pool_delete.',
  access: 'write',
  input: {
    poolid: poolIdSchema,
    comment: z
      .string()
      .max(256)
      .optional()
      .describe('Description of the pool, set on create or change'),
    vms: z.array(vmidSchema).max(200).optional().describe('VMIDs to add (or remove)'),
    storage: z.array(storageIdSchema).max(50).optional().describe('Storage ids to add (or remove)'),
    remove: z.boolean().optional().describe('Remove the listed vms and storage instead of adding'),
    allowMove: z.boolean().optional().describe('Allow taking guests from another pool'),
  },
  handler: async (args, ctx) => {
    const { client } = ctx;
    const poolid = args.poolid;
    const hasMembers = (args.vms?.length ?? 0) > 0 || (args.storage?.length ?? 0) > 0;
    if (args.remove && !hasMembers) {
      throw new Error('remove: true needs vms or storage to remove.');
    }

    const existing = (await client.get<Row[]>('/pools')) ?? [];
    const exists = existing.some((p) => p.poolid === poolid);
    if (!exists && args.remove) throw new Error(`Pool "${poolid}" does not exist.`);

    if (!exists) {
      await client.post('/pools', { poolid, comment: args.comment });
    }

    const put = (params: Params): Promise<unknown> =>
      withFallback(
        () => client.put('/pools', { poolid, ...params }),
        () => client.put(legacyPoolPath(poolid), params),
      );

    // A comment of an existing pool rides along with an add, otherwise it needs its own call.
    const commentWithMembers = exists && hasMembers && !args.remove;
    if (exists && args.comment !== undefined && !commentWithMembers) {
      await put({ comment: args.comment });
    }
    if (hasMembers) {
      await put({
        vms: args.vms?.length ? args.vms.join(',') : undefined,
        storage: args.storage?.length ? args.storage.join(',') : undefined,
        delete: args.remove ? true : undefined,
        'allow-move': args.allowMove,
        comment: commentWithMembers ? args.comment : undefined,
      });
    }
    return {
      poolid,
      created: !exists,
      ...(hasMembers
        ? { [args.remove ? 'removed' : 'added']: { vms: args.vms, storage: args.storage } }
        : {}),
    };
  },
});

const poolDelete = defineTool({
  name: 'pve_pool_delete',
  category: 'pools',
  title: 'Delete a pool',
  description:
    'Delete a pool. Proxmox only deletes empty pools, remove the members first with ' +
    'pve_pool_set (remove: true). The guests and storages themselves are not touched.',
  access: 'destructive',
  input: { poolid: poolIdSchema },
  confirmTarget: (args) => `delete pool ${args.poolid} (members are not touched)`,
  handler: async (args, ctx) => {
    const { client } = ctx;
    await withFallback(
      () => client.delete('/pools', { poolid: args.poolid }),
      () => client.delete(legacyPoolPath(args.poolid)),
    );
    return { poolid: args.poolid, deleted: true };
  },
});

export const poolTools: AnyToolDef[] = [poolList, poolSet, poolDelete];
