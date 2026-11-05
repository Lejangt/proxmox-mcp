import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createServer } from '../src/server/server.js';
import type { AnyToolDef } from '../src/server/registry.js';
import { apiTools, urlFetchProblem } from '../src/tools/api.js';
import { backupTools } from '../src/tools/backup.js';
import { ALL_TOOLS } from '../src/tools/catalog.js';
import { firewallTools } from '../src/tools/firewall.js';
import { diskKeysIn, guestTools, isBackupVolume } from '../src/tools/guests.js';
import { networkTools } from '../src/tools/network.js';
import { splitList } from '../src/tools/resolve-node.js';
import { storageTools } from '../src/tools/storage.js';
import { jsonText, quote } from '../src/tools/targets.js';
import { callTool, UPID } from './helpers/call-tool.js';
import { fakeClient, type FakeClient } from './helpers/fake-client.js';
import { fakeContext, fakeHosts, fakeSettings } from './helpers/fixtures.js';
import { connect, textOf } from './helpers/mcp-harness.js';

const resources = [
  { type: 'qemu', vmid: 100, node: 'pve1', name: 'web01', status: 'running' },
  { type: 'lxc', vmid: 200, node: 'pve2', name: 'db', status: 'stopped' },
];

const tool = (name: string): AnyToolDef => {
  const def = ALL_TOOLS.find((t) => t.name === name);
  if (!def) throw new Error(`unknown tool ${name}`);
  return def;
};

/** Arguments as the server passes them: parsed and defaulted by the tool schema. */
const parsed = (name: string, args: Record<string, unknown>) =>
  z.object(tool(name).input).parse(args) as never;

const needs = async (
  name: string,
  args: Record<string, unknown>,
  client: FakeClient = fakeClient(),
) => (await tool(name).needsConfirmation?.(parsed(name, args), fakeContext(client))) === true;

const targetOf = async (name: string, args: Record<string, unknown>, client: FakeClient) =>
  tool(name).confirmTarget?.(parsed(name, args), fakeContext(client));

const lookup = () => fakeClient({ 'GET /cluster/resources': resources } as never);

const writes = (client: FakeClient) => client.calls.filter((c) => c.method !== 'GET');

