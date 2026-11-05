import { describe, expect, it } from 'vitest';
import { encodeSshKeys, guestTools, summarizeRrd } from '../src/tools/guests.js';
import { callTool, UPID } from './helpers/call-tool.js';
import { fakeClient, type FakeClient } from './helpers/fake-client.js';
import { fakeContext, fakeSettings } from './helpers/fixtures.js';

const resources = [
  {
    id: 'qemu/100',
    type: 'qemu',
    vmid: 100,
    node: 'pve1',
    name: 'web',
    status: 'running',
    tags: 'prod;web',
    template: 0,
    pool: 'main',
  },
  {
    id: 'lxc/200',
    type: 'lxc',
    vmid: 200,
    node: 'pve2',
    name: 'db',
    status: 'stopped',
    template: 0,
  },
  {
    id: 'qemu/9000',
    type: 'qemu',
    vmid: 9000,
    node: 'pve1',
    name: 'tpl',
    status: 'stopped',
    template: 1,
  },
];

function cluster(extra: Record<string, never> = {}): FakeClient {
  return fakeClient({ 'GET /cluster/resources': resources, ...extra });
}

const run = (client: FakeClient, name: string, args: Record<string, unknown>) =>
  callTool(guestTools, name, args, client);

const last = (client: FakeClient) => client.calls[client.calls.length - 1];

describe('tool catalog', () => {
  it('uses the names, categories and access levels of the contract', () => {
    const table = Object.fromEntries(guestTools.map((t) => [t.name, `${t.category}:${t.access}`]));
    expect(table).toEqual({
      pve_guest_list: 'guests:read',
      pve_guest_status: 'guests:read',
      pve_guest_config: 'guests:read',
      pve_guest_rrd: 'guests:read',
      pve_guest_power: 'guests:write',
      pve_guest_update_config: 'guests:write',
      pve_guest_resize_disk: 'guests:write',
      pve_guest_move_disk: 'guests:write',
      pve_guest_migrate: 'guests:write',
      pve_guest_clone: 'guests:write',
      pve_guest_template: 'guests:write',
      pve_guest_delete: 'guests:destructive',
      pve_vm_create: 'guests:write',
      pve_lxc_create: 'guests:write',
      pve_vm_agent_info: 'guests:read',
      pve_vm_agent_exec: 'guests:destructive',
      pve_vm_cloudinit: 'guests:read',
    });
  });
});

describe('pve_guest_list', () => {
  it('queries cluster resources and filters', async () => {
    const client = cluster();
    const all = (await run(client, 'pve_guest_list', {})) as Array<{ vmid: number }>;
    expect(client.calls[0]).toMatchObject({
      method: 'GET',
      path: '/cluster/resources',
      params: { type: 'vm' },
    });
    expect(all.map((g) => g.vmid)).toEqual([100, 200, 9000]);

    const byTag = (await run(client, 'pve_guest_list', { tag: 'WEB' })) as Array<{
      vmid: number;
      tags: string[];
    }>;
    expect(byTag).toHaveLength(1);
    expect(byTag[0]?.tags).toEqual(['prod', 'web']);

    const noTpl = (await run(client, 'pve_guest_list', { template: false })) as unknown[];
    expect(noTpl).toHaveLength(2);
    const lxc = (await run(client, 'pve_guest_list', {
      type: 'lxc',
      node: 'pve2',
      status: 'stopped',
    })) as unknown[];
    expect(lxc).toHaveLength(1);
    const pool = (await run(client, 'pve_guest_list', { pool: 'main' })) as unknown[];
    expect(pool).toHaveLength(1);
  });
});

