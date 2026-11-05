import { describe, expect, it } from 'vitest';
import { InvalidApiPathError, pvePath, validateApiPath, volid } from '../src/proxmox/path.js';

describe('pvePath', () => {
  it('keeps the static parts and accepts numbers', () => {
    expect(pvePath`/nodes/${'pve1'}/qemu/${100}/status/current`).toBe(
      '/nodes/pve1/qemu/100/status/current',
    );
  });

  it('encodes values so they cannot add segments or a query', () => {
    expect(pvePath`/nodes/${'a?x=1#y'}/status`).toBe('/nodes/a%3Fx%3D1%23y/status');
    expect(
      pvePath`/nodes/${'pve1'}/storage/${'local'}/content/${volid('local:iso/debian.iso')}`,
    ).toBe('/nodes/pve1/storage/local/content/local%3Aiso%2Fdebian.iso');
  });

  it('rejects "/" in plain values because pveproxy decodes %2F into a separator', () => {
    expect(() => pvePath`/nodes/${'a/b?x=1#y'}/status`).toThrow(/contains "\/"/);
    expect(() => pvePath`/cluster/backup/${'job/../../access'}`).toThrow(TypeError);
    expect(() => pvePath`/pools/${'parent/child'}`).toThrow(TypeError);
    expect(() => pvePath`/storage/${'local:iso/debian.iso'}`).toThrow(TypeError);
  });

  it('accepts "/" only in values marked with volid', () => {
    expect(pvePath`/x/${volid('pbs:backup/vm/100/2026-01-01T00:00:00Z')}`).toBe(
      '/x/pbs%3Abackup%2Fvm%2F100%2F2026-01-01T00%3A00%3A00Z',
    );
    for (const bad of [
      'no-colon/x',
      ':iso/x',
      'local:',
      'local:iso/../etc',
      'local:iso//x',
      'local:./x',
      'local:iso/x y',
      'local:iso/x\ny',
      'local:iso\\x',
      '1local:iso/x',
    ]) {
      expect(() => volid(bad), bad).toThrow(TypeError);
    }
    // A forged brand from JSON input is not a volume id.
    expect(() => pvePath`/x/${JSON.parse('{"volid":"a:b/c"}') as never}`).toThrow(TypeError);
  });

  it('rejects values that would still traverse after encoding', () => {
    expect(() => pvePath`/nodes/${'..'}/x`).toThrow(TypeError);
    expect(() => pvePath`/nodes/${'.'}/x`).toThrow(TypeError);
    expect(() => pvePath`/nodes/${'a/../b'}/status`).toThrow(TypeError);
    expect(() => pvePath`/nodes/${''}/x`).toThrow(TypeError);
    expect(() => pvePath`/nodes/${'a\nb'}`).toThrow(TypeError);
    expect(() => pvePath`/nodes/${Number.NaN}`).toThrow(TypeError);
    expect(() => pvePath`/nodes/${'\ud800'}`).toThrow(TypeError);
  });

  it('throws on undefined and null', () => {
    expect(() => pvePath`/nodes/${undefined as unknown as string}`).toThrow(TypeError);
    expect(() => pvePath`/nodes/${null as unknown as string}`).toThrow(TypeError);
  });
});

describe('validateApiPath', () => {
  it('accepts normal API paths', () => {
    for (const ok of [
      '/',
      '/version',
      '/nodes/pve1/qemu/100/status/current',
      '/nodes/pve1/storage/local/content/local%3Aiso%2Fdebian.iso',
      '/access/users/root@pam/token/agent',
      '/cluster/ha/resources/vm:100',
      '/nodes/pve1/qemu/100/snapshot/before-update.1',
    ]) {
      expect(validateApiPath(ok)).toBe(ok);
    }
  });

  it('rejects traversal, queries, fragments and odd characters', () => {
    const attacks = [
      '',
      'nodes',
      'https://192.0.2.1/api2/json/nodes',
      '//192.0.2.1/x',
      '/nodes/../access/users',
      '/nodes/./x',
      '/nodes/..',
      '/nodes/%2e%2e/x',
      '/nodes/%2E%2e/x',
      '/nodes/.%2e/x',
      '/nodes/%2e/x',
      '/nodes/%252e%252e/x',
      '/nodes/a%2F..%2Fb',
      '/nodes/a%5C..%5Cb',
      '/nodes?x=1',
      '/nodes#frag',
      '/nodes\\..\\x',
      '/nodes/\u0000',
      '/nodes/%00',
      '/nodes/%0d%0aX-Injected:%201',
      '/nodes/a b',
      `/nodes/${String.fromCharCode(0xe4)}`,
      '/nodes/%zz',
      '/nodes/%e0%a4',
      '/nodes/',
      '/nodes//x',
      `/${'a'.repeat(3000)}`,
    ];
    for (const bad of attacks) {
      expect(() => validateApiPath(bad), bad).toThrow(InvalidApiPathError);
    }
  });

  it('rejects non-strings', () => {
    expect(() => validateApiPath(42 as unknown as string)).toThrow(InvalidApiPathError);
  });
});
