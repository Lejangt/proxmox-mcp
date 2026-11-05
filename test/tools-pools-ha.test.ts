import { describe, expect, it } from 'vitest';
import { ProxmoxApiError } from '../src/proxmox/errors.js';
import { haSid, haTools } from '../src/tools/ha.js';
import { poolTools } from '../src/tools/pools.js';
import { callTool } from './helpers/call-tool.js';
import { fakeClient, type FakeClient } from './helpers/fake-client.js';
import { fakeContext } from './helpers/fixtures.js';

const last = (c: FakeClient) => c.calls[c.calls.length - 1];
const runPool = (c: FakeClient, name: string, args: Record<string, unknown> = {}) =>
  callTool(poolTools, name, args, c);
const runHa = (c: FakeClient, name: string, args: Record<string, unknown> = {}) =>
  callTool(haTools, name, args, c);

const apiError = (status: number, method: string, path: string, errors?: Record<string, string>) =>
  new ProxmoxApiError({ status, method, path, ...(errors ? { errors } : {}) });

const members = [
  { id: 'qemu/100', type: 'qemu', vmid: 100, node: 'pve1' },
  { id: 'storage/pve1/local', type: 'storage', storage: 'local', node: 'pve1' },
];

describe('pool tools', () => {
  it('uses the contract names, categories and access levels', () => {
    expect(poolTools.map((t) => `${t.name}:${t.category}:${t.access}`)).toEqual([
      'pve_pool_list:pools:read',
      'pve_pool_set:pools:write',
      'pve_pool_delete:pools:destructive',
    ]);
  });

  it('lists all pools with member counts', async () => {
    const c = fakeClient({
      'GET /pools': [{ poolid: 'web', comment: 'c', members }, { poolid: 'empty' }],
    } as never);
    expect(await runPool(c, 'pve_pool_list')).toEqual({
      count: 2,
      pools: [
        { poolid: 'web', comment: 'c', memberCount: 2 },
        { poolid: 'empty', comment: undefined },
      ],
    });
  });

  it('reads one pool through the PVE 9 form (list answer)', async () => {
    const c = fakeClient({ 'GET /pools': [{ poolid: 'web', comment: 'c', members }] } as never);
    const out = (await runPool(c, 'pve_pool_list', { poolid: 'web', type: 'qemu' })) as {
      memberCount: number;
      members: Array<Record<string, unknown>>;
    };
    expect(last(c)).toMatchObject({ path: '/pools', params: { poolid: 'web', type: 'qemu' } });
    expect(out.memberCount).toBe(2);
    expect(out.members[0]).toEqual({ type: 'qemu', vmid: 100, id: 'qemu/100', node: 'pve1' });
  });

  it('falls back to /pools/{poolid} when the poolid parameter is not supported', async () => {
    const c = fakeClient({
      'GET /pools': () => {
        throw apiError(400, 'GET', '/pools', { poolid: 'property is not defined in schema' });
      },
      'GET /pools/web': { comment: 'old', members },
    } as never);
    const out = (await runPool(c, 'pve_pool_list', { poolid: 'web' })) as {
      comment: string;
      memberCount: number;
    };
    expect(last(c)?.path).toBe('/pools/web');
    expect(out).toMatchObject({ poolid: 'web', comment: 'old', memberCount: 2 });
  });

  it('does not hide other errors behind the fallback', async () => {
    const c = fakeClient({
      'GET /pools': () => {
        throw apiError(403, 'GET', '/pools');
      },
    } as never);
    await expect(runPool(c, 'pve_pool_list', { poolid: 'web' })).rejects.toThrow(/403/);
    expect(c.calls).toHaveLength(1);
  });

  it('creates a missing pool, then adds members with one PUT', async () => {
    const c = fakeClient({
      'GET /pools': [],
      'POST /pools': null,
      'PUT /pools': null,
    } as never);
    const out = await runPool(c, 'pve_pool_set', {
      poolid: 'web',
      comment: 'Web tier',
      vms: [100, 101],
      storage: ['local'],
      allowMove: true,
    });
    expect(c.calls.map((x) => `${x.method} ${x.path}`)).toEqual([
      'GET /pools',
      'POST /pools',
      'PUT /pools',
    ]);
    expect(c.calls[1]?.params).toMatchObject({ poolid: 'web', comment: 'Web tier' });
    expect(last(c)?.params).toMatchObject({
      poolid: 'web',
      vms: '100,101',
      storage: 'local',
      'allow-move': true,
    });
    expect(last(c)?.params?.delete).toBeUndefined();
    expect(out).toMatchObject({ poolid: 'web', created: true });
  });

  it('changes only the comment of an existing pool and removes members with delete', async () => {
    const c = fakeClient({ 'GET /pools': [{ poolid: 'web' }], 'PUT /pools': null } as never);
    await runPool(c, 'pve_pool_set', { poolid: 'web', comment: 'new' });
    expect(c.calls.map((x) => `${x.method} ${x.path}`)).toEqual(['GET /pools', 'PUT /pools']);
    expect(last(c)?.params).toEqual({ poolid: 'web', comment: 'new' });

    await runPool(c, 'pve_pool_set', { poolid: 'web', vms: [100], remove: true });
    expect(last(c)?.params).toMatchObject({ poolid: 'web', vms: '100', delete: true });
    await expect(runPool(c, 'pve_pool_set', { poolid: 'web', remove: true })).rejects.toThrow(
      /needs vms/,
    );
  });

  it('refuses to remove members from a pool that does not exist', async () => {
    const c = fakeClient({ 'GET /pools': [] } as never);
    await expect(
      runPool(c, 'pve_pool_set', { poolid: 'x1', vms: [100], remove: true }),
    ).rejects.toThrow(/does not exist/);
    expect(c.calls.every((x) => x.method === 'GET')).toBe(true);
  });

  it('uses the path form for updates on versions without PUT /pools', async () => {
    const c = fakeClient({
      'GET /pools': [{ poolid: 'web' }],
      'PUT /pools': () => {
        throw apiError(501, 'PUT', '/pools');
      },
      'PUT /pools/web': null,
    } as never);
    await runPool(c, 'pve_pool_set', { poolid: 'web', vms: [100] });
    expect(last(c)).toMatchObject({ method: 'PUT', path: '/pools/web', params: { vms: '100' } });
    expect(last(c)?.params).not.toHaveProperty('poolid');
  });

  it('deletes with the collection form and falls back to the path form', async () => {
    const c = fakeClient({ 'DELETE /pools': null } as never);
    await runPool(c, 'pve_pool_delete', { poolid: 'web' });
    expect(last(c)).toMatchObject({ method: 'DELETE', path: '/pools', params: { poolid: 'web' } });

    const old = fakeClient({
      'DELETE /pools': () => {
        throw apiError(501, 'DELETE', '/pools');
      },
      'DELETE /pools/web': null,
    } as never);
    expect(await runPool(old, 'pve_pool_delete', { poolid: 'web' })).toMatchObject({
      deleted: true,
    });
    expect(last(old)?.path).toBe('/pools/web');
    const tool = poolTools.find((t) => t.name === 'pve_pool_delete');
    expect(tool?.confirmTarget?.({ poolid: 'web' } as never, fakeContext(old))).toBe(
      'delete pool web (members are not touched)',
    );
  });
});