describe('read tools', () => {
  it('status reads status/current', async () => {
    const client = cluster({
      'GET /nodes/pve1/qemu/100/status/current': { status: 'running' },
    } as never);
    await run(client, 'pve_guest_status', { vmid: 100 });
    expect(last(client)?.path).toBe('/nodes/pve1/qemu/100/status/current');
  });

  it('config reads config, pending reads the pending list', async () => {
    const client = cluster({
      'GET /nodes/pve1/qemu/100/config': { cores: 2 },
      'GET /nodes/pve1/qemu/100/pending': [],
    } as never);
    await run(client, 'pve_guest_config', { vmid: 100, current: true });
    expect(last(client)).toMatchObject({
      path: '/nodes/pve1/qemu/100/config',
      params: { current: true },
    });
    await run(client, 'pve_guest_config', { vmid: 100, pending: true });
    expect(last(client)?.path).toBe('/nodes/pve1/qemu/100/pending');
  });

  it('rrd asks for the timeframe and condenses the points', async () => {
    const rows = Array.from({ length: 10 }, (_, i) => ({
      time: 1700000000 + i * 60,
      cpu: i / 10,
      mem: null,
    }));
    const client = cluster({ 'GET /nodes/pve1/qemu/100/rrddata': rows } as never);
    const out = (await run(client, 'pve_guest_rrd', { vmid: 100, timeframe: 'hour' })) as {
      points: number;
      metrics: Record<string, { min: number; max: number; avg: number }>;
      recent: unknown[];
    };
    expect(last(client)?.params).toEqual({ timeframe: 'hour', cf: 'AVERAGE' });
    expect(out.points).toBe(10);
    expect(out.metrics.cpu).toMatchObject({ min: 0, max: 0.9, avg: 0.45 });
    expect(out.metrics.mem).toBeUndefined();
    expect(out.recent).toHaveLength(5);
  });

  it('summarizeRrd copes with empty input', () => {
    expect(summarizeRrd([])).toMatchObject({ points: 0, metrics: {}, recent: [] });
  });
});

describe('pve_guest_power', () => {
  it('posts the action to status/<action>', async () => {
    const client = cluster({ 'POST /nodes/pve1/qemu/100/status/start': null } as never);
    await run(client, 'pve_guest_power', { vmid: 100, action: 'start' });
    expect(last(client)).toMatchObject({
      method: 'POST',
      path: '/nodes/pve1/qemu/100/status/start',
    });
  });

  it('refuses stop and reset without force and makes no power call', async () => {
    const client = cluster();
    await expect(run(client, 'pve_guest_power', { vmid: 100, action: 'stop' })).rejects.toThrow(
      /shutdown/,
    );
    await expect(run(client, 'pve_guest_power', { vmid: 100, action: 'reset' })).rejects.toThrow(
      /force/,
    );
    expect(client.calls.every((c) => c.method === 'GET')).toBe(true);
  });

  it('stops and resets with force, but containers have no reset', async () => {
    const client = cluster({
      'POST /nodes/pve1/qemu/100/status/stop': null,
      'POST /nodes/pve1/qemu/100/status/reset': null,
    } as never);
    await run(client, 'pve_guest_power', { vmid: 100, action: 'stop', force: true });
    expect(last(client)?.path).toBe('/nodes/pve1/qemu/100/status/stop');
    await run(client, 'pve_guest_power', { vmid: 100, action: 'reset', force: true });
    expect(last(client)?.path).toBe('/nodes/pve1/qemu/100/status/reset');
    await expect(
      run(client, 'pve_guest_power', { vmid: 200, action: 'reset', force: true }),
    ).rejects.toThrow(/no reset/);
  });

  it('passes timeout and forceStop to shutdown and returns the UPID without waiting', async () => {
    const client = cluster({ 'POST /nodes/pve2/lxc/200/status/shutdown': UPID } as never);
    const out = await run(client, 'pve_guest_power', {
      vmid: 200,
      action: 'shutdown',
      timeout: 30,
      forceStop: true,
      wait: false,
    });
    expect(last(client)?.params).toEqual({ timeout: 30, forceStop: true });
    expect(out).toMatchObject({ upid: UPID });
  });
});

describe('pve_guest_update_config', () => {
  it('encodes a plain text sshkeys value for a VM', async () => {
    const client = cluster({ 'PUT /nodes/pve1/qemu/100/config': null } as never);
    const key = 'ssh-ed25519 AAAAC3+Nza user@example.com\nssh-rsa BBBB+/= other@example.com';
    await run(client, 'pve_guest_update_config', {
      vmid: 100,
      set: { sshkeys: key, cores: 4, onboot: true },
    });
    const params = last(client)?.params as Record<string, unknown>;
    expect(params.sshkeys).toBe(encodeURIComponent(key));
    expect(params.sshkeys).toContain('%20');
    expect(params.sshkeys).toContain('%2B');
    expect(params.sshkeys).toContain('%0A');
    expect(params.cores).toBe(4);
    expect(params.onboot).toBe(true);
  });

  it('does not encode an already encoded value twice', () => {
    const encoded = encodeURIComponent('ssh-ed25519 AAAA+BBB user@example.com\n');
    expect(encodeSshKeys(encoded)).toBe(encoded);
    expect(encodeSshKeys('ssh-ed25519 AAAA user@example.com')).toBe(
      'ssh-ed25519%20AAAA%20user%40example.com',
    );
  });

  it('leaves non-sshkeys values alone and sends delete, revert and digest', async () => {
    const client = cluster({ 'PUT /nodes/pve2/lxc/200/config': null } as never);
    await run(client, 'pve_guest_update_config', {
      vmid: 200,
      set: { description: 'a b+c' },
      delete: ['tags', 'net1'],
      revert: ['memory'],
      digest: 'abc',
    });
    expect(last(client)?.params).toEqual({
      description: 'a b+c',
      delete: 'tags,net1',
      revert: 'memory',
      digest: 'abc',
    });
  });

  it('rejects reserved keys and empty changes', async () => {
    const client = cluster();
    await expect(
      run(client, 'pve_guest_update_config', { vmid: 100, set: { delete: 'cores' } }),
    ).rejects.toThrow(/delete/);
    await expect(run(client, 'pve_guest_update_config', { vmid: 100 })).rejects.toThrow(
      /Nothing to change/,
    );
  });
});

