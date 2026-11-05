/* eslint-disable @typescript-eslint/no-explicit-any -- tool results and MCP payloads are asserted as loose JSON */
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { apiTools, describeApiPath } from '../src/tools/api.js';
import { clusterTools } from '../src/tools/cluster.js';
import { coreTools } from '../src/tools/core.js';
import { taskTools } from '../src/tools/tasks.js';
import { ALL_TOOLS } from '../src/tools/catalog.js';
import type { AnyToolDef } from '../src/server/registry.js';
import { fakeClient } from './helpers/fake-client.js';
import { fakeContext, fakeHosts, fakeSettings } from './helpers/fixtures.js';

function tool(list: AnyToolDef[], name: string): AnyToolDef {
  const t = list.find((x) => x.name === name);
  if (!t) throw new Error(`no tool ${name}`);
  return t;
}

/** Parses the arguments like the framework does, so defaults and limits apply. */
function run(def: AnyToolDef, args: Record<string, unknown>, ctx: ReturnType<typeof fakeContext>) {
  return def.handler(z.object(def.input).parse(args) as never, ctx);
}

const UPID = 'UPID:pve1:000A1B2C:0123ABCD:65F0A1B2:vzdump:100:root@pam:';
const UPID_PATH =
  '/nodes/pve1/tasks/UPID%3Apve1%3A000A1B2C%3A0123ABCD%3A65F0A1B2%3Avzdump%3A100%3Aroot%40pam%3A';

describe('catalog', () => {
  it('has unique names with the pve_ prefix and the contract access levels', () => {
    const names = ALL_TOOLS.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
    for (const t of ALL_TOOLS) expect(t.name).toMatch(/^pve_[a-z0-9_]+$/);
    const mine = [...coreTools, ...clusterTools, ...taskTools, ...apiTools];
    expect(mine.map((t) => `${t.name}:${t.access}`).sort()).toEqual(
      [
        'pve_hosts_list:read',
        'pve_version:read',
        'pve_cluster_status:read',
        'pve_cluster_resources:read',
        'pve_next_vmid:read',
        'pve_cluster_log:read',
        'pve_task_list:read',
        'pve_task_status:read',
        'pve_task_log:read',
        'pve_task_wait:read',
        'pve_task_stop:write',
        'pve_api_get:read',
        'pve_api_request:write',
        'pve_api_describe:read',
      ].sort(),
    );
    for (const t of mine) {
      expect(t.description).not.toMatch(/[\u2013\u2014\u2018\u2019\u201c\u201d;]/);
      expect(t.description.length).toBeLessThan(900);
    }
  });
});

describe('core', () => {
  it('pve_hosts_list reads the registry without a request', async () => {
    const client = fakeClient({}, { alias: 'lab' });
    const hosts = fakeHosts({ lab: client, office: fakeClient({}, { alias: 'office' }) });
    const ctx = fakeContext(client, { hosts, settings: fakeSettings({ readOnly: true }) });
    const r = (await run(tool(coreTools, 'pve_hosts_list'), {}, ctx)) as any;
    expect(r.defaultHost).toBe('lab');
    expect(r.globalReadOnly).toBe(true);
    expect(r.hosts.map((h: any) => h.alias)).toEqual(['lab', 'office']);
    expect(client.calls).toHaveLength(0);
  });

  it('pve_version calls /version', async () => {
    const client = fakeClient({ 'GET /version': { version: '9.0.3' } });
    expect(await run(tool(coreTools, 'pve_version'), {}, fakeContext(client))).toEqual({
      version: '9.0.3',
    });
  });
});

