import { describe, expect, it } from 'vitest';
import type { ServerContext } from '@modelcontextprotocol/server';
import {
  canonicalJson,
  confirmMessage,
  createConfirmBinder,
  decideConfirmation,
  supportsFormElicitation,
  type ConfirmRequest,
} from '../src/server/confirm.js';

const BINDING = 'binding-of-this-call';

const base: ConfirmRequest = {
  mode: 'auto',
  tool: 'pve_guest_delete',
  host: 'lab',
  target: 'VMID 100',
  capabilities: { elicitation: { form: {} } },
  inputResponses: undefined,
  binding: BINDING,
  echoedState: undefined,
  newState: 'sealed-state',
};

/** An answer to the question that was asked for this very call. */
const answered = (content: unknown, action = 'accept'): ConfirmRequest => ({
  ...base,
  inputResponses: { confirm: { action, content } },
  echoedState: { v: 1, binding: BINDING },
});

describe('supportsFormElicitation', () => {
  it('detects form mode and the bare legacy declaration', () => {
    expect(supportsFormElicitation({ elicitation: { form: {} } })).toBe(true);
    expect(supportsFormElicitation({ elicitation: {} })).toBe(true);
    expect(supportsFormElicitation({ elicitation: { url: {} } })).toBe(false);
    expect(supportsFormElicitation({})).toBe(false);
    expect(supportsFormElicitation(undefined)).toBe(false);
  });
});

describe('decideConfirmation', () => {
  it('never proceeds without asking', () => {
    expect(decideConfirmation({ ...base, mode: 'never' }).kind).toBe('proceed');
  });

  it('auto proceeds when the client cannot ask', () => {
    expect(decideConfirmation({ ...base, capabilities: {} }).kind).toBe('proceed');
  });

  it('always refuses when the client cannot ask', () => {
    const d = decideConfirmation({ ...base, mode: 'always', capabilities: {} });
    expect(d.kind).toBe('refuse');
    expect(d.kind === 'refuse' && d.message).toContain('Nothing was changed');
  });

  it.each(['auto', 'always'] as const)('%s asks when elicitation is supported', (mode) => {
    const d = decideConfirmation({ ...base, mode });
    expect(d.kind).toBe('ask');
    if (d.kind === 'ask') {
      const req = d.result.inputRequests?.confirm as { params: { message: string } };
      expect(req.params.message).toContain('pve_guest_delete');
      expect(req.params.message).toContain('"lab"');
      expect(req.params.message).toContain('VMID 100');
      expect(d.result.requestState).toBe('sealed-state');
    }
  });

  it('proceeds only on an accepted confirm=true', () => {
    expect(decideConfirmation(answered({ confirm: true })).kind).toBe('proceed');
    expect(decideConfirmation(answered({ confirm: false })).kind).toBe('refuse');
    expect(decideConfirmation(answered({ confirm: 'yes' })).kind).toBe('refuse');
  });

  it('refuses on decline and cancel', () => {
    for (const action of ['decline', 'cancel']) {
      const d = decideConfirmation(answered(undefined, action));
      expect(d.kind).toBe('refuse');
    }
  });

  it('ignores an answer that was never asked for and asks instead', () => {
    const d = decideConfirmation({ ...answered({ confirm: true }), echoedState: undefined });
    expect(d.kind).toBe('ask');
  });

  it('refuses an answer given for other arguments', () => {
    for (const echoedState of [
      { v: 1, binding: 'binding-of-another-call' },
      { v: 2, binding: BINDING },
      { binding: BINDING },
      'raw string',
      null,
    ]) {
      const d = decideConfirmation({ ...answered({ confirm: true }), echoedState });
      expect(d.kind).toBe('refuse');
      expect(d.kind === 'refuse' && d.message).toMatch(/different call/);
    }
  });

  it('names the tool without a target', () => {
    expect(confirmMessage({ tool: 't', host: 'h' })).not.toContain('target');
  });
});

describe('confirmation binding', () => {
  const ctx = {} as ServerContext;

  it('canonicalizes key order and drops undefined values', () => {
    expect(canonicalJson({ b: 1, a: { d: undefined, c: [1, undefined] } })).toBe(
      canonicalJson({ a: { c: [1, null] }, b: 1 }),
    );
  });

  it('binds tool, host and arguments, but not the host argument itself', () => {
    const binder = createConfirmBinder();
    const one = binder.binding('pve_guest_delete', 'lab', { vmid: 100, purge: true });
    expect(binder.binding('pve_guest_delete', 'lab', { purge: true, vmid: 100 })).toBe(one);
    expect(binder.binding('pve_guest_delete', 'lab', { vmid: 100, purge: true, host: 'lab' })).toBe(
      one,
    );
    expect(binder.binding('pve_guest_delete', 'lab', { vmid: 101, purge: true })).not.toBe(one);
    expect(binder.binding('pve_guest_delete', 'office', { vmid: 100, purge: true })).not.toBe(one);
    expect(binder.binding('pve_snapshot_delete', 'lab', { vmid: 100, purge: true })).not.toBe(one);
  });

  it('uses a key per binder, so bindings and states of another process do not match', async () => {
    const a = createConfirmBinder();
    const b = createConfirmBinder();
    expect(a.binding('t', 'h', { x: 1 })).not.toBe(b.binding('t', 'h', { x: 1 }));
    const state = await a.mint(a.binding('t', 'h', { x: 1 }));
    await expect(a.verify(state, ctx)).resolves.toEqual({
      v: 1,
      binding: a.binding('t', 'h', { x: 1 }),
    });
    await expect(b.verify(state, ctx)).rejects.toThrow();
  });

  it('rejects a tampered state', async () => {
    const binder = createConfirmBinder();
    const state = await binder.mint('x');
    const [version, body, mac] = state.split('.');
    const forged = Buffer.from(
      JSON.stringify({ p: { v: 1, binding: 'y' }, exp: 9999999999 }),
    ).toString('base64url');
    expect(body).toBeDefined();
    await expect(binder.verify(`${version}.${forged}.${mac}`, ctx)).rejects.toThrow();
  });

  it('accepts the answer for the same call and refuses it for changed arguments', async () => {
    const binder = createConfirmBinder();
    const asked = binder.binding('pve_guest_delete', 'lab', { vmid: 100 });
    const echoed = await binder.verify(await binder.mint(asked), ctx);
    const answer = { confirm: { action: 'accept', content: { confirm: true } } };
    const decide = (args: Record<string, unknown>) =>
      decideConfirmation({
        ...base,
        inputResponses: answer,
        binding: binder.binding('pve_guest_delete', 'lab', args),
        echoedState: echoed,
      }).kind;
    expect(decide({ vmid: 100 })).toBe('proceed');
    expect(decide({ vmid: 101 })).toBe('refuse');
    expect(decide({ vmid: 100, destroyUnreferencedDisks: true })).toBe('refuse');
  });
});