describe('disk and lifecycle tools', () => {
  it('resize puts disk and size', async () => {
    const client = cluster({ 'PUT /nodes/pve1/qemu/100/resize': null } as never);
    await run(client, 'pve_guest_resize_disk', { vmid: 100, disk: 'scsi0', size: '+10G' });
    expect(last(client)).toMatchObject({ method: 'PUT', params: { disk: 'scsi0', size: '+10G' } });
  });

  it('move_disk uses move_disk for VMs and move_volume for containers', async () => {
    const client = cluster({
      'POST /nodes/pve1/qemu/100/move_disk': UPID,
      'POST /nodes/pve2/lxc/200/move_volume': UPID,
    } as never);
    await run(client, 'pve_guest_move_disk', {
      vmid: 100,
      disk: 'scsi0',
      storage: 'fast',
      deleteSource: true,
      format: 'qcow2',
      wait: false,
    });
    expect(last(client)).toMatchObject({
      path: '/nodes/pve1/qemu/100/move_disk',
      params: { disk: 'scsi0', storage: 'fast', delete: true, format: 'qcow2' },
    });
    await run(client, 'pve_guest_move_disk', {
      vmid: 200,
      disk: 'rootfs',
      storage: 'fast',
      wait: false,
    });
    expect(last(client)).toMatchObject({
      path: '/nodes/pve2/lxc/200/move_volume',
      params: { volume: 'rootfs', storage: 'fast' },
    });
    await expect(
      run(client, 'pve_guest_move_disk', {
        vmid: 200,
        disk: 'rootfs',
        storage: 'fast',
        format: 'raw',
      }),
    ).rejects.toThrow(/not supported for containers/);
  });

  it('migrate maps options per guest type', async () => {
    const client = cluster({
      'POST /nodes/pve1/qemu/100/migrate': UPID,
      'POST /nodes/pve2/lxc/200/migrate': UPID,
    } as never);
    await run(client, 'pve_guest_migrate', {
      vmid: 100,
      target: 'pve2',
      online: true,
      withLocalDisks: true,
      targetStorage: 'local-lvm',
      wait: false,
    });
    expect(last(client)?.params).toEqual({
      target: 'pve2',
      online: true,
      'with-local-disks': true,
      targetstorage: 'local-lvm',
    });
    await run(client, 'pve_guest_migrate', {
      vmid: 200,
      target: 'pve1',
      restart: true,
      timeout: 60,
      targetStorage: 'local-lvm',
      wait: false,
    });
    expect(last(client)?.params).toEqual({
      target: 'pve1',
      restart: true,
      'target-storage': 'local-lvm',
      timeout: 60,
    });
    await expect(
      run(client, 'pve_guest_migrate', { vmid: 200, target: 'pve1', online: true }),
    ).rejects.toThrow(/not supported for containers/);
    await expect(
      run(client, 'pve_guest_migrate', { vmid: 100, target: 'pve2', restart: true }),
    ).rejects.toThrow(/not supported for VMs/);
  });

  it('clone uses name for VMs, hostname for containers and the next id by default', async () => {
    const client = cluster({
      'GET /cluster/nextid': '301',
      'POST /nodes/pve1/qemu/100/clone': UPID,
      'POST /nodes/pve2/lxc/200/clone': UPID,
    } as never);
    const out = await run(client, 'pve_guest_clone', {
      vmid: 100,
      name: 'copy',
      full: true,
      target: 'pve2',
      storage: 'fast',
      wait: false,
    });
    expect(out).toMatchObject({ newid: 301 });
    expect(last(client)?.params).toMatchObject({
      newid: 301,
      name: 'copy',
      full: true,
      target: 'pve2',
      storage: 'fast',
    });
    expect(last(client)?.params).not.toHaveProperty('hostname', 'copy');
    await run(client, 'pve_guest_clone', { vmid: 200, newid: 400, name: 'dbcopy', wait: false });
    expect(last(client)?.params).toMatchObject({ newid: 400, hostname: 'dbcopy' });
    expect((last(client)?.params as Record<string, unknown>).name).toBeUndefined();
  });

  it('template posts to /template', async () => {
    const client = cluster({ 'POST /nodes/pve1/qemu/100/template': null } as never);
    await run(client, 'pve_guest_template', { vmid: 100 });
    expect(last(client)).toMatchObject({ method: 'POST', path: '/nodes/pve1/qemu/100/template' });
  });

  it('delete sends purge and destroy-unreferenced-disks to the guest path', async () => {
    const client = cluster({ 'DELETE /nodes/pve2/lxc/200': UPID } as never);
    await run(client, 'pve_guest_delete', {
      vmid: 200,
      purge: true,
      destroyUnreferencedDisks: true,
      wait: false,
    });
    expect(last(client)).toMatchObject({
      method: 'DELETE',
      path: '/nodes/pve2/lxc/200',
      params: { purge: true, 'destroy-unreferenced-disks': true },
    });
  });
});