describe('cluster', () => {
  const resources = [
    {
      id: 'qemu/100',
      type: 'qemu',
      vmid: 100,
      node: 'pve1',
      name: 'a',
      status: 'running',
      netin: 5,
    },
    { id: 'lxc/200', type: 'lxc', vmid: 200, node: 'pve2', name: 'b', status: 'stopped' },
    {
      id: 'storage/pve1/local',
      type: 'storage',
      node: 'pve1',
      storage: 'local',
      status: 'available',
    },
    { id: 'pool/p', type: 'pool', poolid: 'p' },
  ];

  it('pve_cluster_resources filters and keeps compact fields', async () => {
    const client = fakeClient({ 'GET /cluster/resources': resources });
    const ctx = fakeContext(client);
    const def = tool(clusterTools, 'pve_cluster_resources');

    const lxc = (await run(def, { type: 'lxc' }, ctx)) as any;
    expect(lxc.count).toBe(1);
    expect(lxc.resources[0].vmid).toBe(200);
    expect(client.calls[0]?.params).toBeUndefined();

    const running = (await run(def, { node: 'pve1', status: 'running' }, ctx)) as any;
    expect(running.resources).toEqual([
      { id: 'qemu/100', type: 'qemu', node: 'pve1', vmid: 100, name: 'a', status: 'running' },
    ]);

    const full = (await run(def, { type: 'pool', full: true }, ctx)) as any;
    expect(full.resources[0].poolid).toBe('p');
  });

  it('passes server side types to Proxmox', async () => {
    const client = fakeClient({ 'GET /cluster/resources': resources });
    await run(
      tool(clusterTools, 'pve_cluster_resources'),
      { type: 'storage' },
      fakeContext(client),
    );
    expect(client.calls[0]?.params).toEqual({ type: 'storage' });
  });

  it('pve_next_vmid returns a number', async () => {
    const client = fakeClient({ 'GET /cluster/nextid': '105' });
    expect(await run(tool(clusterTools, 'pve_next_vmid'), {}, fakeContext(client))).toEqual({
      vmid: 105,
    });
    await run(tool(clusterTools, 'pve_next_vmid'), { vmid: 300 }, fakeContext(client));
    expect(client.calls[1]?.params).toEqual({ vmid: 300 });
  });

  it('pve_cluster_log defaults max and passes it on', async () => {
    const client = fakeClient({ 'GET /cluster/log': [] });
    const def = tool(clusterTools, 'pve_cluster_log');
    await run(def, {}, fakeContext(client));
    await run(def, { max: 10 }, fakeContext(client));
    expect(client.calls.map((c) => c.params)).toEqual([{ max: 50 }, { max: 10 }]);
  });

  it('pve_cluster_status passes data through', async () => {
    const client = fakeClient({ 'GET /cluster/status': [{ type: 'node', name: 'pve1' }] });
    expect(await run(tool(clusterTools, 'pve_cluster_status'), {}, fakeContext(client))).toEqual([
      { type: 'node', name: 'pve1' },
    ]);
  });
});

