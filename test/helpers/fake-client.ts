import type { HttpMethod, Params, ProxmoxClient } from '../../src/proxmox/types.js';

export interface RecordedCall {
  method: HttpMethod;
  path: string;
  params?: Params;
}

export type Responder =
  | string
  | number
  | boolean
  | null
  | readonly unknown[]
  | ((call: RecordedCall) => unknown)
  | EnvelopeResponse
  | { [key: string]: unknown };

const ENVELOPE = Symbol('fake envelope');

interface EnvelopeResponse {
  [ENVELOPE]: true;
  data: unknown;
  meta: Record<string, unknown>;
}

/**
 * A response with top level fields next to data, for example
 * envelope(rows, { total: 620 }). get() returns only the data, getEnvelope()
 * both, like the real client.
 */
export function envelope(data: unknown, meta: Record<string, unknown>): EnvelopeResponse {
  return { [ENVELOPE]: true, data, meta };
}

function isEnvelope(value: unknown): value is EnvelopeResponse {
  return typeof value === 'object' && value !== null && ENVELOPE in value;
}

export interface FakeClient extends ProxmoxClient {
  calls: RecordedCall[];
  /** Register a response for "METHOD /path". Functions are called with the request, errors thrown from them reject. */
  on(route: string, response: Responder): FakeClient;
  schema: unknown[];
}

/** A ProxmoxClient that records every call and answers from a route table. */
export function fakeClient(
  routes: Record<string, Responder> = {},
  opts: { alias?: string; readOnly?: boolean } = {},
): FakeClient {
  const table = new Map<string, Responder>(Object.entries(routes));
  const calls: RecordedCall[] = [];

  const respond = async (method: HttpMethod, path: string, params?: Params): Promise<unknown> => {
    const call: RecordedCall = { method, path, ...(params ? { params } : {}) };
    calls.push(call);
    const key = `${method} ${path}`;
    if (!table.has(key)) throw new Error(`fake client: no route for ${key}`);
    const r = table.get(key);
    return typeof r === 'function' ? (r as (c: RecordedCall) => unknown)(call) : r;
  };
  const request = async <T>(method: HttpMethod, path: string, params?: Params): Promise<T> => {
    const value = await respond(method, path, params);
    return (isEnvelope(value) ? value.data : value) as T;
  };

  const client: FakeClient = {
    alias: opts.alias ?? 'test',
    readOnly: opts.readOnly ?? false,
    calls,
    schema: [],
    request,
    get: (path, params) => request('GET', path, params),
    getEnvelope: async <T>(path: string, params?: Params) => {
      const value = await respond('GET', path, params);
      return isEnvelope(value)
        ? { data: value.data as T, meta: value.meta }
        : { data: value as T, meta: {} };
    },
    post: (path, params) => request('POST', path, params),
    put: (path, params) => request('PUT', path, params),
    delete: (path, params) => request('DELETE', path, params),
    apiSchema: async () => client.schema,
    on(route, response) {
      table.set(route, response);
      return client;
    },
  };
  return client;
}
