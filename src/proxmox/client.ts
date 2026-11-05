import https from 'node:https';
import type { IncomingHttpHeaders } from 'node:http';
import type { Duplex } from 'node:stream';
import tls from 'node:tls';
import { promisify } from 'node:util';
import zlib from 'node:zlib';
import type { HostSettings } from '../config/types.js';
import {
  ProxmoxApiError,
  ProxmoxConnectionError,
  ReadOnlyError,
  redactSecrets,
  sanitizeText,
  SecretError,
  TlsError,
} from './errors.js';
import { validateApiPath } from './path.js';
import { buildTlsPolicy, serverName, tlsErrorFromHandshake, type TlsPolicy } from './tls.js';
import type { ApiEnvelope, HttpMethod, Params, ParamValue, ProxmoxClient } from './types.js';

export const API_BASE = '/api2/json';
export const API_SCHEMA_PATH = '/pve-docs/api-viewer/apidoc.js';
export const DEFAULT_MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
export const DEFAULT_MAX_SCHEMA_BYTES = 16 * 1024 * 1024;

const METHODS = new Set<HttpMethod>(['GET', 'POST', 'PUT', 'DELETE']);
const USER_AGENT = 'proxmox-ve-mcp';
/* Proxmox token secrets are UUIDs. Anything outside printable ASCII would also break the header. */
const SECRET_PATTERN = /^[\x21-\x7e]{1,512}$/;

export interface ProxmoxClientOptions {
  /** Global read-only switch. The client is read-only when this or host.readOnly is true. */
  readOnly?: boolean;
  maxResponseBytes?: number;
  maxSchemaBytes?: number;
  /** Overrides host.timeoutSeconds (milliseconds). */
  timeoutMs?: number;
}

/** ProxmoxClient plus lifecycle control of its keep-alive connections. */
export interface ProxmoxHttpClient extends ProxmoxClient {
  /** Closes idle keep-alive connections. */
  close(): void;
}

function encodeValue(key: string, value: Exclude<ParamValue, undefined | null>): string {
  if (typeof value === 'boolean') return value ? '1' : '0';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError(`Parameter "${key}" is not a finite number`);
    return String(value);
  }
  if (typeof value === 'string') return value;
  throw new TypeError(`Parameter "${key}" has an unsupported type`);
}

/**
 * Encodes params as application/x-www-form-urlencoded with %20 for spaces
 * (Proxmox decodes percent escapes, '+' would arrive literally in some
 * places). Booleans become 1 and 0, undefined and null are dropped, arrays
 * become repeated keys.
 *
 * A NUL character is refused in every name and value. No Proxmox parameter
 * carries one legitimately, and PVE::Tools::split_list splits a list only at
 * NUL as soon as one is present, so `unused0\0` would pass a client side
 * check for `unused0` and still delete that key on the server.
 */