describe('tasks', () => {
  it('pve_task_list merges online nodes, sorts and limits', async () => {
    const client = fakeClient({
      'GET /nodes': [
        { node: 'pve1', status: 'online' },
        { node: 'pve2', status: 'online' },
        { node: 'pve3', status: 'offline' },
      ],
      'GET /nodes/pve1/tasks': [{ upid: 'a', starttime: 10 }],
      'GET /nodes/pve2/tasks': [
        { upid: 'b', starttime: 30 },
        { upid: 'c', starttime: 20 },
      ],
    });
    const def = tool(taskTools, 'pve_task_list');
    const r = (await run(def, { limit: 2, vmid: 100, errors: true }, fakeContext(client))) as any;
    expect(r.tasks.map((t: any) => [t.node, t.upid])).toEqual([
      ['pve2', 'b'],
      ['pve2', 'c'],
    ]);
    expect(client.calls.find((c) => c.path === '/nodes/pve1/tasks')?.params).toMatchObject({
      limit: 2,
      vmid: 100,
      errors: true,
    });
    expect(client.calls.some((c) => c.path.includes('pve3'))).toBe(false);
  });

  it('pve_task_list names nodes that failed and still returns the rest', async () => {
    const client = fakeClient({
      'GET /nodes': [
        { node: 'pve1', status: 'online' },
        { node: 'pve2', status: 'online' },
      ],
      'GET /nodes/pve1/tasks': [{ upid: 'a', starttime: 1 }],
      'GET /nodes/pve2/tasks': () => {
        throw new Error('timeout');
      },
    });
    const r = (await run(tool(taskTools, 'pve_task_list'), {}, fakeContext(client))) as any;
    expect(r.count).toBe(1);
    expect(r.nodesNotQueried).toEqual(['pve2']);
  });

  it('pve_task_list with a node queries only that node and surfaces errors', async () => {
    const client = fakeClient({
      'GET /nodes/pve1/tasks': () => {
        throw new Error('403 forbidden');
      },
    });
    await expect(
      run(tool(taskTools, 'pve_task_list'), { node: 'pve1' }, fakeContext(client)),
    ).rejects.toThrow('403');
    expect(client.calls.map((c) => c.path)).toEqual(['/nodes/pve1/tasks']);
  });

  it('pve_task_status derives the node from the UPID', async () => {
    const client = fakeClient({
      [`GET ${UPID_PATH}/status`]: { status: 'stopped', exitstatus: 'OK' },
    });
    const r = (await run(
      tool(taskTools, 'pve_task_status'),
      { upid: UPID },
      fakeContext(client),
    )) as any;
    expect(r).toMatchObject({ node: 'pve1', status: 'stopped', exitstatus: 'OK', upid: UPID });
  });

  it('pve_task_status rejects an invalid UPID before any request', async () => {
    const client = fakeClient();
    await expect(
      run(tool(taskTools, 'pve_task_status'), { upid: 'nonsense' }, fakeContext(client)),
    ).rejects.toThrow(/Invalid UPID/);
    expect(client.calls).toHaveLength(0);
  });

  it('pve_task_log returns lines and nextStart when the page is full', async () => {
    const client = fakeClient({
      [`GET ${UPID_PATH}/log`]: [
        { n: 1, t: 'one' },
        { n: 2, t: 'two' },
      ],
    });
    const def = tool(taskTools, 'pve_task_log');
    const full = (await run(def, { upid: UPID, start: 0, limit: 2 }, fakeContext(client))) as any;
    expect(full).toMatchObject({ lines: ['one', 'two'], nextStart: 2 });
    const part = (await run(def, { upid: UPID, limit: 5 }, fakeContext(client))) as any;
    expect(part.nextStart).toBeUndefined();
    expect(client.calls[0]?.params).toEqual({ start: 0, limit: 2 });
  });

  it('pve_task_wait caps the timeout at the configured limit', async () => {
    const client = fakeClient({
      [`GET ${UPID_PATH}/status`]: { status: 'running' },
      [`GET ${UPID_PATH}/log`]: [],
    });
    const ctx = fakeContext(client, {
      settings: fakeSettings({ limits: { maxOutputChars: 1000, taskWaitSeconds: 0.05 } }),
    });
    const started = Date.now();
    const r = (await run(
      tool(taskTools, 'pve_task_wait'),
      { upid: UPID, timeoutSeconds: 3600 },
      ctx,
    )) as any;
    expect(r.timedOut).toBe(true);
    expect(Date.now() - started).toBeLessThan(2500);
  });

  it('pve_task_wait returns the finished result', async () => {
    const client = fakeClient({
      [`GET ${UPID_PATH}/status`]: { status: 'stopped', exitstatus: 'OK' },
      [`GET ${UPID_PATH}/log`]: [{ n: 1, t: 'TASK OK' }],
    });
    const r = (await run(
      tool(taskTools, 'pve_task_wait'),
      { upid: UPID },
      fakeContext(client),
    )) as any;
    expect(r).toMatchObject({ ok: true, log: ['TASK OK'] });
  });

  it('pve_task_stop sends DELETE to the task path', async () => {
    const client = fakeClient({
      [`DELETE ${UPID_PATH}`]: null,
      [`GET ${UPID_PATH}/log`]: [],
      [`GET ${UPID_PATH}/status`]: { status: 'stopped', exitstatus: 'unexpected status' },
    });
    const r = (await run(
      tool(taskTools, 'pve_task_stop'),
      { upid: UPID },
      fakeContext(client),
    )) as any;
    expect(client.calls[0]).toMatchObject({ method: 'DELETE', path: UPID_PATH });
    expect(r.stopRequested).toBe(true);
    expect(r.status).toBe('stopped');
  });
});

