import { describe, expect, it } from 'vitest';
import { isUpid, parseUpid, taskOutcome, waitForTask } from '../src/proxmox/tasks.js';
import { envelope, fakeClient } from './helpers/fake-client.js';
import { fakeContext, fakeSettings } from './helpers/fixtures.js';

const UPID = 'UPID:pve1:000A1B2C:0123ABCD:65F0A1B2:qmstart:100:root@pam:';
const STATUS =
  '/nodes/pve1/tasks/UPID%3Apve1%3A000A1B2C%3A0123ABCD%3A65F0A1B2%3Aqmstart%3A100%3Aroot%40pam%3A';

describe('parseUpid', () => {
  it('parses a valid UPID', () => {
    const info = parseUpid(UPID);
    expect(info).toMatchObject({ node: 'pve1', type: 'qmstart', id: '100', user: 'root@pam' });
    expect(info.pid).toBe(0xa1b2c);
    expect(info.starttime).toBe(0x65f0a1b2);
  });

  it('accepts an empty id and token users', () => {
    const info = parseUpid('UPID:n1:00000001:00000002:00000003:vzdump::root@pam!mcp:');
    expect(info.id).toBeUndefined();
    expect(info.user).toBe('root@pam!mcp');
  });

  it.each([
    '',
    'UPID:pve1',
    'UPID:pve1:zz:0:0:t:i:u:',
    '/nodes/x',
    'UPID:../x:00000001:00000002:00000003:t:i:u:',
  ])('rejects %j', (bad) => {
    expect(() => parseUpid(bad)).toThrow(/Invalid UPID/);
    expect(isUpid(bad)).toBe(false);
  });

  it('isUpid rejects non strings', () => {
    expect(isUpid(42)).toBe(false);
    expect(isUpid(null)).toBe(false);
    expect(isUpid(UPID)).toBe(true);
  });
});

