import { deflateRawSync, deflateSync, gzipSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { HostSettings } from '../src/config/types.js';
import { createProxmoxClient, encodeParams, extractApiSchema } from '../src/proxmox/client.js';
import {
  ProxmoxApiError,
  ProxmoxConnectionError,
  ReadOnlyError,
  SecretError,
  TlsError,
} from '../src/proxmox/errors.js';
import { InvalidApiPathError } from '../src/proxmox/path.js';
import { errorMessage } from '../src/server/format.js';
import { createTestPki, type TestPki } from './helpers/certs.js';
import { json, startServer, type TestServer } from './helpers/server.js';

const SECRET = '11111111-2222-3333-4444-555555555555';
const TOKEN_ID = 'mcp@pve!agent';

let pki: TestPki;
let caServer: TestServer;
let selfServer: TestServer;
let wrongNameServer: TestServer;

function handler(
  req: { method: string; url: string; headers: Record<string, unknown>; body: string },
  res: import('node:http').ServerResponse,
) {
  const url = req.url;
  if (url.startsWith('/api2/json/echo')) {
    json(res, 200, {
      data: {
        method: req.method,
        url,
        body: req.body,
        auth: req.headers.authorization,
        type: req.headers['content-type'],
      },
    });
  } else if (url.startsWith('/api2/json/param-error')) {
    json(
      res,
      400,
      { data: null, errors: { vmid: 'value must be at least 100' } },
      'Parameter verification failed.',
    );
  } else if (url.startsWith('/api2/json/forbidden')) {
    json(res, 403, { data: null }, 'Permission check failed (/vms/100, VM.Audit)');
  } else if (url.startsWith('/api2/json/unauthorized')) {
    json(res, 401, { data: null }, 'authentication failure');
  } else if (url.startsWith('/api2/json/server-error')) {
    json(res, 500, { data: null, message: 'VM 100 not running\n' }, 'VM 100 not running');
  } else if (url.startsWith('/api2/json/leaky')) {
    json(res, 500, { data: null, message: `token ${SECRET} rejected` }, 'error');
  } else if (url.startsWith('/api2/json/redirect')) {
    res.writeHead(302, { Location: 'https://192.0.2.10/' });
    res.end();
  } else if (url.startsWith('/api2/json/hang')) {
    // never answers
  } else if (url.startsWith('/api2/json/big')) {
    const body = JSON.stringify({ data: 'x'.repeat(2 * 1024 * 1024) });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(body);
  } else if (url.startsWith('/api2/json/gzip-journal')) {
    // pveproxy compresses this answer even for Accept-Encoding: identity.
    const body = gzipSync(JSON.stringify({ data: ['line 1', 'line 2'] }));
    res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Encoding': 'gzip' });
    res.end(body);
  } else if (url.startsWith('/api2/json/deflate-zlib')) {
    res.writeHead(200, { 'Content-Encoding': 'deflate' });
    res.end(deflateSync(JSON.stringify({ data: 'zlib' })));
  } else if (url.startsWith('/api2/json/deflate-raw')) {
    res.writeHead(200, { 'Content-Encoding': 'deflate' });
    res.end(deflateRawSync(JSON.stringify({ data: 'raw' })));
  } else if (url.startsWith('/api2/json/gzip-bomb')) {
    // About 8 KiB on the wire, 8 MiB once decoded.
    const body = gzipSync(JSON.stringify({ data: 'x'.repeat(8 * 1024 * 1024) }), { level: 9 });
    res.writeHead(200, { 'Content-Encoding': 'gzip' });
    res.end(body);
  } else if (url.startsWith('/api2/json/gzip-broken')) {
    res.writeHead(200, { 'Content-Encoding': 'gzip' });
    res.end(Buffer.from('not gzip at all'));
  } else if (url.startsWith('/api2/json/brotli')) {
    res.writeHead(200, { 'Content-Encoding': 'br' });
    res.end(Buffer.from('xx'));
  } else if (url.startsWith('/api2/json/gzip-error')) {
    const body = gzipSync(
      JSON.stringify({ data: null, errors: { upid: 'unable to parse worker upid' } }),
    );
    res.writeHead(400, 'Parameter verification failed.', { 'Content-Encoding': 'gzip' });
    res.end(body);
  } else if (url.startsWith('/api2/json/envelope')) {
    json(res, 200, { data: [{ iface: 'vmbr0' }], changes: '--- a\n+++ b\n', total: 7 });
  } else if (url.startsWith('/api2/json/notjson')) {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<html></html>');
  } else if (url === '/pve-docs/api-viewer/apidoc.js') {
    res.writeHead(200, { 'Content-Type': 'application/javascript' });
    res.end(
      `const apiSchema = [{"path":"/nodes","text":"nodes ] } [","info":{"GET":{"description":"say \\"hi\\""}}}];\n\nlet method2cmd = {};\nalert('never run');`,
    );
  } else {
    json(res, 200, { data: { ok: true } });
  }
}

function host(
  url: string,
  tls: HostSettings['tls'],
  extra: Partial<HostSettings> = {},
): HostSettings {
  return {
    url,
    tokenId: TOKEN_ID,
    tokenSecret: { source: 'env', name: 'UNUSED' },
    tls,
    readOnly: false,
    timeoutSeconds: 5,
    ...extra,
  };
}

const secret = () => Promise.resolve(SECRET);

beforeAll(async () => {
  pki = createTestPki();
  caServer = await startServer(pki.leaf, handler);
  selfServer = await startServer(pki.selfSigned, handler);
  wrongNameServer = await startServer(pki.wrongName, handler);
});

afterAll(async () => {
  await Promise.all([caServer.close(), selfServer.close(), wrongNameServer.close()]);
  pki.cleanup();
});

describe('encodeParams', () => {
  it('encodes booleans, drops undefined and null, repeats arrays, uses %20', () => {
    expect(
      encodeParams({ a: true, b: false, c: undefined, d: null, e: [1, 'x y', null], f: 'a&b=c+d' }),
    ).toBe('a=1&b=0&e=1&e=x%20y&f=a%26b%3Dc%2Bd');
  });
  it('rejects non-finite numbers', () => {
    expect(() => encodeParams({ a: Number.NaN })).toThrow(TypeError);
  });
  it('rejects NUL in values, array elements and names (split_list splits only at NUL then)', () => {
    expect(() => encodeParams({ delete: 'unused0\u0000' })).toThrow(/NUL/);
    expect(() => encodeParams({ delete: ['cores', 'prune-backups\u0000'] })).toThrow(/NUL/);
    expect(() => encodeParams({ 'delete\u0000': 'x' })).toThrow(/NUL/);
    expect(() => encodeParams({ a: 'x\u0000y' })).toThrow(TypeError);
  });
});

describe('extractApiSchema', () => {
  it('parses the array with JSON.parse and ignores the rest of the script', () => {
    const schema = extractApiSchema('const apiSchema = [{"a":"]"}];\nfoo();');
    expect(schema).toEqual([{ a: ']' }]);
  });
  it('rejects JavaScript that is not JSON', () => {
    expect(() => extractApiSchema('const apiSchema = [function(){}];')).toThrow();
  });
  it('fails without the marker', () => {
    expect(() => extractApiSchema('var x = 1;')).toThrow(/apiSchema/);
  });
});

describe('ProxmoxClient with CA verification', () => {
  it('sends GET params as query and the auth header', async () => {
    const client = createProxmoxClient(
      'lab',
      host(caServer.url, { verify: true, caFile: pki.caFile }),
      secret,
    );
    const data = await client.get<{ url: string; auth: string; method: string }>('/echo', {
      full: true,
      skip: undefined,
      ids: [1, 2],
    });
    expect(data.method).toBe('GET');
    expect(data.url).toBe('/api2/json/echo?full=1&ids=1&ids=2');
    expect(data.auth).toBe(`PVEAPIToken=${TOKEN_ID}=${SECRET}`);
    client.close();
  });

  it('sends POST and PUT params as form body and DELETE as query', async () => {
    const client = createProxmoxClient(
      'lab',
      host(caServer.url, { verify: true, caFile: pki.caFile }),
      secret,
    );
    const post = await client.post<{ url: string; body: string; type: string }>('/echo/x', {
      name: 'a b',
      force: false,
    });
    expect(post.url).toBe('/api2/json/echo/x');
    expect(post.body).toBe('name=a%20b&force=0');
    expect(post.type).toBe('application/x-www-form-urlencoded');
    const put = await client.put<{ body: string; method: string }>('/echo/y', { v: 1 });
    expect(put).toMatchObject({ method: 'PUT', body: 'v=1' });
    const del = await client.delete<{ url: string; body: string }>('/echo/z', { purge: true });
    expect(del).toMatchObject({ url: '/api2/json/echo/z?purge=1', body: '' });
    client.close();
  });

  it('rejects an untrusted certificate without caFile', async () => {
    const before = caServer.requests.length;
    const client = createProxmoxClient('lab', host(caServer.url, { verify: true }), secret);
    await expect(client.get('/echo')).rejects.toBeInstanceOf(TlsError);
    expect(caServer.requests.length).toBe(before);
    client.close();
  });

  it('keeps hostname verification with caFile', async () => {
    const before = wrongNameServer.requests.length;
    const client = createProxmoxClient(
      'lab',
      host(wrongNameServer.url, { verify: true, caFile: pki.caFile }),
      secret,
    );
    await expect(client.get('/echo')).rejects.toBeInstanceOf(TlsError);
    expect(wrongNameServer.requests.length).toBe(before);
    expect(wrongNameServer.bytesReceived).toBe(0);
    client.close();
  });
});

describe('ProxmoxClient with fingerprint pinning', () => {
  it('connects when the pin matches a self-signed certificate', async () => {
    const client = createProxmoxClient(
      'lab',
      host(selfServer.url, { verify: true, fingerprint: pki.selfSigned.fingerprint256 }),
      secret,
    );
    await expect(client.get('/anything')).resolves.toEqual({ ok: true });
    client.close();
  });

  it('sends no byte, and so no auth header, when the pin does not match', async () => {
    const before = {
      requests: selfServer.requests.length,
      bytes: selfServer.bytesReceived,
      conns: selfServer.tcpConnections,
    };
    const client = createProxmoxClient(
      'lab',
      host(selfServer.url, { verify: true, fingerprint: pki.leaf.fingerprint256 }),
      secret,
    );
    const err = await client.get('/echo').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TlsError);
    expect(String((err as Error).message)).toMatch(/fingerprint mismatch/);
    expect(String((err as Error).message)).not.toContain(SECRET);
    // Give the server time to account for any late data.
    await new Promise((r) => setTimeout(r, 50));
    // The TCP connection and handshake happened, but nothing was sent over it.
    expect(selfServer.tcpConnections).toBeGreaterThan(before.conns);
    expect(selfServer.requests.length).toBe(before.requests);
    expect(selfServer.bytesReceived).toBe(before.bytes);
    client.close();
  });

  it('requires CA trust and pin when both are configured', async () => {
    const client = createProxmoxClient(
      'lab',
      host(caServer.url, {
        verify: true,
        caFile: pki.caFile,
        fingerprint: pki.leaf.fingerprint256,
      }),
      secret,
    );
    await expect(client.get('/anything')).resolves.toEqual({ ok: true });
    client.close();
    const wrong = createProxmoxClient(
      'lab',
      host(caServer.url, {
        verify: true,
        caFile: pki.caFile,
        fingerprint: pki.selfSigned.fingerprint256,
      }),
      secret,
    );
    await expect(wrong.get('/anything')).rejects.toBeInstanceOf(TlsError);
    wrong.close();
  });

  it('accepts anything with verify false', async () => {
    const client = createProxmoxClient('lab', host(selfServer.url, { verify: false }), secret);
    await expect(client.get('/anything')).resolves.toEqual({ ok: true });
    client.close();
  });
});