export function encodeParams(params: Params | undefined): string {
  if (!params) return '';
  const parts: string[] = [];
  for (const [key, raw] of Object.entries(params)) {
    if (key === '') throw new TypeError('Parameter names must not be empty');
    if (key.includes('\0')) throw new TypeError('Parameter names must not contain NUL');
    const values = Array.isArray(raw) ? raw : [raw];
    for (const value of values) {
      if (value === undefined || value === null) continue;
      const text = encodeValue(key, value);
      if (text.includes('\0')) {
        throw new TypeError(`Parameter "${key}" must not contain NUL characters`);
      }
      parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(text)}`);
    }
  }
  return parts.join('&');
}

/**
 * Keep-alive agent whose connections are handed to the HTTP layer only after
 * the TLS policy accepted the peer. Until then no request byte is written.
 */
class VerifyingAgent extends https.Agent {
  constructor(
    private readonly policy: TlsPolicy,
    private readonly connectTimeoutMs: number,
  ) {
    super({
      keepAlive: true,
      maxSockets: 8,
      maxFreeSockets: 2,
      timeout: connectTimeoutMs,
      // Session resumption could skip presenting the certificate again.
      maxCachedSessions: 0,
      ...policy.connectOptions,
    });
  }

  override createConnection(
    options: https.RequestOptions,
    callback?: (err: Error | null, stream: Duplex) => void,
  ): Duplex | null | undefined {
    const socket = tls.connect({
      ...(options as tls.ConnectionOptions),
      ...this.policy.connectOptions,
    });
    let done = false;
    const fail = (err: Error) => {
      if (done) return;
      done = true;
      socket.destroy();
      callback?.(err, socket);
    };
    // Stays attached: errors after the hand-over are also seen by the HTTP
    // layer, this listener only prevents an unhandled 'error' in between.
    socket.on('error', fail);
    socket.setTimeout(this.connectTimeoutMs, () => {
      if (!done) fail(new ProxmoxConnectionError('TLS handshake timed out'));
    });
    socket.once('secureConnect', () => {
      if (done) return;
      try {
        this.policy.verify(socket);
      } catch (err) {
        fail(err as Error);
        return;
      }
      done = true;
      socket.setTimeout(0);
      callback?.(null, socket);
    });
    return undefined;
  }
}

const gunzip = promisify(zlib.gunzip);
const inflate = promisify(zlib.inflate);
const inflateRaw = promisify(zlib.inflateRaw);

/**
 * Decodes a gzip or deflate body. pveproxy compresses some answers (for
 * example /nodes/{node}/journal) even when the request asks for identity.
 * The decoded size is limited as well (maxOutputLength), so a small
 * compressed body cannot expand into a huge buffer.
 */
export async function decodeBody(
  body: Buffer,
  encoding: string | undefined,
  maxBytes: number,
): Promise<Buffer> {
  const name = (encoding ?? '').trim().toLowerCase();
  if (name === '' || name === 'identity') return body;
  const options = { maxOutputLength: maxBytes };
  try {
    if (name === 'gzip' || name === 'x-gzip') return await gunzip(body, options);
    if (name === 'deflate') {
      // "deflate" is meant to be zlib wrapped, some servers send raw deflate.
      return await inflate(body, options).catch((err: NodeJS.ErrnoException) => {
        if (err.code === 'ERR_BUFFER_TOO_LARGE') throw err;
        return inflateRaw(body, options);
      });
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ERR_BUFFER_TOO_LARGE') {
      throw new ProxmoxConnectionError(`decoded response is larger than ${maxBytes} bytes`);
    }
    throw new ProxmoxConnectionError(`response could not be decoded (${name})`);
  }
  throw new ProxmoxConnectionError(
    `response uses the unsupported content encoding ${JSON.stringify(name.slice(0, 40))}`,
  );
}

interface RawResponse {
  status: number;
  statusMessage: string;
  headers: IncomingHttpHeaders;
  body: Buffer;
}

/** Extracts the array after `const apiSchema = ` with JSON.parse, never eval. */
export function extractApiSchema(source: string): unknown[] {
  const marker = /(?:const|let|var)\s+(?:apiSchema|pveapi)\s*=\s*\[/.exec(source);
  if (!marker) throw new Error('apidoc.js does not contain an apiSchema array');
  const start = marker.index + marker[0].length - 1;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < source.length; i++) {
    const ch = source[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '[' || ch === '{') depth++;
    else if (ch === ']' || ch === '}') {
      depth--;
      if (depth === 0) {
        const parsed: unknown = JSON.parse(source.slice(start, i + 1));
        if (!Array.isArray(parsed)) throw new Error('apiSchema is not an array');
        return parsed;
      }
    }
  }
  throw new Error('apiSchema array is not terminated');
}

function hintFor(status: number): string | undefined {
  if (status === 401) {
    return (
      'Authentication failed: check tokenId and the token secret, and that the token is not expired ' +
      'or deleted (Datacenter > Permissions > API Tokens).'
    );
  }
  if (status === 403) {
    return (
      'Permission denied: the API token lacks a privilege on this path. With privilege separation ' +
      'enabled, the token needs its own ACL entry (Datacenter > Permissions > Add > API Token Permission), ' +
      "the user's permissions alone are not enough."
    );
  }
  if (status === 501) {
    return 'Proxmox does not know this path and method. Check the path with pve_api_describe.';
  }
  return undefined;
}

function parseErrorBody(body: Buffer): { message?: string; errors?: Record<string, string> } {
  if (body.length === 0 || body.length > 1024 * 1024) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString('utf8'));
  } catch {
    return {};
  }
  if (!parsed || typeof parsed !== 'object') return {};
  const out: { message?: string; errors?: Record<string, string> } = {};
  const record = parsed as { message?: unknown; errors?: unknown };
  if (typeof record.message === 'string' && record.message.trim()) {
    out.message = record.message.trim();
  }
  if (record.errors && typeof record.errors === 'object' && !Array.isArray(record.errors)) {
    const errors: Record<string, string> = {};
    for (const [key, value] of Object.entries(record.errors as Record<string, unknown>).slice(
      0,
      100,
    )) {
      errors[sanitizeText(key, 100)] = sanitizeText(
        typeof value === 'string' ? value.trim() : JSON.stringify(value),
        500,
      );
    }
    if (Object.keys(errors).length > 0) out.errors = errors;
  }
  return out;
}

export function createProxmoxClient(
  alias: string,
  host: HostSettings,
  getSecret: () => Promise<string>,
  options: ProxmoxClientOptions = {},
): ProxmoxHttpClient {
  const base = new URL(host.url);
  if (base.protocol !== 'https:') throw new TlsError(`Host "${alias}": url must use https`);
  const hostname = base.hostname.replace(/^\[|\]$/g, '');
  const port = base.port ? Number(base.port) : 443;
  const sni = serverName(base.hostname);
  const readOnly = Boolean(options.readOnly) || host.readOnly;
  const timeoutMs = options.timeoutMs ?? host.timeoutSeconds * 1000;
  const maxResponseBytes = options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
  const maxSchemaBytes = options.maxSchemaBytes ?? DEFAULT_MAX_SCHEMA_BYTES;

  let agentPromise: Promise<VerifyingAgent> | undefined;
  const getAgent = (): Promise<VerifyingAgent> => {
    agentPromise ??= buildTlsPolicy(alias, host.tls).then(
      (policy) => new VerifyingAgent(policy, timeoutMs),
      (err: unknown) => {
        agentPromise = undefined;
        throw err;
      },
    );
    return agentPromise;
  };

  let secretForRedaction: string | undefined;
  const clean = (text: string) =>
    sanitizeText(redactSecrets(text, secretForRedaction ? [secretForRedaction] : []), 500);

  function send(
    method: HttpMethod,
    requestPath: string,
    headers: Record<string, string>,
    body: string | undefined,
    maxBytes: number,
    agent: VerifyingAgent,
    displayPath: string,
  ): Promise<RawResponse> {
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (err: Error | undefined, value?: RawResponse) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (err) reject(err);
        else resolve(value!);
      };
      const req = https.request({
        agent,
        method,
        host: hostname,
        port,
        path: requestPath,
        headers,
        ...(sni !== undefined ? { servername: sni } : {}),
      });
      const timer = setTimeout(() => {
        finish(
          new ProxmoxConnectionError(
            `Host "${alias}": ${method} ${displayPath} timed out after ${Math.round(timeoutMs / 1000)}s`,
          ),
        );
        req.destroy();
      }, timeoutMs);
      req.on('error', (err: NodeJS.ErrnoException) => {
        const tlsError = tlsErrorFromHandshake(alias, err);
        if (tlsError) {
          finish(tlsError);
          return;
        }
        if (err instanceof ProxmoxConnectionError) {
          finish(new ProxmoxConnectionError(`Host "${alias}": ${err.message}`));
          return;
        }
        finish(
          new ProxmoxConnectionError(
            `Host "${alias}": ${method} ${displayPath} failed (${err.code ?? clean(err.message)})`,
          ),
        );
      });
      req.on('response', (res) => {
        const status = res.statusCode ?? 0;
        const declared = Number(res.headers['content-length']);
        if (Number.isFinite(declared) && declared > maxBytes) {
          finish(
            new ProxmoxConnectionError(
              `Host "${alias}": response to ${method} ${displayPath} is larger than ${maxBytes} bytes`,
            ),
          );
          req.destroy();
          return;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        res.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > maxBytes) {
            finish(
              new ProxmoxConnectionError(
                `Host "${alias}": response to ${method} ${displayPath} is larger than ${maxBytes} bytes`,
              ),
            );
            req.destroy();
            return;
          }
          chunks.push(chunk);
        });
        res.on('error', () => {
          finish(
            new ProxmoxConnectionError(
              `Host "${alias}": response to ${method} ${displayPath} was interrupted`,
            ),
          );
        });
        res.on('end', () => {
          const raw = Buffer.concat(chunks);
          decodeBody(raw, res.headers['content-encoding'], maxBytes).then(
            (decoded) =>
              finish(undefined, {
                status,
                statusMessage: res.statusMessage ?? '',
                headers: res.headers,
                body: decoded,
              }),
            (err: Error) =>
              finish(
                new ProxmoxConnectionError(
                  `Host "${alias}": response to ${method} ${displayPath}: ${err.message}`,
                ),
              ),
          );
        });
      });
      if (body !== undefined) req.end(body);
      else req.end();
    });
  }

  function toApiError(method: HttpMethod, path: string, res: RawResponse): ProxmoxApiError {
    const parsed = parseErrorBody(res.body);
    const messages = [res.statusMessage.trim(), parsed.message]
      .filter((m): m is string => Boolean(m))
      .filter((m, i, all) => all.indexOf(m) === i);
    const message = clean(messages.join(': '));
    const errors = parsed.errors
      ? Object.fromEntries(Object.entries(parsed.errors).map(([k, v]) => [k, clean(v)]))
      : undefined;
    const hint =
      res.status >= 300 && res.status < 400
        ? 'Redirects are not followed, check the host url.'
        : hintFor(res.status);
    return new ProxmoxApiError({
      status: res.status,
      method,
      path,
      ...(message ? { proxmoxMessage: message } : {}),
      ...(errors ? { errors } : {}),
      ...(hint ? { hint } : {}),
    });
  }

  async function requestEnvelope<T>(
    method: HttpMethod,
    path: string,
    params?: Params,
  ): Promise<ApiEnvelope<T>> {
    if (!METHODS.has(method))
      throw new TypeError(`Unsupported HTTP method ${String(method).slice(0, 10)}`);
    validateApiPath(path);
    // Checked before secrets are resolved and before any connection is made.
    if (readOnly && method !== 'GET') throw new ReadOnlyError(alias, method, path);
    const encoded = encodeParams(params);

    const secret = await getSecret();
    if (!SECRET_PATTERN.test(secret)) {
      throw new SecretError(
        `Token secret for host "${alias}" contains characters that cannot be sent (expected a UUID)`,
      );
    }
    secretForRedaction = secret;
    const agent = await getAgent();

    const inQuery = method === 'GET' || method === 'DELETE';
    const requestPath = `${API_BASE}${path}${inQuery && encoded ? `?${encoded}` : ''}`;
    const headers: Record<string, string> = {
      Authorization: `PVEAPIToken=${host.tokenId}=${secret}`,
      Accept: 'application/json',
      'Accept-Encoding': 'identity',
      'User-Agent': USER_AGENT,
    };
    let body: string | undefined;
    if (!inQuery) {
      body = encoded;
      headers['Content-Type'] = 'application/x-www-form-urlencoded';
      headers['Content-Length'] = String(Buffer.byteLength(body));
    }

    const res = await send(method, requestPath, headers, body, maxResponseBytes, agent, path);
    if (res.status < 200 || res.status >= 300) throw toApiError(method, path, res);
    let parsed: unknown;
    try {
      parsed = JSON.parse(res.body.toString('utf8'));
    } catch {
      throw new ProxmoxApiError({
        status: res.status,
        method,
        path,
        proxmoxMessage: 'response is not JSON',
      });
    }
    const record =
      parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : {};
    const meta: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(record)) {
      if (key !== 'data') meta[key] = value;
    }
    const data = record.data;
    return { data: (data === undefined ? null : data) as T, meta };
  }

  async function request<T>(method: HttpMethod, path: string, params?: Params): Promise<T> {
    return (await requestEnvelope<T>(method, path, params)).data;
  }

  let schemaPromise: Promise<unknown[]> | undefined;
  async function loadSchema(): Promise<unknown[]> {
    const agent = await getAgent();
    // Static file, no credentials needed, so none are sent.
    const res = await send(
      'GET',
      API_SCHEMA_PATH,
      { Accept: '*/*', 'Accept-Encoding': 'identity', 'User-Agent': USER_AGENT },
      undefined,
      maxSchemaBytes,
      agent,
      API_SCHEMA_PATH,
    );
    if (res.status !== 200) {
      throw new ProxmoxApiError({
        status: res.status,
        method: 'GET',
        path: API_SCHEMA_PATH,
        proxmoxMessage: clean(res.statusMessage),
        hint: 'The API viewer is not available on this host (is the pve-docs package installed?).',
      });
    }
    try {
      return extractApiSchema(res.body.toString('utf8'));
    } catch (err) {
      throw new ProxmoxApiError({
        status: res.status,
        method: 'GET',
        path: API_SCHEMA_PATH,
        proxmoxMessage: `cannot read the API schema: ${(err as Error).message}`,
      });
    }
  }

  return {
    alias,
    readOnly,
    request,
    get: <T>(path: string, params?: Params) => request<T>('GET', path, params),
    getEnvelope: <T>(path: string, params?: Params) => requestEnvelope<T>('GET', path, params),
    post: <T>(path: string, params?: Params) => request<T>('POST', path, params),
    put: <T>(path: string, params?: Params) => request<T>('PUT', path, params),
    delete: <T>(path: string, params?: Params) => request<T>('DELETE', path, params),
    apiSchema() {
      schemaPromise ??= loadSchema().catch((err: unknown) => {
        schemaPromise = undefined;
        throw err;
      });
      return schemaPromise;
    },
    close() {
      void agentPromise?.then(
        (agent) => agent.destroy(),
        () => undefined,
      );
    },
  };
}
