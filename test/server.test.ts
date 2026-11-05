/* eslint-disable @typescript-eslint/no-explicit-any -- tool results and MCP payloads are asserted as loose JSON */
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { Settings } from '../src/config/types.js';
import { defineTool, type AnyToolDef } from '../src/server/registry.js';
import { annotationsFor, createServer, selectTools } from '../src/server/server.js';
import { ConfirmRefusal } from '../src/server/confirm.js';
import { fakeClient } from './helpers/fake-client.js';
import { fakeHosts, fakeSettings } from './helpers/fixtures.js';
import { connect, textOf } from './helpers/mcp-harness.js';

const read = defineTool({
  name: 'pve_thing_get',
  category: 'guests',
  title: 'Get thing',
  description: 'read',
  access: 'read',
  input: { vmid: z.number() },
  handler: async (a, ctx) => ({ vmid: a.vmid, host: ctx.client.alias }),
});
const write = defineTool({
  name: 'pve_thing_set',
  category: 'guests',
  title: 'Set thing',
  description: 'write',
  access: 'write',
  input: {},
  handler: async () => ({ done: true }),
});
const destroy = defineTool({
  name: 'pve_thing_delete',
  category: 'guests',
  title: 'Delete thing',
  description: 'destructive',
  access: 'destructive',
  input: { vmid: z.number() },
  confirmTarget: (a) => `VMID ${a.vmid}`,
  handler: async (a) => ({ deleted: a.vmid }),
});
const coreTool = defineTool({
  name: 'pve_core_ping',
  category: 'core',
  title: 'Ping',
  description: 'core',
  access: 'read',
  input: {},
  handler: async () => 'pong',
});
const storageTool = defineTool({
  name: 'pve_store_list',
  category: 'storage',
  title: 'Storage',
  description: 'storage',
  access: 'read',
  input: {},
  handler: async () => [],
});
const ALL: AnyToolDef[] = [read, write, destroy, coreTool, storageTool];

function names(tools: AnyToolDef[]): string[] {
  return tools.map((t) => t.name).sort();
}

function build(
  settings: Partial<Settings> = {},
  tools: AnyToolDef[] = ALL,
  hostMap: Record<string, ReturnType<typeof fakeClient>> = {
    lab: fakeClient({}, { alias: 'lab' }),
  },
  readOnly: Record<string, boolean> = {},
) {
  const s = fakeSettings(settings);
  const hosts = fakeHosts(hostMap, { readOnly });
  return { server: createServer({ settings: s, hosts, tools, log: () => {} }), hosts, s };
}

describe('selectTools', () => {
  const hosts = fakeHosts({ lab: fakeClient() });

  it('registers everything by default', () => {
    expect(names(selectTools(ALL, fakeSettings(), hosts))).toHaveLength(5);
  });

  it('drops tools of disabled categories but never core', () => {
    const settings = fakeSettings({
      categories: {
        guests: { enabled: false, tools: {} },
        core: { enabled: false, tools: {} },
      },
    });
    expect(names(selectTools(ALL, settings, hosts))).toEqual(['pve_core_ping', 'pve_store_list']);
  });

  it('honors the tool switch, tools missing from the file follow the category', () => {
    const settings = fakeSettings({
      categories: {
        guests: { enabled: true, tools: { pve_thing_delete: false, pve_thing_get: true } },
      },
    });
    expect(names(selectTools(ALL, settings, hosts))).toEqual([
      'pve_core_ping',
      'pve_store_list',
      'pve_thing_get',
      'pve_thing_set',
    ]);
  });

  it('a tool switch can still disable a core tool', () => {
    const settings = fakeSettings({
      categories: { core: { enabled: true, tools: { pve_core_ping: false } } },
    });
    expect(names(selectTools(ALL, settings, hosts))).not.toContain('pve_core_ping');
  });

  it('global readOnly keeps only read tools', () => {
    expect(names(selectTools(ALL, fakeSettings({ readOnly: true }), hosts))).toEqual([
      'pve_core_ping',
      'pve_store_list',
      'pve_thing_get',
    ]);
  });

  it('removes write tools only when every host is read-only', () => {
    const two = { a: fakeClient(), b: fakeClient() };
    const mixed = fakeHosts(two, { readOnly: { a: true } });
    expect(selectTools(ALL, fakeSettings(), mixed)).toHaveLength(5);
    const all = fakeHosts(two, { readOnly: { a: true, b: true } });
    expect(names(selectTools(ALL, fakeSettings(), all))).toEqual([
      'pve_core_ping',
      'pve_store_list',
      'pve_thing_get',
    ]);
  });
});