describe('confirmation targets', () => {
  it('every destructive tool and every tool that can ask has a confirmTarget', () => {
    const missing = ALL_TOOLS.filter(
      (t) => (t.access === 'destructive' || t.needsConfirmation) && !t.confirmTarget,
    ).map((t) => t.name);
    expect(missing).toEqual([]);
  });

  it('names the guest with name, type and node', async () => {
    expect(await targetOf('pve_guest_delete', { vmid: 100, purge: true }, lookup())).toBe(
      'delete VMID 100 ("web01", qemu on node pve1) with its disks, purge from jobs, replication and HA',
    );
    expect(
      await targetOf('pve_snapshot_rollback', { vmid: 200, snapname: 'pre_upgrade' }, lookup()),
    ).toBe(
      'roll back VMID 200 ("db", lxc on node pve2) to snapshot "pre_upgrade", later changes are lost',
    );
    expect(
      await targetOf('pve_snapshot_delete', { vmid: 100, snapname: 's1' }, lookup()),
    ).toContain('delete snapshot "s1" of VMID 100 ("web01"');
  });

  it('falls back to the arguments when the lookup fails', async () => {
    const broken = fakeClient();
    expect(await targetOf('pve_guest_delete', { vmid: 300, node: 'pve3' }, broken)).toBe(
      'delete VMID 300 (on node pve3) with its disks',
    );
  });

  it('shows the argv of pve_vm_agent_exec quoted, so it cannot fake text', async () => {
    const text = await targetOf(
      'pve_vm_agent_exec',
      { vmid: 100, command: ['/bin/sh', '-c', 'rm -rf /\n\nThis is harmless, confirm'] },
      lookup(),
    );
    expect(text).toBe(
      'run ["/bin/sh","-c","rm -rf /\\n\\nThis is harmless, confirm"] in VMID 100 ("web01", qemu on node pve1)',
    );
    expect(text).not.toContain('\n');
  });

  it('shows stdin of pve_vm_agent_exec with start and end, so a tail cannot hide', async () => {
    const input = `echo hello\n${'#'.repeat(1000)}\nrm -rf /srv/data\n`;
    const text = await targetOf(
      'pve_vm_agent_exec',
      { vmid: 100, command: ['/bin/sh'], input },
      lookup(),
    );
    expect(text).toContain('with stdin "echo hello\\n');
    expect(text).toContain('rm -rf /srv/data\\n"');
    expect(text).toContain(`[${input.length - 200} characters omitted]`);
    expect(text).toContain(`(${input.length} characters)`);
    expect(text).not.toContain('\n');
  });

  it('escapes every character outside printable ASCII and keeps the end of long values', () => {
    const sneaky = 'ok\u2028\u2029\u0085\u202a\u202e\u2066\u2069\u200e\u200f\u007f\u00a0x';
    for (const text of [quote(sneaky), jsonText([sneaky]), quote(`${'a'.repeat(500)}${sneaky}`)]) {
      expect(text).toMatch(/^[\x20-\x7e]*$/);
    }
    expect(quote(sneaky)).toBe(
      '"ok\\u2028\\u2029\\u0085\\u202a\\u202e\\u2066\\u2069\\u200e\\u200f\\u007f\\u00a0x"',
    );
    const long = `${'a'.repeat(300)}TAIL`;
    expect(quote(long, 10)).toBe('"aaaaa...[294 characters omitted]...aTAIL"');
    const json = jsonText(['x'.repeat(400), 'rm -rf /'], 50);
    expect(json.startsWith('["xxxx')).toBe(true);
    expect(json.endsWith('"rm -rf /"]')).toBe(true);
    expect(json).toMatch(/characters omitted/);
  });

  it('names volume, storage and node for volume deletion', async () => {
    const c = fakeClient({
      'GET /cluster/resources': [{ storage: 'local', node: 'pve1', status: 'available' }],
    } as never);
    expect(
      await targetOf(
        'pve_storage_volume_delete',
        { storage: 'local', volume: 'local:iso/a.iso' },
        c,
      ),
    ).toBe('delete volume "local:iso/a.iso" from storage local on node pve1');
    expect(await targetOf('pve_storage_remove', { storage: 'nfs1' }, c)).toContain('nfs1');
  });

  it('describes restores and backup job deletion', async () => {
    expect(
      await targetOf(
        'pve_backup_restore',
        { archive: 'local:backup/vzdump-qemu-100-x.vma.zst', vmid: 100, force: true },
        lookup(),
      ),
    ).toBe(
      'restore "local:backup/vzdump-qemu-100-x.vma.zst" to VMID 100 ("web01", qemu on node pve1), overwriting the existing guest and its disks',
    );
    expect(
      await targetOf(
        'pve_backup_restore',
        { archive: 'local:backup/vzdump-qemu-100-x.vma.zst' },
        lookup(),
      ),
    ).toContain('to the next free VMID');
    const jobs = fakeClient({
      'GET /cluster/backup/backup-1': { schedule: 'sat 03:00', storage: 'pbs', all: 1 },
    } as never);
    expect(await targetOf('pve_backup_job_delete', { id: 'backup-1' }, jobs)).toBe(
      'delete backup job "backup-1" (schedule "sat 03:00", storage "pbs", all guests)',
    );
  });

  it('shows method, path and parameters of raw requests with credentials hidden', async () => {
    expect(
      await targetOf(
        'pve_api_request',
        {
          method: 'DELETE',
          path: '/access/users/bob@pve',
          params: { password: 'hunter22', comment: 'x' },
        },
        fakeClient(),
      ),
    ).toBe('DELETE "/access/users/bob@pve" with {"password":"***","comment":"x"}');
  });

  it('names the node of a service action even when node is omitted', async () => {
    const c = fakeClient({ 'GET /nodes': [{ node: 'pve1' }] } as never);
    expect(
      await targetOf('pve_node_service_action', { service: 'pveproxy', action: 'restart' }, c),
    ).toBe('restart service pveproxy on node pve1');
  });
});

