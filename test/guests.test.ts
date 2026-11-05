import { describe, expect, it } from 'vitest';
import { guestPath, resolveGuest } from '../src/proxmox/guests.js';
import { fakeClient } from './helpers/fake-client.js';

const resources = [
  {
    id: 'qemu/100',
    type: 'qemu',
    vmid: 100,
    node: 'pve1',
    name: 'web',
    status: 'running',
    template: 0,
  },
  {
    id: 'lxc/200',
    type: 'lxc',
    vmid: 200,
    node: 'pve2',
    name: 'db',
    status: 'stopped',
    template: 1,
  },
];

describe('resolveGuest', () => {
  it('looks the guest up in cluster resources', async () => {
    const client = fakeClient({ 'GET /cluster/resources': resources });
    const g = await resolveGuest(client, 200);
    expect(g).toEqual({
      vmid: 200,
      node: 'pve2',
      type: 'lxc',
      name: 'db',
      status: 'stopped',
      template: true,
    });
    expect(client.calls[0]?.params).toEqual({ type: 'vm' });
  });

  it('skips the lookup when node and type are given', async () => {
    const client = fakeClient();
    expect(await resolveGuest(client, 100, { node: 'pve1', type: 'qemu' })).toEqual({
      vmid: 100,
      node: 'pve1',
      type: 'qemu',
    });
    expect(client.calls).toHaveLength(0);
  });

  it('applies a partial hint as a filter', async () => {
    const client = fakeClient({ 'GET /cluster/resources': resources });
    await expect(resolveGuest(client, 100, { type: 'lxc' })).rejects.toThrow(/type lxc/);
    expect((await resolveGuest(client, 100, { node: 'pve1' })).type).toBe('qemu');
  });

  it('gives a clear error for an unknown VMID', async () => {
    const client = fakeClient({ 'GET /cluster/resources': resources }, { alias: 'lab' });
    await expect(resolveGuest(client, 999)).rejects.toThrow(
      /VMID 999 found on host "lab".*pve_guest_list/,
    );
  });
});

describe('guestPath', () => {
  it('builds the path with and without suffix', () => {
    const g = { vmid: 100, node: 'pve1', type: 'qemu' as const };
    expect(guestPath(g)).toBe('/nodes/pve1/qemu/100');
    expect(guestPath(g, '/status/current')).toBe('/nodes/pve1/qemu/100/status/current');
  });

  it('encodes the node and rejects odd suffixes', () => {
    expect(guestPath({ vmid: 1, node: 'a:b', type: 'lxc' })).toBe('/nodes/a%3Ab/lxc/1');
    expect(() => guestPath({ vmid: 1, node: 'a/b', type: 'lxc' })).toThrow(TypeError);
    const g = { vmid: 1, node: 'pve1', type: 'lxc' as const };
    expect(() => guestPath(g, 'status')).toThrow();
    expect(() => guestPath(g, '/../x')).toThrow();
    expect(() => guestPath(g, '/x?y=1')).toThrow();
  });
});