describe('annotations', () => {
  it('follows the access level', () => {
    expect(annotationsFor(read)).toMatchObject({
      readOnlyHint: true,
      idempotentHint: true,
      openWorldHint: false,
    });
    expect(annotationsFor(write)).toMatchObject({ readOnlyHint: false, destructiveHint: false });
    expect(annotationsFor(destroy)).toMatchObject({ readOnlyHint: false, destructiveHint: true });
  });

  it('openWorld and needsConfirmation are reflected', () => {
    const dl = { ...write, openWorld: true };
    expect(annotationsFor(dl).openWorldHint).toBe(true);
    const api = { ...write, needsConfirmation: () => true };
    expect(annotationsFor(api).destructiveHint).toBe(true);
  });
});

describe('registered server', () => {
  it('lists only active tools with title and host parameter', async () => {
    const { server } = build({ readOnly: true });
    const h = await connect(server);
    const list = (await h.request('tools/list')) as { tools: Array<Record<string, any>> };
    expect(list.tools.map((t) => t.name).sort()).toEqual([
      'pve_core_ping',
      'pve_store_list',
      'pve_thing_get',
    ]);
    const get = list.tools.find((t) => t.name === 'pve_thing_get')!;
    expect(get.annotations.readOnlyHint).toBe(true);
    expect(get.inputSchema.properties.host.description).toContain('default "lab"');
    expect(get.inputSchema.required).toEqual(['vmid']);
  });

  it('uses an enum of aliases with several hosts and routes the call', async () => {
    const { server } = build({}, ALL, {
      lab: fakeClient({}, { alias: 'lab' }),
      office: fakeClient({}, { alias: 'office' }),
    });
    const h = await connect(server);
    const list = (await h.request('tools/list')) as { tools: Array<Record<string, any>> };
    const host = list.tools.find((t) => t.name === 'pve_thing_get')!.inputSchema.properties.host;
    expect(host.enum).toEqual(['lab', 'office']);
    expect(host.description).toContain('default "lab"');

    expect(textOf(await h.callTool('pve_thing_get', { vmid: 1 }))).toContain('"host": "lab"');
    expect(textOf(await h.callTool('pve_thing_get', { vmid: 1, host: 'office' }))).toContain(
      '"host": "office"',
    );
  });

  it('returns handler errors as isError results without a stack', async () => {
    const failing = defineTool({
      name: 'pve_fail',
      category: 'core',
      title: 'Fail',
      description: 'fails',
      access: 'read',
      input: {},
      handler: async () => {
        throw Object.assign(new Error('Parameter verification failed.'), {
          status: 400,
          errors: { vmid: 'bad' },
        });
      },
    });
    const { server } = build({}, [failing]);
    const h = await connect(server);
    const r = await h.callTool('pve_fail');
    expect(r.isError).toBe(true);
    expect(textOf(r)).toContain('vmid: bad');
  });

  it('truncates long results using the configured limit', async () => {
    const big = defineTool({
      name: 'pve_big',
      category: 'core',
      title: 'Big',
      description: 'big',
      access: 'read',
      input: {},
      handler: async () => 'z'.repeat(1000),
    });
    const { server } = build({ limits: { maxOutputChars: 50, taskWaitSeconds: 5 } }, [big]);
    const h = await connect(server);
    expect(textOf(await h.callTool('pve_big'))).toContain('Output truncated');
  });

  it('refuses write tools on a read-only host without running them', async () => {
    let ran = false;
    const w = defineTool({ ...write, handler: async () => ((ran = true), {}) });
    const { server } = build(
      {},
      [w],
      { a: fakeClient({}, { alias: 'a', readOnly: true }), b: fakeClient({}, { alias: 'b' }) },
      { a: true },
    );
    const h = await connect(server);
    const r = await h.callTool('pve_thing_set', { host: 'a' });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toContain('read-only');
    expect(ran).toBe(false);
    expect((await h.callTool('pve_thing_set', { host: 'b' })).isError).toBeUndefined();
  });

  it('local tools get no host argument and need no client', async () => {
    const local = defineTool({
      name: 'pve_local',
      category: 'core',
      title: 'Local',
      description: 'local',
      access: 'read',
      local: true,
      input: {},
      handler: async (_a, ctx) => ({ hosts: ctx.hosts.aliases() }),
    });
    const { server } = build({}, [local]);
    const h = await connect(server);
    const list = (await h.request('tools/list')) as { tools: Array<Record<string, any>> };
    expect(list.tools[0]!.inputSchema.properties.host).toBeUndefined();
    expect(textOf(await h.callTool('pve_local'))).toContain('lab');
  });

  it('reports the server name and instructions', async () => {
    const { server } = build();
    const h = await connect(server);
    const init = (await h.request('initialize', {
      protocolVersion: '2025-11-25',
      capabilities: {},
      clientInfo: { name: 't', version: '1' },
    })) as any;
    expect(init.serverInfo.name).toBe('proxmox-ve-mcp');
    expect(init.instructions).toContain('pve_api_describe');
  });
});