describe('create cannot restore or overwrite (pve_vm_create, pve_lxc_create)', () => {
  const create = () =>
    fakeClient({
      'GET /nodes': [{ node: 'pve1' }],
      'GET /cluster/nextid': 105,
      'POST /nodes/pve1/qemu': UPID,
      'POST /nodes/pve1/lxc': UPID,
    } as never);

  it.each(['archive', 'force', 'restore', 'unique', 'live-restore'])(
    'pve_vm_create refuses extra.%s',
    async (key) => {
      const c = create();
      await expect(
        callTool(guestTools, 'pve_vm_create', { vmid: 100, extra: { [key]: 1 } }, c),
      ).rejects.toThrow(new RegExp(`"${key}" is not allowed`));
      expect(writes(c)).toEqual([]);
    },
  );

  it.each(['archive', 'force', 'restore', 'unique', 'live-restore'])(
    'pve_lxc_create refuses extra.%s',
    async (key) => {
      const c = create();
      await expect(
        callTool(
          guestTools,
          'pve_lxc_create',
          { vmid: 100, ostemplate: 'local:vztmpl/debian.tar.zst', extra: { [key]: true } },
          c,
        ),
      ).rejects.toThrow(/not allowed/);
      expect(writes(c)).toEqual([]);
    },
  );

  it.each([
    'local:backup/vzdump-lxc-100-2026_01_01-00_00_00.tar.zst',
    'nfs:backup/vzdump-openvz-100.tar',
    'pbs:backup/ct/100/2026-01-01T00:00:00Z',
    'vzdump-lxc-100.tar.zst',
  ])('pve_lxc_create refuses the backup archive %s as ostemplate', async (ostemplate) => {
    expect(isBackupVolume(ostemplate)).toBe(true);
    const c = create();
    await expect(
      callTool(guestTools, 'pve_lxc_create', { vmid: 100, ostemplate }, c),
    ).rejects.toThrow(/pve_backup_restore/);
    expect(c.calls).toEqual([]);
  });

  it('still accepts normal templates and extra options', async () => {
    expect(isBackupVolume('local:vztmpl/debian-12-standard_12.7-1_amd64.tar.zst')).toBe(false);
    const c = create();
    await callTool(
      guestTools,
      'pve_lxc_create',
      {
        vmid: 100,
        ostemplate: 'local:vztmpl/debian-12-standard_12.7-1_amd64.tar.zst',
        extra: { cpulimit: 2 },
        wait: false,
      },
      c,
    );
    expect(writes(c)[0]).toMatchObject({ method: 'POST', path: '/nodes/pve1/lxc' });
  });
});