describe('ProxmoxClient behaviour', () => {
  const make = (extra: Partial<HostSettings> = {}, options = {}) =>
    createProxmoxClient(
      'lab',
      host(selfServer.url, { verify: true, fingerprint: pki.selfSigned.fingerprint256 }, extra),
      secret,
      options,
    );

  it('read-only clients refuse non-GET before resolving the secret or connecting', async () => {
    const conns = selfServer.tcpConnections;
    const getSecret = vi.fn(secret);
    const client = createProxmoxClient(
      'lab',
      host(
        selfServer.url,
        { verify: true, fingerprint: pki.selfSigned.fingerprint256 },
        { readOnly: true },
      ),
      getSecret,
    );
    expect(client.readOnly).toBe(true);
    for (const method of ['POST', 'PUT', 'DELETE'] as const) {
      await expect(
        client.request(method, '/nodes/pve/qemu/100/status/stop'),
      ).rejects.toBeInstanceOf(ReadOnlyError);
    }
    expect(getSecret).not.toHaveBeenCalled();
    expect(selfServer.tcpConnections).toBe(conns);
    await expect(client.get('/anything')).resolves.toEqual({ ok: true });
    client.close();
  });

  it('global read-only applies even when the host is writable', async () => {
    const client = make({}, { readOnly: true });
    expect(client.readOnly).toBe(true);
    await expect(client.post('/echo')).rejects.toBeInstanceOf(ReadOnlyError);
    client.close();
  });

  it('validates every path before any traffic', async () => {
    const getSecret = vi.fn(secret);
    const client = createProxmoxClient('lab', host(selfServer.url, { verify: false }), getSecret);
    for (const bad of ['/nodes/../access', '/nodes?x=1', 'nodes', '/a/%2e%2e/b', '/a\\b']) {
      await expect(client.get(bad)).rejects.toBeInstanceOf(InvalidApiPathError);
    }
    expect(getSecret).not.toHaveBeenCalled();
    client.close();
  });

  it('refuses a NUL in any parameter before any traffic', async () => {
    const getSecret = vi.fn(secret);
    const client = createProxmoxClient('lab', host(selfServer.url, { verify: false }), getSecret);
    const conns = selfServer.tcpConnections;
    await expect(
      client.put('/nodes/pve1/qemu/100/config', { delete: 'unused0\u0000' }),
    ).rejects.toThrow(/NUL/);
    await expect(client.put('/storage/bk', { delete: ['prune-backups\u0000'] })).rejects.toThrow(
      /NUL/,
    );
    await expect(client.get('/nodes', { 'x\u0000': 1 })).rejects.toThrow(/NUL/);
    expect(getSecret).not.toHaveBeenCalled();
    expect(selfServer.tcpConnections).toBe(conns);
    client.close();
  });

  it('maps 400 with parameter errors', async () => {
    const client = make();
    const err = (await client
      .post('/param-error', { vmid: 1 })
      .catch((e: unknown) => e)) as ProxmoxApiError;
    expect(err).toBeInstanceOf(ProxmoxApiError);
    expect(err.status).toBe(400);
    expect(err.method).toBe('POST');
    expect(err.path).toBe('/param-error');
    expect(err.proxmoxMessage).toBe('Parameter verification failed.');
    expect(err.errors).toEqual({ vmid: 'value must be at least 100' });
    client.close();
  });

  it('maps 401 and 403 with token hints', async () => {
    const client = make();
    const e403 = (await client
      .get('/forbidden', { a: 1 })
      .catch((e: unknown) => e)) as ProxmoxApiError;
    expect(e403.status).toBe(403);
    expect(e403.path).toBe('/forbidden');
    expect(e403.message).toMatch(/Permission check failed/);
    expect(e403.message).toMatch(/privilege separation/i);
    const e401 = (await client.get('/unauthorized').catch((e: unknown) => e)) as ProxmoxApiError;
    expect(e401.status).toBe(401);
    expect(e401.message).toMatch(/token/);
    client.close();
  });

  it('uses the reason phrase and never leaks the secret', async () => {
    const client = make();
    const e500 = (await client.get('/server-error').catch((e: unknown) => e)) as ProxmoxApiError;
    expect(e500.proxmoxMessage).toBe('VM 100 not running');
    const leak = (await client.get('/leaky').catch((e: unknown) => e)) as ProxmoxApiError;
    expect(leak.message).not.toContain(SECRET);
    expect(leak.message).toContain('[REDACTED]');
    client.close();
  });

  it('does not follow redirects', async () => {
    const client = make();
    const err = (await client.get('/redirect').catch((e: unknown) => e)) as ProxmoxApiError;
    expect(err).toBeInstanceOf(ProxmoxApiError);
    expect(err.status).toBe(302);
    expect(err.message).toMatch(/Redirects are not followed/);
    client.close();
  });

  it('times out', async () => {
    const client = make({}, { timeoutMs: 300 });
    await expect(client.get('/hang')).rejects.toBeInstanceOf(ProxmoxConnectionError);
    client.close();
  });

  it('enforces the response size limit', async () => {
    const client = make({}, { maxResponseBytes: 1024 * 1024 });
    await expect(client.get('/big')).rejects.toThrow(/larger than/);
    client.close();
  });

  it('decodes gzip and deflate answers', async () => {
    const client = make();
    await expect(client.get('/gzip-journal')).resolves.toEqual(['line 1', 'line 2']);
    await expect(client.get('/deflate-zlib')).resolves.toBe('zlib');
    await expect(client.get('/deflate-raw')).resolves.toBe('raw');
    client.close();
  });

  it('limits the decoded size, so a small compressed body cannot expand without bound', async () => {
    const client = make({}, { maxResponseBytes: 1024 * 1024 });
    const err = await client.get('/gzip-bomb').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProxmoxConnectionError);
    expect(String((err as Error).message)).toMatch(/decoded response is larger than 1048576 bytes/);
    client.close();
  });

  it('rejects broken and unsupported encodings', async () => {
    const client = make();
    await expect(client.get('/gzip-broken')).rejects.toThrow(/could not be decoded/);
    await expect(client.get('/brotli')).rejects.toThrow(/unsupported content encoding "br"/);
    client.close();
  });

  it('decodes compressed error bodies and names the parameter errors once', async () => {
    const client = make();
    const err = (await client.get('/gzip-error').catch((e: unknown) => e)) as ProxmoxApiError;
    expect(err).toBeInstanceOf(ProxmoxApiError);
    expect(err.errors).toEqual({ upid: 'unable to parse worker upid' });
    const text = errorMessage(err);
    expect(text.match(/Parameter errors/g)).toHaveLength(1);
    expect(text.match(/unable to parse worker upid/g)).toHaveLength(1);
    client.close();
  });

  it('returns the top level fields next to data through getEnvelope', async () => {
    const client = make();
    await expect(client.getEnvelope('/envelope')).resolves.toEqual({
      data: [{ iface: 'vmbr0' }],
      meta: { changes: '--- a\n+++ b\n', total: 7 },
    });
    await expect(client.get('/envelope')).resolves.toEqual([{ iface: 'vmbr0' }]);
    client.close();
  });

  it('rejects non JSON success bodies', async () => {
    const client = make();
    await expect(client.get('/notjson')).rejects.toThrow(/not JSON/);
    client.close();
  });

  it('refuses secrets that would break the header', async () => {
    const client = createProxmoxClient('lab', host(selfServer.url, { verify: false }), () =>
      Promise.resolve('abc\r\nX-Evil: 1'),
    );
    const err = await client.get('/echo').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SecretError);
    expect(String(err)).not.toContain('X-Evil');
    client.close();
  });

  it('loads and caches the API schema without credentials', async () => {
    const client = make();
    const before = selfServer.requests.length;
    const schema = await client.apiSchema();
    expect(schema).toEqual([
      { path: '/nodes', text: 'nodes ] } [', info: { GET: { description: 'say "hi"' } } },
    ]);
    await client.apiSchema();
    const schemaRequests = selfServer.requests
      .slice(before)
      .filter((r) => r.url.startsWith('/pve-docs'));
    expect(schemaRequests).toHaveLength(1);
    expect(schemaRequests[0]!.headers.authorization).toBeUndefined();
    client.close();
  });

  it('applies the TLS policy to the API schema request as well', async () => {
    const client = createProxmoxClient(
      'lab',
      host(selfServer.url, { verify: true, fingerprint: pki.leaf.fingerprint256 }),
      secret,
    );
    await expect(client.apiSchema()).rejects.toBeInstanceOf(TlsError);
    client.close();
  });
});