describe('destructive confirmation', () => {
  const elicitation = { elicitation: { form: {} } };

  it('asks through elicitation and runs after acceptance', async () => {
    const { server } = build();
    const h = await connect(server, {
      capabilities: elicitation,
      onRequest: () => ({ action: 'accept', content: { confirm: true } }),
    });
    const r = await h.callTool('pve_thing_delete', { vmid: 100 });
    expect(textOf(r)).toContain('"deleted": 100');
    expect(h.incoming).toHaveLength(1);
    expect(h.incoming[0]!.method).toBe('elicitation/create');
    const message = h.incoming[0]!.params.message as string;
    expect(message).toContain('pve_thing_delete');
    expect(message).toContain('"lab"');
    expect(message).toContain('VMID 100');
  });

  it('does not run when the user declines', async () => {
    let ran = false;
    const d = defineTool({ ...destroy, handler: async () => ((ran = true), {}) });
    const { server } = build({}, [d]);
    const h = await connect(server, {
      capabilities: elicitation,
      onRequest: () => ({ action: 'decline' }),
    });
    const r = await h.callTool('pve_thing_delete', { vmid: 100 });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toContain('not confirmed');
    expect(ran).toBe(false);
  });

  it('always refuses when the client has no elicitation support', async () => {
    let ran = false;
    const d = defineTool({ ...destroy, handler: async () => ((ran = true), {}) });
    const { server } = build({ confirmDestructive: 'always' }, [d]);
    const h = await connect(server, { capabilities: {} });
    const r = await h.callTool('pve_thing_delete', { vmid: 100 });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toContain('cannot ask');
    expect(ran).toBe(false);
    expect(h.incoming).toHaveLength(0);
  });

  it('auto runs without asking when the client has no elicitation support', async () => {
    const { server } = build({ confirmDestructive: 'auto' });
    const h = await connect(server, { capabilities: {} });
    expect(textOf(await h.callTool('pve_thing_delete', { vmid: 7 }))).toContain('"deleted": 7');
    expect(h.incoming).toHaveLength(0);
  });

  it('never runs without asking even when the client could', async () => {
    const { server } = build({ confirmDestructive: 'never' });
    const h = await connect(server, { capabilities: elicitation });
    expect(textOf(await h.callTool('pve_thing_delete', { vmid: 7 }))).toContain('"deleted": 7');
    expect(h.incoming).toHaveLength(0);
  });

  it('needsConfirmation makes a write tool ask only for the flagged arguments', async () => {
    const conditional = defineTool({
      name: 'pve_cond',
      category: 'api',
      title: 'Cond',
      description: 'c',
      access: 'write',
      input: { method: z.enum(['POST', 'DELETE']) },
      needsConfirmation: (a) => a.method === 'DELETE',
      confirmTarget: (a) => `${a.method} /x`,
      handler: async (a) => ({ ran: a.method }),
    });
    const { server } = build({}, [conditional]);
    const h = await connect(server, {
      capabilities: elicitation,
      onRequest: () => ({ action: 'accept', content: { confirm: true } }),
    });
    await h.callTool('pve_cond', { method: 'POST' });
    expect(h.incoming).toHaveLength(0);
    await h.callTool('pve_cond', { method: 'DELETE' });
    expect(h.incoming).toHaveLength(1);
    expect(h.incoming[0]!.params.message).toContain('DELETE /x');
  });

  it('awaits an async needsConfirmation that reads through ctx', async () => {
    let ran = 0;
    const lookup = defineTool({
      name: 'pve_async_cond',
      category: 'api',
      title: 'Async cond',
      description: 'c',
      access: 'write',
      input: { id: z.string() },
      needsConfirmation: async (a, ctx) => {
        const row = await ctx?.client.get<{ risky?: boolean }>(`/things/${a.id}`);
        return row?.risky === true;
      },
      confirmTarget: (a) => `thing ${a.id}`,
      handler: async () => ({ ran: ++ran }),
    });
    const client = fakeClient(
      { 'GET /things/safe': { risky: false }, 'GET /things/armed': { risky: true } } as never,
      { alias: 'lab' },
    );
    const { server } = build({}, [lookup], { lab: client });
    const h = await connect(server, {
      capabilities: elicitation,
      onRequest: () => ({ action: 'decline' }),
    });
    await h.callTool('pve_async_cond', { id: 'safe' });
    expect(h.incoming).toHaveLength(0);
    expect(ran).toBe(1);
    const r = await h.callTool('pve_async_cond', { id: 'armed' });
    expect(h.incoming).toHaveLength(1);
    expect(r.isError).toBe(true);
    expect(ran).toBe(1);
  });

  it('shows every character outside printable ASCII escaped in the question', async () => {
    const tricky = defineTool({
      ...destroy,
      confirmTarget: () => 'a\u2028b\u202ec\u0085d\u2066e\u200ff\u00e9',
    });
    const { server } = build({}, [tricky]);
    const h = await connect(server, {
      capabilities: elicitation,
      onRequest: () => ({ action: 'decline' }),
    });
    await h.callTool('pve_thing_delete', { vmid: 1 });
    const message = String(h.incoming[0]!.params.message);
    expect(message).toMatch(/^[\x20-\x7e]*$/);
    expect(message).toContain('a\\u2028b\\u202ec\\u0085d\\u2066e\\u200ff\\u00e9');
  });

  it('refuses instead of asking when the question would be too long, nothing is cut', async () => {
    let ran = false;
    const long = defineTool({
      ...destroy,
      confirmTarget: () => `${'x'.repeat(4000)} PAYLOAD ${'y'.repeat(2000)}`,
      handler: async () => ((ran = true), {}),
    });
    const { server } = build({}, [long]);
    const h = await connect(server, {
      capabilities: elicitation,
      onRequest: () => ({ action: 'accept', content: { confirm: true } }),
    });
    const r = await h.callTool('pve_thing_delete', { vmid: 1 });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toContain('nothing is cut');
    expect(h.incoming).toHaveLength(0);
    expect(ran).toBe(false);
  });

  it('a ConfirmRefusal from confirmTarget refuses the call without asking', async () => {
    let ran = false;
    const refusing = defineTool({
      ...destroy,
      confirmTarget: () => {
        throw new ConfirmRefusal('changed meanwhile');
      },
      handler: async () => ((ran = true), {}),
    });
    const { server } = build({}, [refusing]);
    const h = await connect(server, { capabilities: elicitation });
    const r = await h.callTool('pve_thing_delete', { vmid: 1 });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toBe('changed meanwhile');
    expect(h.incoming).toHaveLength(0);
    expect(ran).toBe(false);
  });

  it('shows the full arguments when confirmTarget fails, a payload in the middle stays visible', async () => {
    const failing = defineTool({
      name: 'pve_thing_delete',
      category: 'guests',
      title: 'Delete thing',
      description: 'destructive',
      access: 'destructive',
      handler: async () => ({}),
      input: { vmid: z.number(), note: z.string() },
      confirmTarget: () => {
        throw new Error('lookup failed');
      },
    });
    const { server } = build({}, [failing]);
    const h = await connect(server, {
      capabilities: elicitation,
      onRequest: () => ({ action: 'decline' }),
    });
    const note = `${'a'.repeat(400)} PAYLOAD ${'b'.repeat(400)}`;
    await h.callTool('pve_thing_delete', { vmid: 1, note });
    const message = String(h.incoming[0]!.params.message);
    expect(message).toContain(note);
    expect(message).not.toMatch(/omitted/);
  });

  it('binds the confirmation to the prepared arguments and runs prepare again for the answer', async () => {
    let version = 1;
    const seen: unknown[] = [];
    const pinned = defineTool({
      ...destroy,
      input: { vmid: z.number(), digest: z.string().optional() },
      prepare: async (a) => (a.digest === undefined ? { ...a, digest: `v${version}` } : a),
      handler: async (a) => (seen.push(a.digest), {}),
    });
    const accept = () => ({ action: 'accept', content: { confirm: true } });
    const h = await connect(build({}, [pinned]).server, {
      capabilities: elicitation,
      onRequest: accept,
    });
    expect((await h.callTool('pve_thing_delete', { vmid: 1 })).isError).toBeUndefined();
    expect(seen).toEqual(['v1']);
    const raced = await connect(build({}, [pinned]).server, {
      capabilities: elicitation,
      onRequest: () => ((version = 2), accept()),
    });
    const r = await raced.callTool('pve_thing_delete', { vmid: 1 });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toContain('different call');
    expect(seen).toEqual(['v1']);
  });
});
