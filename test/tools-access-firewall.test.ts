import { describe, expect, it } from 'vitest';
import { accessTools } from '../src/tools/access.js';
import { firewallTools } from '../src/tools/firewall.js';
import { callTool } from './helpers/call-tool.js';
import { fakeClient, type FakeClient } from './helpers/fake-client.js';
import { fakeContext } from './helpers/fixtures.js';

const last = (c: FakeClient) => c.calls[c.calls.length - 1];
const runAccess = (c: FakeClient, name: string, args: Record<string, unknown> = {}) =>
  callTool(accessTools, name, args, c);
const runFw = (c: FakeClient, name: string, args: Record<string, unknown> = {}) =>
  callTool(firewallTools, name, args, c);

describe('access tools', () => {
  it('uses the contract names, categories and access levels', () => {
    expect(accessTools.map((t) => `${t.name}:${t.category}:${t.access}`)).toEqual([
      'pve_access_list:access:read',
      'pve_access_permissions:access:read',
    ]);
  });

  it('lists users compactly and drops secret-like keys', async () => {
    const c = fakeClient({
      'GET /access/users': [
        { userid: 'admin@pve', enable: 1, expire: 0, password: 'x', keys: 'y', internal: 1 },
      ],
    } as never);
    const out = (await runAccess(c, 'pve_access_list', { kind: 'users' })) as {
      items: Array<Record<string, unknown>>;
    };
    expect(last(c)).toMatchObject({ method: 'GET', path: '/access/users' });
    expect(out.items[0]).toEqual({ userid: 'admin@pve', enable: 1, expire: 'never' });
    const full = (await runAccess(c, 'pve_access_list', { kind: 'users', full: true })) as {
      items: Array<Record<string, unknown>>;
    };
    expect(full.items[0]).toHaveProperty('internal');
    expect(full.items[0]).not.toHaveProperty('password');
    expect(full.items[0]).not.toHaveProperty('keys');
  });

  it.each([
    ['groups', '/access/groups'],
    ['roles', '/access/roles'],
    ['acl', '/access/acl'],
    ['realms', '/access/domains'],
  ])('reads %s from %s', async (kind, path) => {
    const c = fakeClient({ [`GET ${path}`]: [] } as never);
    await runAccess(c, 'pve_access_list', { kind });
    expect(last(c)?.path).toBe(path);
  });

  it('lists tokens of a user without any secret value and requires the userid', async () => {
    const c = fakeClient({
      'GET /access/users/admin%40pve/token': [
        { tokenid: 'mcp', privsep: 1, expire: 1700000000, value: 'SECRET-VALUE' },
      ],
    } as never);
    const out = await runAccess(c, 'pve_access_list', { kind: 'tokens', userid: 'admin@pve' });
    expect(JSON.stringify(out)).not.toContain('SECRET-VALUE');
    expect(out).toMatchObject({
      items: [{ tokenid: 'mcp', privsep: 1, expire: '2023-11-14T22:13:20.000Z' }],
    });
    await expect(runAccess(c, 'pve_access_list', { kind: 'tokens' })).rejects.toThrow(/userid/);
  });

  it('returns permissions per path, for the own token or a given user', async () => {
    const c = fakeClient({
      'GET /access/permissions': { '/vms/100': { 'VM.Audit': 1, 'VM.Console': 1, 'Sys.Audit': 0 } },
    } as never);
    const own = await runAccess(c, 'pve_access_permissions', { path: '/vms/100' });
    expect(last(c)?.params).toMatchObject({ path: '/vms/100' });
    expect(last(c)?.params?.userid).toBeUndefined();
    expect(own).toEqual({
      userid: 'current token',
      paths: { '/vms/100': { privileges: ['VM.Audit', 'VM.Console'], noPropagate: ['Sys.Audit'] } },
    });
    await runAccess(c, 'pve_access_permissions', { userid: 'admin@pve!mcp' });
    expect(last(c)?.params).toMatchObject({ userid: 'admin@pve!mcp' });
  });
});

const resources = [
  { type: 'qemu', vmid: 100, node: 'pve1' },
  { type: 'lxc', vmid: 200, node: 'pve2' },
];