describe('pve_guest_update_config disk deletion', () => {
  it('refuses force in set before any change', async () => {
    const c = fakeClient({
      'GET /cluster/resources': resources,
      'PUT /nodes/pve1/qemu/100/config': null,
    } as never);
    await expect(
      callTool(
        guestTools,
        'pve_guest_update_config',
        { vmid: 100, set: { force: true }, delete: ['scsi0'] },
        c,
      ),
    ).rejects.toThrow(/"force" is not allowed/);
    expect(writes(c)).toEqual([]);
  });

  it.each([
    [['scsi0'], ['scsi0']],
    [['unused0'], ['unused0']],
    [['net0,virtio1'], ['virtio1']],
    [
      ['tags', 'sata2 ide0'],
      ['sata2', 'ide0'],
    ],
    [['efidisk0;tpmstate0'], ['efidisk0', 'tpmstate0']],
    [['rootfs'], ['rootfs']],
    [['mp3'], ['mp3']],
    [['vmstate'], ['vmstate']],
    [['cores\u00a0unused1'], ['unused1']],
    [['cores\u3000unused2'], ['unused2']],
  ])('asks before deleting %j', async (list, keys) => {
    expect(diskKeysIn(list)).toEqual(keys);
    expect(await needs('pve_guest_update_config', { vmid: 100, delete: list })).toBe(true);
  });

  it.each([[['net0']], [['tags', 'description']], [['scsihw']], [['mpx']], [[]]])(
    'does not ask for %j',
    async (list) => {
      expect(await needs('pve_guest_update_config', { vmid: 100, delete: list })).toBe(false);
    },
  );

  it.each([
    ['unused0\u0000'],
    ['cores\u0000unused0'],
    ['unused0\t'],
    ['scsi0\n'],
    ['unused0\u0085'],
    ['unused0\u007f'],
    ['unused0\u009f'],
  ])('refuses the delete entry %j with a control character before any change', async (entry) => {
    expect(() => diskKeysIn([entry])).toThrow(/control characters/);
    await expect(needs('pve_guest_update_config', { vmid: 100, delete: [entry] })).rejects.toThrow(
      /control characters/,
    );
    const c = fakeClient({
      'GET /cluster/resources': resources,
      'PUT /nodes/pve1/qemu/100/config': null,
    } as never);
    await expect(
      callTool(guestTools, 'pve_guest_update_config', { vmid: 100, delete: [entry] }, c),
    ).rejects.toThrow(/control characters/);
    expect(writes(c)).toEqual([]);
  });

  it('refuses a NUL delete entry through the server without asking or writing', async () => {
    const client = fakeClient({
      'GET /cluster/resources': resources,
      'PUT /nodes/pve1/qemu/100/config': null,
    } as never);
    const server = createServer({
      settings: fakeSettings({ confirmDestructive: 'never' }),
      hosts: fakeHosts({ test: client }),
      tools: guestTools,
      log: () => undefined,
    });
    const h = await connect(server, { capabilities: { elicitation: { form: {} } } });
    const r = await h.callTool('pve_guest_update_config', {
      vmid: 100,
      delete: ['unused0\u0000'],
    });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toContain('control characters');
    expect(writes(client)).toEqual([]);
    await h.close();
  });

  it('sends the delete list split like Proxmox splits it', async () => {
    const c = fakeClient({
      'GET /cluster/resources': resources,
      'PUT /nodes/pve1/qemu/100/config': null,
    } as never);
    await callTool(guestTools, 'pve_guest_update_config', { vmid: 100, delete: ['a; b', 'c'] }, c);
    expect(writes(c)[0]?.params).toMatchObject({ delete: 'a,b,c' });
  });

  it('splitList matches PVE::Tools::split_list and refuses C0, DEL and C1', () => {
    expect(splitList([' a,b;;c  d ', '', 'e'], 'x')).toEqual(['a', 'b', 'c', 'd', 'e']);
    expect(splitList(undefined, 'x')).toEqual([]);
    for (const bad of ['\u0000', '\u001f', '\u007f', '\u0080', '\u009f', 'a\rb']) {
      expect(() => splitList([bad], 'delete')).toThrow(/delete: entries must not contain/);
    }
  });

  it('names the keys and the guest in the question', async () => {
    expect(
      await targetOf('pve_guest_update_config', { vmid: 100, delete: ['scsi0', 'net1'] }, lookup()),
    ).toBe('delete scsi0 from VMID 100 ("web01", qemu on node pve1)');
  });

  it('asks the user through the server and changes nothing on decline', async () => {
    const client = fakeClient({
      'GET /cluster/resources': resources,
      'PUT /nodes/pve1/qemu/100/config': null,
    } as never);
    const server = createServer({
      settings: fakeSettings(),
      hosts: fakeHosts({ test: client }),
      tools: guestTools,
      log: () => undefined,
    });
    const h = await connect(server, {
      capabilities: { elicitation: { form: {} } },
      onRequest: () => ({ action: 'decline' }),
    });
    const r = await h.callTool('pve_guest_update_config', { vmid: 100, delete: ['unused0'] });
    expect(h.incoming[0]?.method).toBe('elicitation/create');
    expect(JSON.stringify(h.incoming[0]?.params)).toContain('delete unused0 from VMID 100');
    expect(textOf(r)).toContain('not confirmed');
    expect(writes(client)).toEqual([]);
    await h.close();
  });
});

