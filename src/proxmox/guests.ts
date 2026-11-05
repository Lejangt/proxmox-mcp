import type { ProxmoxClient } from './types.js';
import { pvePath } from './path.js';

export type GuestType = 'qemu' | 'lxc';

export interface GuestRef {
  vmid: number;
  node: string;
  type: GuestType;
  name?: string;
  status?: string;
  template?: boolean;
}

interface ClusterVm {
  vmid?: number;
  node?: string;
  type?: string;
  name?: string;
  status?: string;
  template?: number | boolean;
}

/**
 * Finds node and type of a guest. With node and type in the hint no request is
 * made, which also covers setups where /cluster/resources is not permitted.
 */
export async function resolveGuest(
  client: ProxmoxClient,
  vmid: number,
  hint: { node?: string; type?: GuestType } = {},
): Promise<GuestRef> {
  if (hint.node && hint.type) return { vmid, node: hint.node, type: hint.type };

  const rows = await client.get<ClusterVm[]>('/cluster/resources', { type: 'vm' });
  const matches = (Array.isArray(rows) ? rows : []).filter(
    (r) =>
      r.vmid === vmid &&
      (r.type === 'qemu' || r.type === 'lxc') &&
      (!hint.node || r.node === hint.node) &&
      (!hint.type || r.type === hint.type),
  );
  const row = matches[0];
  if (!row || !row.node) {
    const where = [hint.node ? `node "${hint.node}"` : '', hint.type ? `type ${hint.type}` : '']
      .filter(Boolean)
      .join(', ');
    throw new Error(
      `No guest with VMID ${vmid} found on host "${client.alias}"${where ? ` (${where})` : ''}. ` +
        'Use pve_guest_list to see the existing VMIDs, and check that the API token may view the guest (VM.Audit).',
    );
  }
  return {
    vmid,
    node: row.node,
    type: row.type as GuestType,
    ...(row.name !== undefined ? { name: row.name } : {}),
    ...(row.status !== undefined ? { status: row.status } : {}),
    ...(row.template !== undefined ? { template: Boolean(row.template) } : {}),
  };
}

/** `/nodes/{node}/{type}/{vmid}` plus an optional static suffix such as `/status/current`. */
export function guestPath(g: GuestRef, suffix = ''): string {
  if (suffix !== '' && (!suffix.startsWith('/') || /[?#]|\.\./.test(suffix))) {
    throw new Error(`Invalid guest path suffix: ${suffix}`);
  }
  return pvePath`/nodes/${g.node}/${g.type}/${g.vmid}` + suffix;
}
