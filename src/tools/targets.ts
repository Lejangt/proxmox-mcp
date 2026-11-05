import type { GuestType } from '../proxmox/guests.js';
import { cutMiddle, printableAscii } from '../server/confirm.js';
import type { ToolContext } from '../server/registry.js';
import { defaultNode, storageNode } from './resolve-node.js';

/*
 * Helpers for confirmTarget: short, concrete descriptions of what a call
 * affects, shown to the user in the confirmation question. Values from the
 * arguments and from Proxmox are quoted with JSON escaping, every character
 * outside printable ASCII is shown as \uXXXX, and long values are cut in the
 * middle so their start and end stay visible. A crafted value cannot add
 * lines, reorder text or hide its end in the question. Lookups never fail the
 * confirmation: on any error the plain arguments are shown.
 */

const MAX_VALUE = 200;

/**
 * A value in double quotes, JSON escaped with everything outside printable
 * ASCII as \uXXXX. Longer than `max` characters, the middle is left out.
 */
export function quote(value: string, max = MAX_VALUE): string {
  return printableAscii(JSON.stringify(cutMiddle(value, max)));
}

/** A JSON rendering of a list or object in printable ASCII, cut in the middle beyond `max`. */
export function jsonText(value: unknown, max = 300): string {
  return cutMiddle(printableAscii(JSON.stringify(value) ?? 'null'), max);
}

interface ResourceRow {
  vmid?: number;
  name?: string;
  node?: string;
  type?: string;
}

/** Guest names are DNS names in Proxmox, anything else is shown quoted and cut. */
function guestName(name: unknown): string | undefined {
  return typeof name === 'string' && name.length > 0 ? quote(name, 63) : undefined;
}

/**
 * `VMID 100 ("web01", qemu on node pve1)`. Name, type and node come from
 * /cluster/resources when the token may read it, otherwise from the arguments.
 */
export async function guestLabel(
  ctx: ToolContext,
  args: { vmid: number; node?: string | undefined; type?: GuestType | undefined },
): Promise<string> {
  let row: ResourceRow | undefined;
  try {
    const rows = await ctx.client.get<ResourceRow[]>('/cluster/resources', { type: 'vm' });
    row = (Array.isArray(rows) ? rows : []).find(
      (r) =>
        r.vmid === args.vmid &&
        (r.type === 'qemu' || r.type === 'lxc') &&
        (!args.node || r.node === args.node) &&
        (!args.type || r.type === args.type),
    );
  } catch {
    row = undefined;
  }
  const name = guestName(row?.name);
  const type = row?.type ?? args.type;
  const node = row?.node ?? args.node;
  const details = [
    name,
    [type, node ? `on node ${node}` : undefined].filter(Boolean).join(' ') || undefined,
  ].filter(Boolean);
  return `VMID ${args.vmid}${details.length > 0 ? ` (${details.join(', ')})` : ''}`;
}

/** The given node, or the only node of the host, or a note that it is not known yet. */
export async function nodeLabel(ctx: ToolContext, node: string | undefined): Promise<string> {
  try {
    return `node ${await defaultNode(ctx.client, node)}`;
  } catch {
    return node ? `node ${node}` : 'the only node of the host';
  }
}

/** `storage local on node pve1`, the node is looked up like the tool does it. */
export async function storageLabel(
  ctx: ToolContext,
  storage: string,
  node: string | undefined,
): Promise<string> {
  try {
    return `storage ${storage} on node ${await storageNode(ctx.client, storage, node)}`;
  } catch {
    return `storage ${storage}${node ? ` on node ${node}` : ''}`;
  }
}