describe('confirmation answers are bound to the question', () => {
  it('does not accept an answer that the client sends along without being asked', async () => {
    const client = fakeClient({
      'GET /cluster/resources': resources,
      'DELETE /nodes/pve1/qemu/100': null,
    } as never);
    const server = createServer({
      settings: fakeSettings(),
      hosts: fakeHosts({ test: client }),
      tools: guestTools,
      log: () => undefined,
    });
    const h = await connect(server, {
      capabilities: { elicitation: { form: {} } },
      onRequest: () => ({ action: 'decline' }),
    });
    const r = await h.request('tools/call', {
      name: 'pve_guest_delete',
      arguments: { vmid: 100 },
      inputResponses: { confirm: { action: 'accept', content: { confirm: true } } },
    });
    expect(h.incoming.map((m) => m.method)).toEqual(['elicitation/create']);
    expect(textOf(r)).toContain('not confirmed');
    expect(writes(client)).toEqual([]);
    await h.close();
  });

  it('runs after the user accepted the question for these arguments', async () => {
    const client = fakeClient({
      'GET /cluster/resources': resources,
      'DELETE /nodes/pve1/qemu/100': null,
    } as never);
    const server = createServer({
      settings: fakeSettings(),
      hosts: fakeHosts({ test: client }),
      tools: guestTools,
      log: () => undefined,
    });
    const h = await connect(server, {
      capabilities: { elicitation: { form: {} } },
      onRequest: () => ({ action: 'accept', content: { confirm: true } }),
    });
    const r = await h.callTool('pve_guest_delete', { vmid: 100 });
    expect(r.isError).toBeFalsy();
    expect(writes(client)).toEqual([
      expect.objectContaining({ method: 'DELETE', path: '/nodes/pve1/qemu/100' }),
    ]);
    await h.close();
  });
});

describe('prune-backups changes ask first', () => {
  it.each([
    [{ storage: 'bk', update: true, options: { 'prune-backups': 'keep-last=1' } }, true],
    [{ storage: 'bk', update: true, delete: ['prune-backups'] }, true],
    [{ storage: 'bk', update: true, delete: ['shared,prune-backups'] }, true],
    [{ storage: 'bk', type: 'dir', options: { path: '/x', 'prune-backups': 'keep-all=1' } }, true],
    [{ storage: 'bk', update: true, options: { path: '/x' } }, false],
    [{ storage: 'bk', update: true, delete: ['nodes'] }, false],
  ])('pve_storage_define %j', async (args, expected) => {
    expect(await needs('pve_storage_define', args)).toBe(expected);
  });

  it.each([
    ['pve_storage_define', { storage: 'bk', update: true, delete: ['prune-backups\u0000'] }],
    ['pve_storage_define', { storage: 'bk', update: true, delete: ['nodes\u0000prune-backups'] }],
    ['pve_backup_job_set', { id: 'j1', delete: ['prune-backups\u0000'] }],
    ['pve_backup_job_set', { id: 'j1', delete: ['prune-backups\u2028\u0085'] }],
  ] as const)('%s refuses %j before any change', async (name, args) => {
    await expect(needs(name, args)).rejects.toThrow(/control characters/);
    const c = fakeClient({ 'PUT /storage/bk': null, 'PUT /cluster/backup/j1': null } as never);
    const tools = name === 'pve_storage_define' ? storageTools : backupTools;
    await expect(callTool(tools, name, args, c)).rejects.toThrow(/control characters/);
    expect(writes(c)).toEqual([]);
  });

  it.each([
    [{ id: 'j1', pruneBackups: 'keep-last=1' }, true],
    [{ id: 'j1', extra: { 'prune-backups': 'keep-last=1' } }, true],
    [{ id: 'j1', delete: ['prune-backups'] }, true],
    [{ schedule: 'daily', all: true, pruneBackups: 'keep-daily=7' }, true],
    [{ id: 'j1', schedule: 'daily' }, false],
  ])('pve_backup_job_set %j', async (args, expected) => {
    expect(await needs('pve_backup_job_set', args)).toBe(expected);
  });

  it('names value and target', async () => {
    expect(
      await targetOf(
        'pve_storage_define',
        { storage: 'bk', update: true, options: { 'prune-backups': 'keep-last=1' } },
        fakeClient(),
      ),
    ).toBe('set prune-backups to "keep-last=1" on existing storage bk');
    expect(
      await targetOf('pve_backup_job_set', { id: 'j1', delete: ['prune-backups'] }, fakeClient()),
    ).toBe('remove prune-backups (back to the default retention) on backup job "j1"');
  });
});