describe('pve_vm_create', () => {
  const nodes = { 'GET /nodes': [{ node: 'pve1' }] };

  it('uses the only node, the next VMID and maps typed fields', async () => {
    const client = fakeClient({
      ...nodes,
      'GET /cluster/nextid': '150',
      'POST /nodes/pve1/qemu': UPID,
    });
    const out = await run(client, 'pve_vm_create', {
      name: 'vm1',
      memory: 2048,
      cores: 2,
      net0: 'virtio,bridge=vmbr0',
      disks: { scsi0: 'local-lvm:32', ide3: 'local-lvm:cloudinit' },
      iso: 'local:iso/debian.iso',
      tags: ['a', 'b'],
      sshkeys: 'ssh-ed25519 AAAA user@example.com',
      ipconfig0: 'ip=dhcp',
      start: true,
      extra: { efidisk0: 'local-lvm:1', numa: true },
      wait: false,
    });
    expect(out).toMatchObject({ vmid: 150, node: 'pve1' });
    expect(last(client)).toMatchObject({ method: 'POST', path: '/nodes/pve1/qemu' });
    expect(last(client)?.params).toMatchObject({
      vmid: 150,
      name: 'vm1',
      memory: 2048,
      scsi0: 'local-lvm:32',
      ide3: 'local-lvm:cloudinit',
      ide2: 'local:iso/debian.iso,media=cdrom',
      tags: 'a,b',
      sshkeys: 'ssh-ed25519%20AAAA%20user%40example.com',
      ipconfig0: 'ip=dhcp',
      start: true,
      efidisk0: 'local-lvm:1',
      numa: true,
    });
  });

  it('needs a node when there are several', async () => {
    const client = fakeClient({ 'GET /nodes': [{ node: 'pve1' }, { node: 'pve2' }] });
    await expect(run(client, 'pve_vm_create', { vmid: 500 })).rejects.toThrow(/pve1, pve2/);
  });

  it('rejects bad drive keys and conflicting extra options', async () => {
    const client = fakeClient({ ...nodes });
    await expect(
      run(client, 'pve_vm_create', { vmid: 500, disks: { foo: 'x:1' } }),
    ).rejects.toThrow(/drive key/);
    await expect(
      run(client, 'pve_vm_create', { vmid: 500, memory: 1024, extra: { memory: 2048 } }),
    ).rejects.toThrow(/typed field/);
    await expect(
      run(client, 'pve_vm_create', { vmid: 500, iso: 'local:iso/a.iso', disks: { ide2: 'x:1' } }),
    ).rejects.toThrow(/ide2/);
  });
});