const resources = [
  { type: 'qemu', vmid: 100, node: 'pve1' },
  { type: 'lxc', vmid: 200, node: 'pve1' },
];

describe('ha tools', () => {
  it('uses the contract names, categories and access levels', () => {
    expect(haTools.map((t) => `${t.name}:${t.category}:${t.access}`)).toEqual([
      'pve_ha_status:ha:read',
      'pve_ha_resource_set:ha:write',
      'pve_ha_resource_remove:ha:destructive',
    ]);
  });

  it.each([
    ['status', '/cluster/ha/status/current'],
    ['resources', '/cluster/ha/resources'],
    ['groups', '/cluster/ha/groups'],
    ['rules', '/cluster/ha/rules'],
  ])('reads %s from %s', async (what, path) => {
    const c = fakeClient({ [`GET ${path}`]: [{ sid: 'vm:100', state: 'started' }] } as never);
    const out = await runHa(c, 'pve_ha_status', { what });
    expect(last(c)?.path).toBe(path);
    expect(out).toMatchObject({ what, count: 1 });
  });

  it('reports missing groups and rules endpoints instead of failing', async () => {
    const c = fakeClient({
      'GET /cluster/ha/rules': () => {
        throw apiError(501, 'GET', '/cluster/ha/rules');
      },
      'GET /cluster/ha/groups': [],
      'GET /cluster/ha/resources': () => {
        throw apiError(501, 'GET', '/cluster/ha/resources');
      },
    } as never);
    expect(await runHa(c, 'pve_ha_status', { what: 'rules' })).toMatchObject({
      available: false,
      note: expect.stringContaining('no HA rules'),
    });
    expect(await runHa(c, 'pve_ha_status', { what: 'groups' })).toMatchObject({
      count: 0,
      note: expect.stringContaining('what: rules'),
    });
    // A failing resources call is a real error and is not turned into an empty answer.
    await expect(runHa(c, 'pve_ha_status', { what: 'resources' })).rejects.toThrow(/501/);
  });

  it('reports the HTTP 500 that Proxmox VE 9.2 sends for migrated HA groups', async () => {
    const c = fakeClient({
      'GET /cluster/ha/groups': () => {
        throw new ProxmoxApiError({
          status: 500,
          method: 'GET',
          path: '/cluster/ha/groups',
          proxmoxMessage: 'cannot index groups: ha groups have been migrated to rules',
        });
      },
    } as never);
    expect(await runHa(c, 'pve_ha_status', { what: 'groups' })).toMatchObject({
      available: false,
      note: expect.stringContaining('what: rules'),
    });
  });

  it('keeps other HTTP 500 answers for groups as errors', async () => {
    const c = fakeClient({
      'GET /cluster/ha/groups': () => {
        throw apiError(500, 'GET', '/cluster/ha/groups');
      },
    } as never);
    await expect(runHa(c, 'pve_ha_status', { what: 'groups' })).rejects.toThrow(/500/);
  });

  it('builds the sid from the guest type', async () => {
    const c = fakeClient({ 'GET /cluster/resources': resources } as never);
    const ctx = fakeContext(c);
    expect(await haSid(ctx, { sid: 'ct:200' })).toBe('ct:200');
    expect(await haSid(ctx, { vmid: 100 })).toBe('vm:100');
    expect(await haSid(ctx, { vmid: 200 })).toBe('ct:200');
    const before = c.calls.length;
    expect(await haSid(ctx, { vmid: 300, type: 'lxc' })).toBe('ct:300');
    expect(await haSid(ctx, { vmid: 301, type: 'qemu' })).toBe('vm:301');
    expect(c.calls).toHaveLength(before);
    await expect(haSid(ctx, { sid: 'vm:100', vmid: 100 })).rejects.toThrow(/either sid or vmid/);
    await expect(haSid(ctx, {})).rejects.toThrow(/sid/);
  });

  it('validates the sid format', async () => {
    const c = fakeClient();
    await expect(runHa(c, 'pve_ha_resource_set', { sid: 'vm:abc' })).rejects.toThrow();
    await expect(runHa(c, 'pve_ha_resource_set', { sid: 'lxc:100' })).rejects.toThrow();
  });

  it('adds a resource with POST and the derived sid', async () => {
    const c = fakeClient({
      'GET /cluster/resources': resources,
      'POST /cluster/ha/resources': null,
    } as never);
    const out = await runHa(c, 'pve_ha_resource_set', {
      vmid: 200,
      state: 'started',
      group: 'g1',
      max_restart: 2,
      max_relocate: 1,
      comment: 'db',
    });
    expect(last(c)).toMatchObject({
      method: 'POST',
      path: '/cluster/ha/resources',
      params: {
        sid: 'ct:200',
        state: 'started',
        group: 'g1',
        max_restart: 2,
        max_relocate: 1,
        comment: 'db',
      },
    });
    expect(out).toMatchObject({ sid: 'ct:200', action: 'added' });
    await expect(
      runHa(c, 'pve_ha_resource_set', { sid: 'vm:100', delete: ['group'] }),
    ).rejects.toThrow(/only apply together with update/);
  });

  it('updates an existing resource with PUT on the sid path', async () => {
    const c = fakeClient({ 'PUT /cluster/ha/resources/vm%3A100': null } as never);
    await runHa(c, 'pve_ha_resource_set', {
      sid: 'vm:100',
      update: true,
      state: 'disabled',
      delete: ['group', 'comment'],
      digest: 'f'.repeat(40),
    });
    expect(last(c)).toMatchObject({
      method: 'PUT',
      path: '/cluster/ha/resources/vm%3A100',
      params: { state: 'disabled', delete: 'group,comment', digest: 'f'.repeat(40) },
    });
    expect(last(c)?.params).not.toHaveProperty('sid');
  });

  it('removes a resource, with optional purge and the sid in the confirmation', async () => {
    const c = fakeClient({ 'DELETE /cluster/ha/resources/ct%3A200': null } as never);
    await runHa(c, 'pve_ha_resource_remove', { sid: 'ct:200', purge: true });
    expect(last(c)).toMatchObject({
      method: 'DELETE',
      path: '/cluster/ha/resources/ct%3A200',
      params: { purge: true },
    });
    const tool = haTools.find((t) => t.name === 'pve_ha_resource_remove');
    const lookup = fakeContext(
      fakeClient({
        'GET /cluster/resources': [{ vmid: 100, type: 'qemu', node: 'pve1', name: 'web01' }],
      } as never),
    );
    expect(await tool?.confirmTarget?.({ sid: 'vm:100' } as never, lookup)).toBe(
      'remove vm:100 of VMID 100 ("web01", qemu on node pve1) from HA',
    );
    expect(await tool?.confirmTarget?.({ vmid: 100, purge: true } as never, lookup)).toBe(
      'remove the HA resource of VMID 100 ("web01", qemu on node pve1) from HA, also from HA rules',
    );
  });
});