describe('api', () => {
  const schema = [
    {
      path: '/nodes',
      text: 'nodes',
      info: { GET: { description: 'Cluster node index.', parameters: { properties: {} } } },
      children: [
        {
          path: '/nodes/{node}',
          text: '{node}',
          info: { GET: { description: 'Node index.' } },
          children: [
            {
              path: '/nodes/{node}/qemu',
              text: 'qemu',
              info: { GET: { description: 'Virtual machine index.' } },
              children: [
                {
                  path: '/nodes/{node}/qemu/{vmid}',
                  text: '{vmid}',
                  info: {
                    GET: { description: 'Directory index' },
                    DELETE: {
                      description: 'Destroy the VM.',
                      permissions: { check: ['perm', '/vms/{vmid}', ['VM.Allocate']] },
                      parameters: {
                        properties: {
                          vmid: { type: 'integer', minimum: 100 },
                          purge: {
                            type: 'boolean',
                            optional: 1,
                            description: 'Remove from jobs.',
                            default: 0,
                          },
                          mode: {
                            type: 'string',
                            optional: 1,
                            enum: ['a', 'b'],
                            default: 'x'.repeat(200),
                          },
                        },
                      },
                    },
                  },
                  children: [
                    {
                      path: '/nodes/{node}/qemu/{vmid}/config',
                      text: 'config',
                      info: {
                        GET: { description: 'Get config.' },
                        PUT: { description: 'Set config.' },
                      },
                      children: [],
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    },
    { path: '/version', text: 'version', info: { GET: { description: 'Version.' } }, children: [] },
  ];

  it('describeApiPath matches concrete values to placeholders', () => {
    const r = describeApiPath(schema, '/nodes/pve1/qemu/100/config') as any;
    expect(r.path).toBe('/nodes/{node}/qemu/{vmid}/config');
    expect(Object.keys(r.methods)).toEqual(['GET', 'PUT']);
  });

  it('describes parameters compactly and filters by method', () => {
    const r = describeApiPath(schema, '/nodes/pve1/qemu/100', 'delete') as any;
    expect(Object.keys(r.methods)).toEqual(['DELETE']);
    expect(r.children).toEqual(['/nodes/{node}/qemu/{vmid}/config']);
    const del = r.methods.DELETE;
    expect(del.permissions.check[0]).toBe('perm');
    const byName = Object.fromEntries(del.parameters.map((p: any) => [p.name, p]));
    expect(byName.vmid).toMatchObject({ type: 'integer', optional: false, minimum: 100 });
    expect(byName.purge).toMatchObject({ optional: true, default: '0' });
    expect(byName.mode.enum).toEqual(['a', 'b']);
    expect(byName.mode.default.length).toBeLessThanOrEqual(80);
  });

  it('lists top level paths for / and reports unknown paths with hints', () => {
    expect((describeApiPath(schema, '/') as any).children).toEqual(['/nodes', '/version']);
    expect(() => describeApiPath(schema, '/nodes/pve1/nothing')).toThrow(
      /Deepest match is \/nodes\/\{node\}.*\/nodes\/\{node\}\/qemu/,
    );
    expect(() => describeApiPath(schema, '/bogus')).toThrow(/No API path matches/);
    expect(() => describeApiPath(schema, '/version', 'POST')).toThrow(/no POST method.*GET/);
  });

  it('pve_api_describe uses the client schema and validates the path', async () => {
    const client = fakeClient();
    client.schema = schema;
    const def = tool(apiTools, 'pve_api_describe');
    const r = (await run(def, { path: '/version' }, fakeContext(client))) as any;
    expect(r.path).toBe('/version');
    await expect(run(def, { path: '/nodes/../x' }, fakeContext(client))).rejects.toThrow();
  });

  it('pve_api_get validates the path and passes params', async () => {
    const client = fakeClient({ 'GET /nodes/pve1/status': { ok: 1 } });
    const def = tool(apiTools, 'pve_api_get');
    expect(
      await run(def, { path: '/nodes/pve1/status', params: { a: 1 } }, fakeContext(client)),
    ).toEqual({
      ok: 1,
    });
    expect(client.calls[0]?.params).toEqual({ a: 1 });
    await expect(
      run(def, { path: '/nodes/pve1/status?x=1' }, fakeContext(client)),
    ).rejects.toThrow();
    await expect(run(def, { path: 'nodes' }, fakeContext(client))).rejects.toThrow();
    expect(client.calls).toHaveLength(1);
  });

  it('pve_api_request flags DELETE for confirmation only', async () => {
    const def = tool(apiTools, 'pve_api_request');
    const args = (method: string) => ({ method, path: '/pools/x' }) as never;
    expect(def.needsConfirmation?.(args('DELETE'))).toBe(true);
    expect(def.needsConfirmation?.(args('POST'))).toBe(false);
    expect(def.confirmTarget?.(args('DELETE'), fakeContext(fakeClient()))).toBe(
      'DELETE "/pools/x"',
    );
  });

  it('pve_api_request sends the method and waits for returned tasks', async () => {
    const client = fakeClient({
      'POST /nodes/pve1/qemu/100/status/start': UPID,
      [`GET ${UPID_PATH}/status`]: { status: 'stopped', exitstatus: 'OK' },
      [`GET ${UPID_PATH}/log`]: [],
      'PUT /pools/x': null,
    });
    const def = tool(apiTools, 'pve_api_request');
    const r = (await run(
      def,
      { method: 'POST', path: '/nodes/pve1/qemu/100/status/start' },
      fakeContext(client),
    )) as any;
    expect(r.ok).toBe(true);
    const noWait = (await run(
      def,
      { method: 'POST', path: '/nodes/pve1/qemu/100/status/start', wait: false },
      fakeContext(client),
    )) as any;
    expect(noWait.upid).toBe(UPID);
    expect(
      await run(
        def,
        { method: 'PUT', path: '/pools/x', params: { comment: 'c' } },
        fakeContext(client),
      ),
    ).toBeNull();
    expect(() => run(def, { method: 'GET', path: '/x' }, fakeContext(client))).toThrow();
  });
});