describe('firewall tools', () => {
  it('uses the contract names, categories and access levels', () => {
    expect(firewallTools.map((t) => `${t.name}:${t.category}:${t.access}`)).toEqual([
      'pve_firewall_rules:firewall:read',
      'pve_firewall_rule_add:firewall:write',
      'pve_firewall_rule_update:firewall:write',
      'pve_firewall_rule_delete:firewall:destructive',
      'pve_firewall_options:firewall:read',
      'pve_firewall_options_set:firewall:write',
    ]);
  });

  it('resolves the scope to the cluster, node and guest firewall paths', async () => {
    const c = fakeClient({
      'GET /nodes': [{ node: 'pve1' }],
      'GET /cluster/resources': resources,
      'GET /cluster/firewall/rules': [],
      'GET /nodes/pve1/firewall/rules': [],
      'GET /nodes/pve1/qemu/100/firewall/rules': [],
      'GET /nodes/pve2/lxc/200/firewall/rules': [],
    } as never);
    await runFw(c, 'pve_firewall_rules', { level: 'cluster' });
    expect(last(c)?.path).toBe('/cluster/firewall/rules');
    await runFw(c, 'pve_firewall_rules', { level: 'node' });
    expect(last(c)?.path).toBe('/nodes/pve1/firewall/rules');
    await runFw(c, 'pve_firewall_rules', { level: 'node', node: 'pve1' });
    expect(last(c)?.path).toBe('/nodes/pve1/firewall/rules');
    await runFw(c, 'pve_firewall_rules', { level: 'guest', vmid: 100 });
    expect(last(c)?.path).toBe('/nodes/pve1/qemu/100/firewall/rules');
    await runFw(c, 'pve_firewall_rules', { level: 'guest', vmid: 200 });
    expect(last(c)?.path).toBe('/nodes/pve2/lxc/200/firewall/rules');
  });

  it('rejects arguments that do not belong to the level', async () => {
    const c = fakeClient({ 'GET /cluster/resources': resources } as never);
    await expect(runFw(c, 'pve_firewall_rules', { level: 'guest' })).rejects.toThrow(
      /requires vmid/,
    );
    await expect(runFw(c, 'pve_firewall_rules', { level: 'cluster', vmid: 100 })).rejects.toThrow(
      /cluster takes no/,
    );
    await expect(
      runFw(c, 'pve_firewall_rules', { level: 'node', node: 'pve1', vmid: 100 }),
    ).rejects.toThrow(/node takes no/);
    await expect(runFw(c, 'pve_firewall_rules', { level: 'guest', vmid: 999 })).rejects.toThrow(
      /No guest with VMID 999/,
    );
    // Nothing was sent to a firewall endpoint after any of these failures.
    expect(c.calls.every((x) => !x.path.includes('/firewall'))).toBe(true);
  });

  it('lists rules with the digest hoisted out of the rows', async () => {
    const c = fakeClient({
      'GET /cluster/firewall/rules': [
        { pos: 0, type: 'in', action: 'ACCEPT', digest: 'a'.repeat(40) },
      ],
    } as never);
    const out = await runFw(c, 'pve_firewall_rules', { level: 'cluster' });
    expect(out).toEqual({
      scope: 'cluster',
      count: 1,
      digest: 'a'.repeat(40),
      rules: [{ pos: 0, type: 'in', action: 'ACCEPT' }],
    });
  });

  it('falls back to the first rule for the digest when the list has none', async () => {
    const c = fakeClient({
      'GET /cluster/firewall/rules': [{ pos: 0, type: 'in', action: 'DROP' }],
      'GET /cluster/firewall/rules/0': { digest: 'b'.repeat(40) },
    } as never);
    const out = (await runFw(c, 'pve_firewall_rules', { level: 'cluster' })) as { digest: string };
    expect(out.digest).toBe('b'.repeat(40));
  });

  it('adds a rule with all fields at a guest', async () => {
    const c = fakeClient({
      'GET /cluster/resources': resources,
      'POST /nodes/pve1/qemu/100/firewall/rules': null,
    } as never);
    await runFw(c, 'pve_firewall_rule_add', {
      level: 'guest',
      vmid: 100,
      type: 'in',
      action: 'ACCEPT',
      enable: true,
      source: '192.0.2.0/24',
      proto: 'tcp',
      dport: '22',
      comment: 'ssh',
      log: 'nolog',
      pos: 0,
      digest: 'c'.repeat(40),
    });
    expect(last(c)).toMatchObject({
      method: 'POST',
      path: '/nodes/pve1/qemu/100/firewall/rules',
      params: {
        type: 'in',
        action: 'ACCEPT',
        enable: true,
        source: '192.0.2.0/24',
        proto: 'tcp',
        dport: '22',
        comment: 'ssh',
        log: 'nolog',
        pos: 0,
        digest: 'c'.repeat(40),
      },
    });
    expect(last(c)?.params).not.toHaveProperty('level');
    await expect(
      runFw(c, 'pve_firewall_rule_add', { level: 'cluster', type: 'in', action: 'bad action' }),
    ).rejects.toThrow();
  });

  it('updates a rule, moves it, and refuses a move combined with edits', async () => {
    const c = fakeClient({ 'PUT /cluster/firewall/rules/3': null } as never);
    await runFw(c, 'pve_firewall_rule_update', {
      level: 'cluster',
      pos: 3,
      action: 'DROP',
      delete: ['comment', 'dport'],
    });
    expect(last(c)).toMatchObject({
      method: 'PUT',
      path: '/cluster/firewall/rules/3',
      params: { action: 'DROP', delete: 'comment,dport' },
    });
    await runFw(c, 'pve_firewall_rule_update', { level: 'cluster', pos: 3, moveto: 0 });
    expect(last(c)?.params).toMatchObject({ moveto: 0 });
    await expect(
      runFw(c, 'pve_firewall_rule_update', { level: 'cluster', pos: 3, moveto: 0, comment: 'x' }),
    ).rejects.toThrow(/moveto cannot be combined/);
  });

  it('deletes a rule with digest and names the scope in the confirmation', async () => {
    const c = fakeClient({ 'DELETE /nodes/pve1/firewall/rules/2': null } as never);
    await runFw(c, 'pve_firewall_rule_delete', {
      level: 'node',
      node: 'pve1',
      pos: 2,
      digest: 'd'.repeat(40),
    });
    expect(last(c)).toMatchObject({
      method: 'DELETE',
      path: '/nodes/pve1/firewall/rules/2',
      params: { digest: 'd'.repeat(40) },
    });
    const tool = firewallTools.find((t) => t.name === 'pve_firewall_rule_delete');
    const lookup = fakeClient({
      'GET /nodes/pve1/firewall/rules/2': {
        pos: 2,
        type: 'in',
        action: 'ACCEPT',
        proto: 'tcp',
        dport: '22',
        enable: 1,
      },
    } as never);
    expect(
      await tool?.confirmTarget?.(
        { level: 'node', node: 'pve1', pos: 2 } as never,
        fakeContext(lookup),
      ),
    ).toBe(
      'delete firewall rule 2 ("in" "ACCEPT" proto "tcp" dport "22" enabled) on node level of node pve1',
    );
  });

  it('reads and sets options, with confirmation only for lockout-prone changes', async () => {
    const c = fakeClient({
      'GET /cluster/firewall/options': { enable: 0, digest: 'e'.repeat(40) },
      'PUT /cluster/firewall/options': null,
    } as never);
    expect(await runFw(c, 'pve_firewall_options', { level: 'cluster' })).toMatchObject({
      options: { enable: 0 },
    });
    await runFw(c, 'pve_firewall_options_set', {
      level: 'cluster',
      options: { enable: true, policy_in: 'DROP' },
      delete: ['log_ratelimit'],
      digest: 'e'.repeat(40),
    });
    expect(last(c)).toMatchObject({
      method: 'PUT',
      path: '/cluster/firewall/options',
      params: { enable: true, policy_in: 'DROP', delete: 'log_ratelimit', digest: 'e'.repeat(40) },
    });
    await expect(runFw(c, 'pve_firewall_options_set', { level: 'cluster' })).rejects.toThrow(
      /Pass options/,
    );
    await expect(
      runFw(c, 'pve_firewall_options_set', { level: 'cluster', options: { digest: 'x' } }),
    ).rejects.toThrow(/not an option/);
    const tool = firewallTools.find((t) => t.name === 'pve_firewall_options_set');
    const asks = (level: string, options: Record<string, unknown>) =>
      tool?.needsConfirmation?.({ level, options } as never);
    expect(asks('cluster', { enable: true })).toBe(true);
    expect(asks('node', { policy_in: 'DROP' })).toBe(true);
    expect(asks('cluster', { log_level_in: 'info' })).toBe(false);
    expect(asks('guest', { enable: true })).toBe(false);
  });
});
