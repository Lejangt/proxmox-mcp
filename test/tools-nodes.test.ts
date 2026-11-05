import { describe, expect, it } from 'vitest';
import { networkTools } from '../src/tools/network.js';
import { nodeTools } from '../src/tools/nodes.js';
import { callTool, UPID } from './helpers/call-tool.js';
import { envelope, fakeClient, type FakeClient } from './helpers/fake-client.js';
import { fakeContext } from './helpers/fixtures.js';

const NODES = [
  { node: 'pve1', status: 'online', cpu: 0.1, maxcpu: 8, mem: 1, maxmem: 2, uptime: 5, extra: 'x' },
];

const client = (routes: Record<string, unknown> = {}): FakeClient =>
  fakeClient({ 'GET /nodes': NODES, ...routes } as never);
const last = (c: FakeClient) => c.calls[c.calls.length - 1];
const runNode = (c: FakeClient, name: string, args: Record<string, unknown> = {}) =>
  callTool(nodeTools, name, args, c);
const runNet = (c: FakeClient, name: string, args: Record<string, unknown> = {}) =>
  callTool(networkTools, name, args, c);

describe('node tools', () => {
  it('uses the contract names, categories and access levels', () => {
    expect(nodeTools.map((t) => `${t.name}:${t.category}:${t.access}`)).toEqual([
      'pve_node_list:nodes:read',
      'pve_node_status:nodes:read',
      'pve_node_rrd:nodes:read',
      'pve_node_services:nodes:read',
      'pve_node_service_action:nodes:write',
      'pve_node_syslog:nodes:read',
      'pve_node_disks:nodes:read',
      'pve_node_apt_updates:nodes:read',
      'pve_node_power:nodes:destructive',
    ]);
  });

  it('lists nodes with a compact field set', async () => {
    const out = (await runNode(client(), 'pve_node_list')) as Array<Record<string, unknown>>;
    expect(out[0]).toEqual({
      node: 'pve1',
      status: 'online',
      cpu: 0.1,
      maxcpu: 8,
      mem: 1,
      maxmem: 2,
      uptime: 5,
    });
  });

  it('uses the only node when none is given and asks when there are several', async () => {
    const c = client({ 'GET /nodes/pve1/status': { kversion: 'Linux 6.8' } });
    const out = await runNode(c, 'pve_node_status');
    expect(out).toMatchObject({ node: 'pve1', kversion: 'Linux 6.8' });
    const two = fakeClient({ 'GET /nodes': [{ node: 'a' }, { node: 'b' }] } as never);
    await expect(runNode(two, 'pve_node_status')).rejects.toThrow(/several nodes \(a, b\)/);
  });

  it('condenses rrd data', async () => {
    const c = client({
      'GET /nodes/pve1/rrddata': [
        { time: 1700000000, cpu: 0.2 },
        { time: 1700000060, cpu: 0.4 },
      ],
    });
    const out = (await runNode(c, 'pve_node_rrd', { timeframe: 'hour' })) as {
      metrics: { cpu: { avg: number; max: number } };
      points: number;
    };
    expect(last(c)).toMatchObject({
      path: '/nodes/pve1/rrddata',
      params: { timeframe: 'hour', cf: 'AVERAGE' },
    });
    expect(out.points).toBe(2);
    expect(out.metrics.cpu.max).toBe(0.4);
  });

  it('lists services', async () => {
    const c = client({
      'GET /nodes/pve1/services': [
        { service: 'pveproxy', name: 'pveproxy', desc: 'x', state: 'running', junk: 1 },
      ],
    });
    const out = (await runNode(c, 'pve_node_services')) as {
      services: Array<Record<string, unknown>>;
    };
    expect(out.services[0]).toEqual({
      service: 'pveproxy',
      name: 'pveproxy',
      desc: 'x',
      state: 'running',
    });
  });

  it('runs a service action as a task and asks confirmation only for risky ones', async () => {
    const c = client({ 'POST /nodes/pve1/services/chrony/reload': UPID });
    await runNode(c, 'pve_node_service_action', {
      service: 'chrony',
      action: 'reload',
      wait: false,
    });
    expect(last(c)).toMatchObject({ method: 'POST', path: '/nodes/pve1/services/chrony/reload' });
    const tool = nodeTools.find((t) => t.name === 'pve_node_service_action');
    const asks = (service: string, action: string) =>
      tool?.needsConfirmation?.({ service, action } as never);
    expect(asks('chrony', 'reload')).toBe(false);
    expect(asks('chrony', 'restart')).toBe(false);
    expect(asks('pveproxy', 'restart')).toBe(true);
    expect(asks('chrony', 'stop')).toBe(true);
    await expect(
      runNode(c, 'pve_node_service_action', { service: '../x', action: 'start' }),
    ).rejects.toThrow();
  });

  it('reads the journal with lastentries, or a capped range', async () => {
    const lines = Array.from({ length: 5 }, (_, i) => `line ${i}`);
    const c = client({ 'GET /nodes/pve1/journal': lines });
    const plain = (await runNode(c, 'pve_node_syslog', { limit: 3 })) as { lines: string[] };
    expect(last(c)?.params).toMatchObject({ lastentries: 3 });
    // The cap also holds when a server ignores lastentries.
    expect(plain.lines).toEqual(['line 2', 'line 3', 'line 4']);

    const ranged = (await runNode(c, 'pve_node_syslog', {
      since: '2026-01-01T00:00:00Z',
      until: 1767312000,
      limit: 2,
      unit: 'pveproxy',
    })) as { lines: string[]; omittedOlderLines: number };
    const params = last(c)?.params ?? {};
    expect(params).toMatchObject({ since: 1767225600, until: 1767312000, unit: 'pveproxy' });
    expect(params.lastentries).toBeUndefined();
    expect(ranged.lines).toEqual(['line 3', 'line 4']);
    expect(ranged.omittedOlderLines).toBe(3);
    await expect(runNode(c, 'pve_node_syslog', { since: 'yesterday-ish' })).rejects.toThrow(
      /since/,
    );
  });

  it('lists disks, optionally with partitions, and returns SMART for one disk', async () => {
    const c = client({
      'GET /nodes/pve1/disks/list': [
        { devpath: '/dev/sda', model: 'M', size: 1, health: 'PASSED', by_id_link: 'x' },
      ],
      'GET /nodes/pve1/disks/smart': { health: 'PASSED', type: 'ata' },
    });
    const list = (await runNode(c, 'pve_node_disks', { partitions: true })) as {
      disks: Array<Record<string, unknown>>;
    };
    expect(last(c)).toMatchObject({
      path: '/nodes/pve1/disks/list',
      params: { 'include-partitions': true },
    });
    expect(list.disks[0]).toEqual({ devpath: '/dev/sda', model: 'M', size: 1, health: 'PASSED' });
    const smart = await runNode(c, 'pve_node_disks', { smartDisk: '/dev/sda', healthOnly: true });
    expect(last(c)).toMatchObject({
      path: '/nodes/pve1/disks/smart',
      params: { disk: '/dev/sda', healthonly: true },
    });
    expect(smart).toMatchObject({ disk: '/dev/sda', smart: { health: 'PASSED' } });
  });

  it('shows pending updates in short form', async () => {
    const c = client({
      'GET /nodes/pve1/apt/update': [
        {
          Package: 'pve-manager',
          OldVersion: '9.0.1',
          Version: '9.0.2',
          Priority: 'optional',
          Description: 'long',
        },
      ],
    });
    const out = (await runNode(c, 'pve_node_apt_updates')) as { count: number; updates: unknown[] };
    expect(out.count).toBe(1);
    expect(out.updates[0]).toEqual({
      Package: 'pve-manager',
      OldVersion: '9.0.1',
      Version: '9.0.2',
      Priority: 'optional',
    });
  });

  it('power needs an explicit node and names it in the confirmation', async () => {
    const c = client({ 'POST /nodes/pve1/status': null });
    await runNode(c, 'pve_node_power', { node: 'pve1', command: 'reboot' });
    expect(last(c)).toMatchObject({
      method: 'POST',
      path: '/nodes/pve1/status',
      params: { command: 'reboot' },
    });
    await expect(runNode(c, 'pve_node_power', { command: 'reboot' })).rejects.toThrow();
    const tool = nodeTools.find((t) => t.name === 'pve_node_power');
    expect(
      tool?.confirmTarget?.({ node: 'pve1', command: 'shutdown' } as never, fakeContext(c)),
    ).toContain('pve1');
  });
});