describe('firewall lockout confirmation', () => {
  it.each([
    ['pve_firewall_rule_add', { level: 'cluster', type: 'in', action: 'DROP' }, true],
    ['pve_firewall_rule_add', { level: 'node', node: 'pve1', type: 'in', action: 'REJECT' }, true],
    ['pve_firewall_rule_add', { level: 'node', type: 'in', action: 'drop' }, true],
    ['pve_firewall_rule_add', { level: 'guest', vmid: 100, type: 'in', action: 'DROP' }, false],
    ['pve_firewall_rule_add', { level: 'cluster', type: 'in', action: 'ACCEPT' }, false],
    ['pve_firewall_rule_update', { level: 'cluster', pos: 0, action: 'REJECT' }, true],
    ['pve_firewall_rule_update', { level: 'cluster', pos: 0, comment: 'x' }, false],
    ['pve_firewall_rule_update', { level: 'guest', vmid: 100, pos: 0, action: 'DROP' }, false],
    ['pve_firewall_options_set', { level: 'cluster', delete: ['policy_in'] }, true],
    ['pve_firewall_options_set', { level: 'node', delete: ['enable'] }, true],
    ['pve_firewall_options_set', { level: 'cluster', delete: ['policy_forward'] }, true],
    ['pve_firewall_options_set', { level: 'cluster', delete: ['log_level_in'] }, false],
    ['pve_firewall_options_set', { level: 'guest', vmid: 100, delete: ['policy_in'] }, false],
  ] as const)('%s %j asks: %s', async (name, args, expected) => {
    const client = fakeClient({
      'GET /cluster/firewall/rules/0': { pos: 0, type: 'in', action: 'ACCEPT', enable: 1 },
    } as never);
    expect(await needs(name, args, client)).toBe(expected);
  });

  it('describes the rule and level', async () => {
    expect(
      await targetOf(
        'pve_firewall_rule_add',
        { level: 'cluster', type: 'in', action: 'DROP', proto: 'tcp', dport: '8006' },
        fakeClient(),
      ),
    ).toBe(
      'add firewall rule "in" "DROP" proto "tcp" dport "8006" at the end on cluster level (datacenter wide)',
    );
    expect(
      await targetOf(
        'pve_firewall_options_set',
        { level: 'node', node: 'pve1', delete: ['policy_in'] },
        fakeClient(),
      ),
    ).toBe('reset policy_in to the default in the firewall options on node level of node pve1');
  });
});