describe('pve_lxc_create', () => {
  const nodes = { 'GET /nodes': [{ node: 'pve1' }] };

  it('builds rootfs from storage and size and defaults to unprivileged', async () => {
    const client = fakeClient({ ...nodes, 'POST /nodes/pve1/lxc': UPID });
    await run(client, 'pve_lxc_create', {
      vmid: 600,
      ostemplate: 'local:vztmpl/debian-12.tar.zst',
      hostname: 'ct1',
      storage: 'local-lvm',
      diskSizeGB: 8,
      net0: 'name=eth0,bridge=vmbr0,ip=dhcp',
      sshPublicKeys: 'ssh-ed25519 AAAA user@example.com',
      features: 'nesting=1',
      wait: false,
    });
    expect(last(client)).toMatchObject({ method: 'POST', path: '/nodes/pve1/lxc' });
    expect(last(client)?.params).toMatchObject({
      vmid: 600,
      ostemplate: 'local:vztmpl/debian-12.tar.zst',
      hostname: 'ct1',
      rootfs: 'local-lvm:8',
      unprivileged: true,
      'ssh-public-keys': 'ssh-ed25519 AAAA user@example.com',
      features: 'nesting=1',
    });
  });

  it('honors unprivileged false and rejects rootfs together with storage', async () => {
    const client = fakeClient({ ...nodes, 'POST /nodes/pve1/lxc': null });
    await run(client, 'pve_lxc_create', {
      vmid: 601,
      ostemplate: 'local:vztmpl/x.tar.zst',
      rootfs: 'local-lvm:4',
      unprivileged: false,
    });
    expect(last(client)?.params).toMatchObject({ rootfs: 'local-lvm:4', unprivileged: false });
    await expect(
      run(client, 'pve_lxc_create', {
        vmid: 602,
        ostemplate: 'local:vztmpl/x.tar.zst',
        rootfs: 'local-lvm:4',
        storage: 'local-lvm',
        diskSizeGB: 4,
      }),
    ).rejects.toThrow(/either rootfs/);
  });
});

describe('guest agent and cloud-init', () => {
  it('agent_info unwraps the result and refuses containers', async () => {
    const client = cluster({
      'GET /nodes/pve1/qemu/100/agent/get-osinfo': { result: { name: 'Debian' } },
    } as never);
    const out = await run(client, 'pve_vm_agent_info', { vmid: 100, command: 'get-osinfo' });
    expect(out).toEqual({ name: 'Debian' });
    await expect(run(client, 'pve_vm_agent_info', { vmid: 200, command: 'info' })).rejects.toThrow(
      /QEMU/,
    );
  });

  it('agent_exec posts the argument vector and returns the output once exited', async () => {
    let polls = 0;
    const client = cluster({
      'POST /nodes/pve1/qemu/100/agent/exec': { pid: 77 },
      'GET /nodes/pve1/qemu/100/agent/exec-status': () => {
        polls += 1;
        return { exited: 1, exitcode: 0, 'out-data': 'hi\n', 'out-truncated': 0 };
      },
    } as never);
    const out = await run(client, 'pve_vm_agent_exec', {
      vmid: 100,
      command: ['echo', 'hi'],
      input: 'x',
    });
    const post = client.calls.find((c) => c.method === 'POST');
    expect(post?.params).toEqual({ command: ['echo', 'hi'], 'input-data': 'x' });
    expect(client.calls.find((c) => c.path.endsWith('exec-status'))?.params).toEqual({ pid: 77 });
    expect(polls).toBe(1);
    expect(out).toMatchObject({ exited: true, exitcode: 0, 'out-data': 'hi\n', truncated: false });
  });

  it('agent_exec gives up after the timeout and reports exited false', async () => {
    const client = cluster({
      'POST /nodes/pve1/qemu/100/agent/exec': { pid: 5 },
      'GET /nodes/pve1/qemu/100/agent/exec-status': { exited: 0 },
    } as never);
    const ctx = fakeContext(client, {
      settings: fakeSettings({ limits: { maxOutputChars: 60000, taskWaitSeconds: 1 } }),
    });
    const { callTool: call } = await import('./helpers/call-tool.js');
    const out = await call(
      guestTools,
      'pve_vm_agent_exec',
      { vmid: 100, command: ['sleep', '99'], timeoutSeconds: 600 },
      client,
      ctx,
    );
    expect(out).toMatchObject({ pid: 5, exited: false });
  });

  it('cloudinit reads pending and optionally the rendered dump', async () => {
    const client = cluster({
      'GET /nodes/pve1/qemu/100/cloudinit': [{ key: 'ciuser' }],
      'GET /nodes/pve1/qemu/100/cloudinit/dump': '#cloud-config',
    } as never);
    const out = await run(client, 'pve_vm_cloudinit', { vmid: 100, dump: 'user' });
    expect(last(client)).toMatchObject({
      path: '/nodes/pve1/qemu/100/cloudinit/dump',
      params: { type: 'user' },
    });
    expect(out).toMatchObject({ dump: { type: 'user', content: '#cloud-config' } });
  });
});
