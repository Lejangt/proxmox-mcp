import { z } from 'zod';
import { ProxmoxApiError } from '../proxmox/errors.js';
import { resolveGuest, type GuestType } from '../proxmox/guests.js';
import { pvePath } from '../proxmox/path.js';
import { defineTool, type AnyToolDef, type ToolContext } from '../server/registry.js';
import { guestTypeSchema, vmidSchema } from './common.js';
import { guestLabel } from './targets.js';

type Row = Record<string, unknown>;

const SID_RE = /^(vm|ct):([0-9]{3,9})$/;

/** Either an HA resource id or the VMID of a guest, never both. */
const resourceTarget = {
  sid: z
    .string()
    .regex(SID_RE, 'expected vm:<vmid> or ct:<vmid>')
    .optional()
    .describe(
      'HA resource id: vm:<vmid> for a VM, ct:<vmid> for a container, for example "vm:100"',
    ),
  vmid: vmidSchema
    .optional()
    .describe('Alternative to sid: the guest VMID, the sid is derived from the guest type'),
  type: guestTypeSchema
    .optional()
    .describe('With vmid: qemu or lxc. Optional, looked up from the VMID when omitted.'),
};

interface TargetArgs {
  sid?: string | undefined;
  vmid?: number | undefined;
  type?: GuestType | undefined;
}

/**
 * Builds the HA resource id. The prefix is `vm` for QEMU and `ct` for LXC, so a
 * VMID alone is enough once the guest type is known. Passing both sid and vmid
 * is refused because a mismatch would silently act on the wrong guest.
 */
export async function haSid(ctx: ToolContext, args: TargetArgs): Promise<string> {
  if (args.sid !== undefined && args.vmid !== undefined) {
    throw new Error('Pass either sid or vmid, not both.');
  }
  if (args.sid !== undefined) return args.sid;
  if (args.vmid === undefined) throw new Error('Pass sid (for example vm:100) or vmid.');
  const type = args.type ?? (await resolveGuest(ctx.client, args.vmid)).type;
  return `${type === 'lxc' ? 'ct' : 'vm'}:${args.vmid}`;
}

const WHAT = ['status', 'resources', 'groups', 'rules'] as const;

const WHAT_PATHS: Record<(typeof WHAT)[number], string> = {
  status: '/cluster/ha/status/current',
  resources: '/cluster/ha/resources',
  groups: '/cluster/ha/groups',
  rules: '/cluster/ha/rules',
};

const haStatus = defineTool({
  name: 'pve_ha_status',
  category: 'ha',
  title: 'HA status',
  description:
    'High availability information. what: status (manager state, quorum, per node and per service ' +
    'state), resources (configured HA resources with requested state, group, restart limits), ' +
    'groups (deprecated since Proxmox VE 9, replaced by rules, may be empty or missing) or rules ' +
    '(node-affinity and resource-affinity rules, Proxmox VE 9 and newer). When groups or rules do ' +
    'not exist on the host the result says so instead of failing.',
  access: 'read',
  input: { what: z.enum(WHAT).describe('status, resources, groups or rules') },
  handler: async (args, ctx) => {
    try {
      const data = await ctx.client.get<unknown>(WHAT_PATHS[args.what]);
      const items = Array.isArray(data) ? (data as Row[]) : [];
      return {
        what: args.what,
        count: items.length,
        items,
        ...(args.what === 'groups' && items.length === 0
          ? {
              note: 'No HA groups. On Proxmox VE 9 groups are migrated to node-affinity rules, use what: rules.',
            }
          : {}),
      };
    } catch (err) {
      const missing =
        err instanceof ProxmoxApiError &&
        (args.what === 'groups' || args.what === 'rules') &&
        (err.status === 404 ||
          err.status === 501 ||
          err.status === 400 ||
          // Proxmox VE 9.2 answers GET /cluster/ha/groups with HTTP 500 once groups are migrated.
          (err.status === 500 &&
            args.what === 'groups' &&
            /migrated to rules/i.test(err.proxmoxMessage ?? err.message)));
      if (!missing) throw err;
      return {
        what: args.what,
        available: false,
        note:
          args.what === 'rules'
            ? 'This Proxmox version has no HA rules (introduced with Proxmox VE 9). Use what: groups instead.'
            : 'This Proxmox version has no HA groups endpoint (replaced by rules in Proxmox VE 9). Use what: rules.',
        error: err.message,
      };
    }
  },
});

const HA_STATES = ['started', 'stopped', 'disabled', 'ignored'] as const;