describe('pve_firewall_rule_update reads the current rule before deciding', () => {
  const drop = { pos: 2, type: 'in', action: 'DROP', proto: 'tcp', dport: '8006', enable: 1 };
  const accept = { pos: 2, type: 'in', action: 'ACCEPT', proto: 'tcp', dport: '22', enable: 1 };
  const off = (rule: Record<string, unknown>) => ({ ...rule, enable: 0 });
  const group = { pos: 2, type: 'group', action: 'lockdown', enable: 0 };
  const cluster = (rule: unknown) => fakeClient({ 'GET /cluster/firewall/rules/2': rule } as never);
  const node = (rule: unknown) =>
    fakeClient({
      'GET /nodes': [{ node: 'pve1' }],
      'GET /nodes/pve1/firewall/rules/2': rule,
    } as never);

  it.each([
    ['arms a disabled DROP rule', off(drop), { enable: true }, true],
    ['widens the source of an active DROP rule', drop, { source: '0.0.0.0/0' }, true],
    ['clears the port of an active DROP rule', drop, { delete: ['dport'] }, true],
    ['moves an active DROP rule', drop, { moveto: 0 }, true],
    ['turns an ACCEPT rule into a group', accept, { type: 'group', action: 'lockdown' }, true],
    ['enables a security group rule', group, { enable: true }, true],
    ['disables an active ACCEPT rule', accept, { enable: false }, true],
    ['changes the port of an active ACCEPT rule', accept, { dport: '2222' }, true],
    ['changes the source of an active ACCEPT rule', accept, { source: '192.0.2.1' }, true],
    ['changes the interface of an active ACCEPT rule', accept, { iface: 'vmbr1' }, true],
    ['clears the protocol of an active ACCEPT rule', accept, { delete: ['proto'] }, true],
    ['moves an active ACCEPT rule', accept, { moveto: 9 }, true],
    ['edits only the comment of an active DROP rule', drop, { comment: 'x' }, false],
    ['edits only the log level of an active ACCEPT rule', accept, { log: 'info' }, false],
    ['sets the same action in other case', accept, { action: 'accept' }, false],
    ['changes the port of a disabled DROP rule', off(drop), { dport: '8007' }, false],
    ['changes the port of a disabled ACCEPT rule', off(accept), { dport: '2222' }, false],
    ['enables an ACCEPT rule', off(accept), { enable: true }, false],
    ['cannot read the rule', null, { comment: 'x' }, true],
  ] as const)('cluster level: %s asks: %s', async (_label, rule, change, expected) => {
    const args = { level: 'cluster', pos: 2, ...change };
    const c = rule === null ? fakeClient() : cluster(rule);
    expect(await needs('pve_firewall_rule_update', args, c)).toBe(expected);
    expect(writes(c)).toEqual([]);
  });

  it('node level reads the rule of the resolved node', async () => {
    expect(
      await needs(
        'pve_firewall_rule_update',
        { level: 'node', pos: 2, enable: true },
        node(off(drop)),
      ),
    ).toBe(true);
    expect(
      await needs(
        'pve_firewall_rule_update',
        { level: 'node', pos: 2, enable: false },
        node(accept),
      ),
    ).toBe(true);
    expect(
      await needs(
        'pve_firewall_rule_update',
        { level: 'node', pos: 2, comment: 'c' },
        node(accept),
      ),
    ).toBe(false);
  });

  it('guest level never asks and reads nothing', async () => {
    const c = fakeClient();
    expect(
      await needs(
        'pve_firewall_rule_update',
        { level: 'guest', vmid: 100, pos: 2, enable: true },
        c,
      ),
    ).toBe(false);
    expect(c.calls).toEqual([]);
  });

  it('asks without a context to read from', async () => {
    const def = firewallTools.find((t) => t.name === 'pve_firewall_rule_update');
    expect(
      await def?.needsConfirmation?.(
        parsed('pve_firewall_rule_update', { level: 'cluster', pos: 2 }),
      ),
    ).toBe(true);
  });

  it('shows the current rule in the question and changes nothing on decline', async () => {
    const client = fakeClient({
      'GET /cluster/firewall/rules/2': off(drop),
      'PUT /cluster/firewall/rules/2': null,
    } as never);
    expect(
      await targetOf(
        'pve_firewall_rule_update',
        { level: 'cluster', pos: 2, enable: true },
        client,
      ),
    ).toBe(
      'change firewall rule 2 (now "in" "DROP" proto "tcp" dport "8006" disabled) to enabled on cluster level (datacenter wide)',
    );
    const server = createServer({
      settings: fakeSettings(),
      hosts: fakeHosts({ test: client }),
      tools: firewallTools,
      log: () => undefined,
    });
    const h = await connect(server, {
      capabilities: { elicitation: { form: {} } },
      onRequest: () => ({ action: 'decline' }),
    });
    const r = await h.callTool('pve_firewall_rule_update', {
      level: 'cluster',
      pos: 2,
      enable: true,
    });
    expect(h.incoming[0]?.method).toBe('elicitation/create');
    expect(textOf(r)).toContain('not confirmed');
    expect(writes(client)).toEqual([]);
    await h.close();
  });
});

