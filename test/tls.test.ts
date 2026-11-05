import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildTlsPolicy, probeCertificate } from '../src/proxmox/tls.js';
import { TlsError } from '../src/proxmox/errors.js';
import { createTestPki, type TestPki } from './helpers/certs.js';
import { json, startServer, type TestServer } from './helpers/server.js';
import { chmodSync, copyFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

let pki: TestPki;
let server: TestServer;

beforeAll(async () => {
  pki = createTestPki();
  server = await startServer(pki.selfSigned, (_req, res) => json(res, 200, { data: null }));
});
afterAll(async () => {
  await server.close();
  pki.cleanup();
});

describe('probeCertificate', () => {
  it('reports the certificate without sending a request', async () => {
    const result = await probeCertificate(server.url);
    expect(result.fingerprint256).toBe(pki.selfSigned.fingerprint256);
    expect(result.subject).toContain('CN=pve.example');
    expect(result.subjectAltNames).toEqual(['DNS:pve.example']);
    expect(result.selfSigned).toBe(true);
    expect(result.trustedBySystem).toBe(false);
    expect(result.trustError).toBeTruthy();
    expect(new Date(result.validTo).getTime()).toBeGreaterThan(Date.now());
    expect(server.requests).toHaveLength(0);
  });

  it('rejects non-https URLs', async () => {
    await expect(probeCertificate('http://192.0.2.1')).rejects.toBeInstanceOf(TlsError);
  });
});

describe('buildTlsPolicy', () => {
  it('reports the insecure mode with a warning', async () => {
    const policy = await buildTlsPolicy('lab', { verify: false });
    expect(policy.mode).toBe('insecure');
    expect(policy.warning).toMatch(/disabled/);
  });

  it('rejects a caFile without certificates', async () => {
    const file = path.join(pki.dir, 'empty.pem');
    writeFileSync(file, 'nothing here', { mode: 0o600 });
    await expect(buildTlsPolicy('lab', { verify: true, caFile: file })).rejects.toBeInstanceOf(
      TlsError,
    );
    await expect(
      buildTlsPolicy('lab', { verify: true, caFile: path.join(pki.dir, 'missing.pem') }),
    ).rejects.toThrow(/cannot read/);
  });

  it.skipIf(process.platform === 'win32')(
    'rejects a caFile that group or others can write',
    async () => {
      for (const mode of [0o664, 0o646, 0o666]) {
        const file = path.join(pki.dir, `writable-${mode.toString(8)}.pem`);
        copyFileSync(pki.caFile, file);
        chmodSync(file, mode);
        await expect(buildTlsPolicy('lab', { verify: true, caFile: file })).rejects.toThrow(
          /writable by group or others .*chmod go-w/,
        );
      }
      const ok = path.join(pki.dir, 'readable.pem');
      copyFileSync(pki.caFile, ok);
      chmodSync(ok, 0o644);
      await expect(buildTlsPolicy('lab', { verify: true, caFile: ok })).resolves.toMatchObject({
        mode: 'ca',
      });
    },
  );

  it('normalizes the pinned fingerprint', async () => {
    const lower = pki.selfSigned.fingerprint256.replace(/:/g, '').toLowerCase();
    const policy = await buildTlsPolicy('lab', { verify: true, fingerprint: lower });
    expect(policy.mode).toBe('pin');
    expect(policy.fingerprint).toBe(pki.selfSigned.fingerprint256);
  });
});
