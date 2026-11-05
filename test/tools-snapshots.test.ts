import { describe, expect, it } from 'vitest';
import { snapshotTools } from '../src/tools/snapshots.js';
import { callTool, UPID } from './helpers/call-tool.js';
import { fakeClient } from './helpers/fake-client.js';

const resources = [
  { type: 'qemu', vmid: 100, node: 'pve1' },
  { type: 'lxc', vmid: 200, node: 'pve2' },
];

describe('snapshot tools', () => {
  it('uses the contract names, categories and access levels', () => {
    expect(snapshotTools.map((t) => `${t.name}:${t.category}:${t.access}`)).toEqual([
      'pve_snapshot_list:snapshots:read',
      'pve_snapshot_create:snapshots:write',
      'pve_snapshot_rollback:snapshots:destructive',
      'pve_snapshot_delete:snapshots:destructive',
    ]);
  });

  it('lists snapshots without the pseudo entry current', async () => {
    const client = fakeClient({
      'GET /cluster/resources': resources,
      'GET /nodes/pve1/qemu/100/snapshot': [
        { name: 'before', description: 'x', snaptime: 1700000000, vmstate: 1 },
        { name: 'current', parent: 'before' },
      ],
    });
    const out = (await callTool(snapshotTools, 'pve_snapshot_list', { vmid: 100 }, client)) as {
      currentParent: string;
      snapshots: Array<{ name: string; time: string; vmstate: boolean }>;
    };
    expect(out.currentParent).toBe('before');
    expect(out.snapshots).toHaveLength(1);
    expect(out.snapshots[0]).toMatchObject({
      name: 'before',
      time: '2023-11-14T22:13:20.000Z',
      vmstate: true,
    });
  });

  it('creates a VM snapshot with vmstate and a container snapshot without it', async () => {
    const client = fakeClient({
      'GET /cluster/resources': resources,
      'POST /nodes/pve1/qemu/100/snapshot': UPID,
      'POST /nodes/pve2/lxc/200/snapshot': UPID,
    });
    await callTool(
      snapshotTools,
      'pve_snapshot_create',
      { vmid: 100, snapname: 'snap1', description: 'd', vmstate: true, wait: false },
      client,
    );
    expect(client.calls.at(-1)).toMatchObject({
      method: 'POST',
      path: '/nodes/pve1/qemu/100/snapshot',
      params: { snapname: 'snap1', description: 'd', vmstate: true },
    });
    await callTool(
      snapshotTools,
      'pve_snapshot_create',
      { vmid: 200, snapname: 'snap1', wait: false },
      client,
    );
    expect(client.calls.at(-1)?.params).not.toHaveProperty('vmstate');
    await expect(
      callTool(
        snapshotTools,
        'pve_snapshot_create',
        { vmid: 200, snapname: 's', vmstate: true },
        client,
      ),
    ).rejects.toThrow(/not supported for containers/);
  });

  it('rolls back with start and deletes with force', async () => {
    const client = fakeClient({
      'GET /cluster/resources': resources,
      'POST /nodes/pve1/qemu/100/snapshot/snap1/rollback': UPID,
      'DELETE /nodes/pve1/qemu/100/snapshot/snap1': UPID,
    });
    await callTool(
      snapshotTools,
      'pve_snapshot_rollback',
      { vmid: 100, snapname: 'snap1', start: true, wait: false },
      client,
    );
    expect(client.calls.at(-1)).toMatchObject({ method: 'POST', params: { start: true } });
    await callTool(
      snapshotTools,
      'pve_snapshot_delete',
      { vmid: 100, snapname: 'snap1', force: true, wait: false },
      client,
    );
    expect(client.calls.at(-1)).toMatchObject({ method: 'DELETE', params: { force: true } });
  });

  it('rejects snapshot names that Proxmox would refuse', async () => {
    const client = fakeClient({ 'GET /cluster/resources': resources });
    await expect(
      callTool(snapshotTools, 'pve_snapshot_create', { vmid: 100, snapname: '1bad name' }, client),
    ).rejects.toThrow();
  });
});