describe('free-form records cannot override typed or path fields', () => {
  it.each(['iface', 'type', 'node', 'delete'])('pve_network_set refuses extra.%s', async (key) => {
    const c = fakeClient({ 'POST /nodes/pve1/network': null } as never);
    await expect(
      callTool(
        networkTools,
        'pve_network_set',
        { node: 'pve1', iface: 'vmbr1', type: 'bridge', extra: { [key]: 'vmbr0' } },
        c,
      ),
    ).rejects.toThrow(/not allowed/);
    expect(writes(c)).toEqual([]);
  });

  it.each(['id', 'delete'])('pve_backup_job_set refuses extra.%s', async (key) => {
    const c = fakeClient({ 'PUT /cluster/backup/j1': null } as never);
    await expect(
      callTool(backupTools, 'pve_backup_job_set', { id: 'j1', extra: { [key]: 'x' } }, c),
    ).rejects.toThrow(/not allowed/);
    expect(writes(c)).toEqual([]);
  });

  it('pve_storage_define refuses options.storage', async () => {
    const c = fakeClient({ 'PUT /storage/bk': null } as never);
    await expect(
      callTool(
        storageTools,
        'pve_storage_define',
        { storage: 'bk', update: true, options: { storage: 'other' } },
        c,
      ),
    ).rejects.toThrow(/not allowed/);
    expect(writes(c)).toEqual([]);
  });

  it('pve_guest_update_config refuses set.delete', async () => {
    const c = fakeClient({ 'GET /cluster/resources': resources } as never);
    await expect(
      callTool(guestTools, 'pve_guest_update_config', { vmid: 100, set: { delete: 'scsi0' } }, c),
    ).rejects.toThrow(/use the delete argument/);
  });
});

describe('pve_api_get refuses URL fetching endpoints in read-only mode', () => {
  const blocked: Array<[string, Record<string, unknown>]> = [
    ['/cluster/acme/tos', { directory: 'http://192.0.2.1/' }],
    ['/cluster/acme/meta', { directory: 'http://169.254.169.254/' }],
    ['/cluster/acme/directories', { directory: 'http://x/' }],
    ['/nodes/pve1/query-url-metadata', { url: 'http://10.0.0.1:8080/' }],
    ['/Cluster/ACME/tos', { directory: 'http://x/' }],
    ['/cluster%2Facme/tos', { directory: 'http://x/' }],
    ['/cluster/acme/%74os', { directory: 'http://x/' }],
    ['/nodes/pve1/query-url-metadata', { URL: 'http://x/' }],
    ['/nodes/pve1/scan/nfs', { server: '169.254.169.254' }],
    ['/nodes/pve1/scan/cifs', { server: '10.0.0.5', username: 'u' }],
    ['/nodes/pve1/scan/pbs', { server: '10.0.0.6', username: 'u@pbs', password: 'x' }],
    ['/nodes/pve1/scan/glusterfs', { server: '10.0.0.7' }],
    ['/nodes/pve1/scan/iscsi', { portal: '10.0.0.8:3260' }],
    ['/nodes/pve1/scan/NFS', { Server: '10.0.0.9' }],
  ];

  it.each(blocked)('refuses %s %j with global read-only', async (path, params) => {
    const c = fakeClient();
    const ctx = fakeContext(c, { settings: fakeSettings({ readOnly: true }) });
    await expect(callTool(apiTools, 'pve_api_get', { path, params }, c, ctx)).rejects.toThrow(
      /refused in read-only mode/,
    );
    expect(c.calls).toEqual([]);
  });

  it('refuses for a read-only host as well', async () => {
    const c = fakeClient({}, { readOnly: true });
    await expect(
      callTool(
        apiTools,
        'pve_api_get',
        { path: '/cluster/acme/tos', params: { directory: 'http://x/' } },
        c,
      ),
    ).rejects.toThrow(/read-only/);
    expect(c.calls).toEqual([]);
  });

  it('allows the same paths without the URL parameter and on writable hosts', async () => {
    expect(urlFetchProblem('/cluster/acme/tos', {})).toBeUndefined();
    expect(urlFetchProblem('/cluster/acme/plugins', { directory: 'x' })).toBeUndefined();
    expect(urlFetchProblem('/nodes/pve1/scan/lvm', {})).toBeUndefined();
    expect(urlFetchProblem('/nodes/pve1/scan/zfs', {})).toBeUndefined();
    const c = fakeClient({ 'GET /cluster/acme/tos': 'https://example.test/tos' } as never);
    expect(
      await callTool(
        apiTools,
        'pve_api_get',
        { path: '/cluster/acme/tos', params: { directory: 'https://acme.example.test/' } },
        c,
      ),
    ).toBe('https://example.test/tos');
  });
});