const haResourceSet = defineTool({
  name: 'pve_ha_resource_set',
  category: 'ha',
  title: 'Add or change an HA resource',
  description:
    'Put a VM or container under HA management, or change its HA settings. Identify it by sid ' +
    '(vm:100 or ct:100) or by vmid. Without update the resource is added, with update: true an ' +
    'existing one is changed (`delete` clears settings, digest guards against concurrent edits). ' +
    'state is what the HA manager enforces: started (default), stopped (the guest is shut down and ' +
    'kept off), disabled (stopped, no recovery on node failure, also the way out of an error state) ' +
    'or ignored (HA leaves it alone). Setting stopped or disabled stops a running guest. ' +
    'group is deprecated on Proxmox VE 9 in favor of HA rules. max_restart and max_relocate limit ' +
    'recovery attempts.',
  access: 'write',
  input: {
    ...resourceTarget,
    update: z.boolean().optional().describe('true: change an existing HA resource'),
    state: z
      .enum(HA_STATES)
      .optional()
      .describe(
        'started (default), stopped (guest shut down and kept off), disabled (no recovery on node failure) or ignored (HA leaves it alone)',
      ),
    group: z.string().max(64).optional().describe('HA group id (deprecated on Proxmox VE 9)'),
    max_restart: z
      .number()
      .int()
      .min(0)
      .max(10)
      .optional()
      .describe('Restart attempts on the same node after a failed start, 0 to 10'),
    max_relocate: z
      .number()
      .int()
      .min(0)
      .max(10)
      .optional()
      .describe('Relocation attempts to other nodes after a failed start, 0 to 10'),
    failback: z.boolean().optional().describe('Proxmox VE 9: migrate back to the preferred node'),
    comment: z.string().max(256).optional().describe('Free text comment for the HA resource'),
    delete: z
      .array(z.string().regex(/^[A-Za-z][A-Za-z0-9_-]*$/))
      .max(10)
      .optional()
      .describe('update only: settings to remove, for example ["group", "comment"]'),
    digest: z
      .string()
      .regex(/^[A-Fa-f0-9]{40,128}$/)
      .optional()
      .describe('update only: digest from pve_ha_status resources'),
  },
  handler: async (args, ctx) => {
    const sid = await haSid(ctx, args);
    const settings = {
      state: args.state,
      group: args.group,
      max_restart: args.max_restart,
      max_relocate: args.max_relocate,
      failback: args.failback,
      comment: args.comment,
    };
    if (!args.update) {
      if (args.delete?.length || args.digest) {
        throw new Error('delete and digest only apply together with update: true.');
      }
      await ctx.client.post('/cluster/ha/resources', { sid, ...settings });
      return { sid, action: 'added', state: args.state ?? 'started' };
    }
    await ctx.client.put(pvePath`/cluster/ha/resources/${sid}`, {
      ...settings,
      delete: args.delete?.length ? args.delete.join(',') : undefined,
      digest: args.digest,
    });
    return { sid, action: 'updated' };
  },
});

const haResourceRemove = defineTool({
  name: 'pve_ha_resource_remove',
  category: 'ha',
  title: 'Remove an HA resource',
  description:
    'Remove a VM or container from HA management, by sid (vm:100, ct:100) or vmid. The guest itself ' +
    'keeps running or stays stopped as it is, but it is no longer restarted or recovered on node ' +
    'failure. purge: true also removes the resource from HA rules that reference it (Proxmox VE 9), ' +
    'rules left without a resource are deleted.',
  access: 'destructive',
  input: {
    ...resourceTarget,
    purge: z.boolean().optional().describe('Also remove the resource from HA rules'),
  },
  confirmTarget: async (args, ctx) => {
    const match = args.sid !== undefined ? SID_RE.exec(args.sid) : null;
    const vmid = args.vmid ?? (match ? Number(match[2]) : undefined);
    const guest = vmid === undefined ? undefined : await guestLabel(ctx, { vmid, type: args.type });
    return `remove ${args.sid ?? 'the HA resource'}${guest ? ` of ${guest}` : ''} from HA${args.purge ? ', also from HA rules' : ''}`;
  },
  handler: async (args, ctx) => {
    const sid = await haSid(ctx, args);
    await ctx.client.delete(pvePath`/cluster/ha/resources/${sid}`, { purge: args.purge });
    return { sid, removed: true };
  },
});

export const haTools: AnyToolDef[] = [haStatus, haResourceSet, haResourceRemove];