describe('network tools', () => {
  it('uses the contract names, categories and access levels', () => {
    expect(networkTools.map((t) => `${t.name}:${t.category}:${t.access}`)).toEqual([
      'pve_network_list:network:read',
      'pve_network_set:network:write',
      'pve_network_delete:network:write',
      'pve_network_apply:network:destructive',
      'pve_network_revert:network:write',
    ]);
  });

  it('lists interfaces, filters by type and flags pending changes', async () => {
    const c = client({
      'GET /nodes/pve1/network': [
        { iface: 'vmbr0', type: 'bridge', active: 1 },
        { iface: 'vmbr1', type: 'bridge', pending: { address: '192.0.2.5' } },
      ],
    });
    const out = (await runNet(c, 'pve_network_list', { type: 'bridge' })) as {
      hasPending: boolean;
      count: number;
    };
    expect(last(c)).toMatchObject({ path: '/nodes/pve1/network', params: { type: 'bridge' } });
    expect(out).toMatchObject({ count: 2, hasPending: true });
  });

  it('shows the staged diff from the top level changes field', async () => {
    const diff = '--- /etc/network/interfaces\n+++ /etc/network/interfaces.new\n+auto vmbr2\n';
    const c = client({
      'GET /nodes/pve1/network': envelope([{ iface: 'vmbr0', type: 'bridge' }], {
        changes: diff,
      }),
    });
    const out = (await runNet(c, 'pve_network_list', {})) as Record<string, unknown>;
    expect(out).toMatchObject({ count: 1, hasPending: true, pendingChanges: diff });

    const clean = client({
      'GET /nodes/pve1/network': envelope([{ iface: 'vmbr0', type: 'bridge' }], {}),
    });
    const none = (await runNet(clean, 'pve_network_list', {})) as Record<string, unknown>;
    expect(none.hasPending).toBe(false);
    expect(none).not.toHaveProperty('pendingChanges');
  });

  it('creates with POST and a typed iface, and requires a type', async () => {
    const c = client({ 'POST /nodes/pve1/network': null });
    const out = await runNet(c, 'pve_network_set', {
      iface: 'vmbr1',
      type: 'bridge',
      cidr: '192.0.2.10/24',
      bridge_ports: 'eno2',
      bridge_vlan_aware: true,
      extra: { bridge_vids: '2-4094' },
    });
    expect(last(c)).toMatchObject({
      method: 'POST',
      path: '/nodes/pve1/network',
      params: {
        iface: 'vmbr1',
        type: 'bridge',
        cidr: '192.0.2.10/24',
        bridge_ports: 'eno2',
        bridge_vlan_aware: true,
        bridge_vids: '2-4094',
      },
    });
    expect(out).toMatchObject({ action: 'created', staged: true });
    await expect(runNet(c, 'pve_network_set', { iface: 'vmbr2' })).rejects.toThrow(
      /type is required/,
    );
    await expect(
      runNet(c, 'pve_network_set', { iface: 'vmbr2', type: 'bridge', delete: ['gateway'] }),
    ).rejects.toThrow(/delete only applies/);
  });

  it('updates with PUT on the iface path, reading the type when it is omitted', async () => {
    const c = client({
      'GET /nodes/pve1/network/vmbr1': { type: 'bridge', iface: 'vmbr1' },
      'PUT /nodes/pve1/network/vmbr1': null,
    });
    const out = await runNet(c, 'pve_network_set', {
      iface: 'vmbr1',
      update: true,
      mtu: 9000,
      delete: ['gateway', 'comments'],
    });
    expect(c.calls.map((x) => `${x.method} ${x.path}`)).toEqual([
      'GET /nodes',
      'GET /nodes/pve1/network/vmbr1',
      'PUT /nodes/pve1/network/vmbr1',
    ]);
    expect(last(c)?.params).toMatchObject({
      type: 'bridge',
      mtu: 9000,
      delete: 'gateway,comments',
    });
    expect(last(c)?.params).not.toHaveProperty('iface');
    expect(out).toMatchObject({ action: 'updated', staged: true });
  });

  it('refuses extra options that collide with typed fields', async () => {
    const c = client({ 'POST /nodes/pve1/network': null });
    await expect(
      runNet(c, 'pve_network_set', {
        iface: 'vmbr1',
        type: 'bridge',
        mtu: 1500,
        extra: { mtu: 9000 },
      }),
    ).rejects.toThrow(/already set/);
  });

  it('delete and revert stage on the node, apply is a waited task and needs a node', async () => {
    const c = client({
      'DELETE /nodes/pve1/network/vmbr1': null,
      'DELETE /nodes/pve1/network': null,
      'PUT /nodes/pve1/network': UPID,
    });
    expect(await runNet(c, 'pve_network_delete', { iface: 'vmbr1' })).toMatchObject({
      staged: true,
    });
    expect(last(c)).toMatchObject({ method: 'DELETE', path: '/nodes/pve1/network/vmbr1' });
    expect(await runNet(c, 'pve_network_revert')).toMatchObject({ reverted: true });
    expect(last(c)).toMatchObject({ method: 'DELETE', path: '/nodes/pve1/network' });
    const out = await runNet(c, 'pve_network_apply', { node: 'pve1', wait: false });
    expect(last(c)).toMatchObject({ method: 'PUT', path: '/nodes/pve1/network' });
    expect(out).toMatchObject({ upid: UPID });
    await expect(runNet(c, 'pve_network_apply', {})).rejects.toThrow();
  });
});