describe('waitForTask', () => {
  it('polls until stopped and attaches log lines', async () => {
    let n = 0;
    const client = fakeClient({
      [`GET ${STATUS}/status`]: () =>
        ++n < 3
          ? { status: 'running', type: 'qmstart', id: '100' }
          : { status: 'stopped', exitstatus: 'OK', type: 'qmstart', id: '100' },
      [`GET ${STATUS}/log`]: [
        { n: 1, t: 'starting' },
        { n: 2, t: 'TASK OK' },
      ],
    });
    const r = await waitForTask(client, UPID, { timeoutSeconds: 5, pollMs: 1 });
    expect(r).toMatchObject({ ok: true, status: 'stopped', exitstatus: 'OK', node: 'pve1' });
    expect(r.log).toEqual(['starting', 'TASK OK']);
    expect(r.timedOut).toBeUndefined();
    expect(client.calls.filter((c) => c.path.endsWith('/status'))).toHaveLength(3);
    expect(r.durationSeconds).toBeTypeOf('number');
  });

  it('leaves out the duration of a task that was already stopped', async () => {
    const client = fakeClient({
      [`GET ${STATUS}/status`]: { status: 'stopped', exitstatus: 'OK', starttime: 1 },
      [`GET ${STATUS}/log`]: [],
    });
    const r = await waitForTask(client, UPID, { timeoutSeconds: 1, pollMs: 1 });
    expect(r.ok).toBe(true);
    expect(r.durationSeconds).toBeUndefined();
  });

  it('reports failure when exitstatus is not OK', async () => {
    const client = fakeClient({
      [`GET ${STATUS}/status`]: { status: 'stopped', exitstatus: 'command failed' },
      [`GET ${STATUS}/log`]: [],
    });
    const r = await waitForTask(client, UPID, { timeoutSeconds: 1, pollMs: 1 });
    expect(r.ok).toBe(false);
    expect(r.exitstatus).toBe('command failed');
    expect(r.log).toBeUndefined();
  });

  it('returns timedOut with a pve_task_wait hint', async () => {
    const client = fakeClient({
      [`GET ${STATUS}/status`]: { status: 'running' },
      [`GET ${STATUS}/log`]: [{ n: 1, t: 'busy' }],
    });
    const r = await waitForTask(client, UPID, { timeoutSeconds: 0.05, pollMs: 10 });
    expect(r).toMatchObject({ ok: false, status: 'running', timedOut: true });
    expect(r.note).toContain('pve_task_wait');
  });

  it('keeps only the last logLines lines across pages', async () => {
    const client = fakeClient({
      [`GET ${STATUS}/status`]: { status: 'stopped', exitstatus: 'OK' },
      [`GET ${STATUS}/log`]: (call) => {
        const start = Number(call.params?.start ?? 0);
        const total = 620;
        const limit = Number(call.params?.limit ?? 50);
        return Array.from({ length: Math.max(0, Math.min(limit, total - start)) }, (_, i) => ({
          n: start + i + 1,
          t: `line ${start + i + 1}`,
        }));
      },
    });
    const r = await waitForTask(client, UPID, { timeoutSeconds: 1, pollMs: 1, logLines: 3 });
    expect(r.log).toEqual(['line 618', 'line 619', 'line 620']);
  });

  it('reads the tail directly when Proxmox reports the total', async () => {
    const total = 5000;
    const client = fakeClient({
      [`GET ${STATUS}/status`]: { status: 'stopped', exitstatus: 'OK' },
      [`GET ${STATUS}/log`]: (call) => {
        const start = Number(call.params?.start ?? 0);
        const limit = Number(call.params?.limit ?? 50);
        const rows = Array.from(
          { length: Math.max(0, Math.min(limit, total - start)) },
          (_, i) => ({
            n: start + i + 1,
            t: `line ${start + i + 1}`,
          }),
        );
        return envelope(rows, { total });
      },
    });
    const r = await waitForTask(client, UPID, { timeoutSeconds: 1, pollMs: 1, logLines: 3 });
    expect(r.log).toEqual(['line 4998', 'line 4999', 'line 5000']);
    const logCalls = client.calls.filter((c) => c.path.endsWith('/log'));
    expect(logCalls.map((c) => c.params)).toEqual([
      { start: 0, limit: 3 },
      { start: 4997, limit: 3 },
    ]);
  });

  it('needs one request for a short log with total', async () => {
    const client = fakeClient({
      [`GET ${STATUS}/status`]: { status: 'stopped', exitstatus: 'OK' },
      [`GET ${STATUS}/log`]: envelope(
        [
          { n: 1, t: 'a' },
          { n: 2, t: 'b' },
        ],
        { total: 2 },
      ),
    });
    const r = await waitForTask(client, UPID, { timeoutSeconds: 1, pollMs: 1, logLines: 20 });
    expect(r.log).toEqual(['a', 'b']);
    expect(client.calls.filter((c) => c.path.endsWith('/log'))).toHaveLength(1);
  });

  it('stops on abort', async () => {
    const ac = new AbortController();
    const client = fakeClient({ [`GET ${STATUS}/status`]: { status: 'running' } });
    setTimeout(() => ac.abort(new Error('cancelled')), 20);
    await expect(
      waitForTask(client, UPID, { timeoutSeconds: 30, pollMs: 5, signal: ac.signal }),
    ).rejects.toThrow('cancelled');
  });

  it('throws for an invalid UPID before any request', async () => {
    const client = fakeClient();
    await expect(waitForTask(client, 'nope', { timeoutSeconds: 1 })).rejects.toThrow(
      /Invalid UPID/,
    );
    expect(client.calls).toHaveLength(0);
  });
});

describe('taskOutcome', () => {
  it('passes non UPID data through', async () => {
    const ctx = fakeContext(fakeClient());
    expect(await taskOutcome(ctx, { a: 1 })).toEqual({ a: 1 });
    expect(await taskOutcome(ctx, 'plain', false)).toBe('plain');
  });

  it('returns upid and note when wait is false', async () => {
    const client = fakeClient();
    const r = (await taskOutcome(fakeContext(client), UPID, false)) as {
      upid: string;
      note: string;
    };
    expect(r.upid).toBe(UPID);
    expect(r.note).toContain('pve_task_wait');
    expect(client.calls).toHaveLength(0);
  });

  it('waits by default using the configured limit', async () => {
    const client = fakeClient({
      [`GET ${STATUS}/status`]: { status: 'stopped', exitstatus: 'OK' },
      [`GET ${STATUS}/log`]: [],
    });
    const ctx = fakeContext(client, { settings: fakeSettings() });
    expect(await taskOutcome(ctx, UPID)).toMatchObject({ ok: true });
  });
});
