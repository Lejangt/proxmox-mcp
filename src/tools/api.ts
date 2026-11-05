import { z } from 'zod';
import { validateApiPath } from '../proxmox/path.js';
import { taskOutcome } from '../proxmox/tasks.js';
import type { Params } from '../proxmox/types.js';
import { defineTool, type AnyToolDef } from '../server/registry.js';
import { jsonText } from './targets.js';

const scalar = z.union([z.string(), z.number(), z.boolean()]);

const pathSchema = z
  .string()
  .min(1)
  .max(512)
  .describe(
    'API path relative to /api2/json, starting with /, for example /nodes/pve1/qemu/100/status/current',
  );

const paramsSchema = z
  .record(z.string(), z.union([scalar, z.array(scalar)]))
  .optional()
  .describe(
    'Query or body parameters as an object. Booleans are sent as 1 and 0, arrays become repeated keys. Use pve_api_describe to see the parameters of a path.',
  );

// ---- schema lookup for pve_api_describe ----

interface ApiNode {
  path?: string;
  text?: string;
  info?: Record<string, ApiMethod | undefined>;
  children?: ApiNode[];
}

interface ApiMethod {
  description?: string;
  method?: string;
  protected?: boolean | number;
  allowtoken?: boolean | number;
  permissions?: unknown;
  parameters?: { properties?: Record<string, ApiParam | undefined> };
  returns?: { type?: string; description?: string };
}

interface ApiParam {
  type?: string;
  optional?: number | boolean;
  description?: string;
  enum?: unknown[];
  default?: unknown;
  format?: unknown;
  minimum?: number;
  maximum?: number;
}

const METHODS = ['GET', 'POST', 'PUT', 'DELETE'];
const MAX_DESCRIPTION = 600;
const MAX_PARAM_DESCRIPTION = 300;
const MAX_DEFAULT = 80;
const MAX_ENUM = 40;

function cut(value: string, max: number): string {
  return value.length > max ? value.slice(0, max - 3) + '...' : value;
}

function isPlaceholder(text: string | undefined): boolean {
  return text !== undefined && text.startsWith('{') && text.endsWith('}');
}

/**
 * Walks the schema tree. A concrete segment matches an exact child first,
 * then a `{placeholder}` child. Returns the deepest node reached and how many
 * segments matched, so the caller can tell a full match from a partial one.
 */
export function findApiNode(
  tree: unknown[],
  path: string,
): { node?: ApiNode; depth: number; total: number; children: string[] } {
  const segments = path.split('/').filter((s) => s !== '');
  let level = tree as ApiNode[];
  let node: ApiNode | undefined;
  let depth = 0;
  for (const segment of segments) {
    const decoded = safeDecode(segment);
    const next = level.find((c) => c.text === decoded) ?? level.find((c) => isPlaceholder(c.text));
    if (!next) break;
    node = next;
    depth++;
    level = next.children ?? [];
  }
  return {
    ...(node ? { node } : {}),
    depth,
    total: segments.length,
    children: level.map((c) => c.path ?? c.text ?? ''),
  };
}

function safeDecode(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

function describeParam(name: string, p: ApiParam): Record<string, unknown> {
  const out: Record<string, unknown> = {
    name,
    type: p.type ?? 'string',
    optional: p.optional === 1 || p.optional === true,
  };
  if (p.description) out.description = cut(p.description, MAX_PARAM_DESCRIPTION);
  if (Array.isArray(p.enum)) {
    out.enum = p.enum.slice(0, MAX_ENUM);
    if (p.enum.length > MAX_ENUM) out.enumTruncated = true;
  }
  if (p.default !== undefined) out.default = cut(String(p.default), MAX_DEFAULT);
  if (typeof p.format === 'string') out.format = cut(p.format, MAX_DEFAULT);
  if (p.minimum !== undefined) out.minimum = p.minimum;
  if (p.maximum !== undefined) out.maximum = p.maximum;
  return out;
}

function describeMethod(m: ApiMethod): Record<string, unknown> {
  const props = m.parameters?.properties ?? {};
  const out: Record<string, unknown> = {};
  if (m.description) out.description = cut(m.description, MAX_DESCRIPTION);
  if (m.permissions !== undefined) out.permissions = m.permissions;
  if (m.allowtoken === 0 || m.allowtoken === false) out.allowToken = false;
  out.parameters = Object.entries(props).map(([name, p]) => describeParam(name, p ?? {}));
  if (m.returns?.type) out.returns = m.returns.type;
  return out;
}

export function describeApiPath(
  tree: unknown[],
  path: string,
  method?: string,
): Record<string, unknown> {
  const normalized = path.replace(/\/+$/, '') || '/';
  const { node, depth, total, children } = findApiNode(tree, normalized);

  if (total === 0) return { path: '/', children };
  if (!node || depth < total) {
    const where = node?.path ?? '/';
    throw new Error(
      `No API path matches ${normalized}. Deepest match is ${where}` +
        (children.length > 0
          ? `, its child paths are: ${children.slice(0, 40).join(', ')}.`
          : ', which has no child paths.'),
    );
  }

  const wantedMethod = method?.toUpperCase();
  const methods: Record<string, unknown> = {};
  for (const name of METHODS) {
    if (wantedMethod && name !== wantedMethod) continue;
    const info = node.info?.[name];
    if (info) methods[name] = describeMethod(info);
  }
  if (wantedMethod && Object.keys(methods).length === 0) {
    const available = METHODS.filter((m) => node.info?.[m]).join(', ') || 'none';
    throw new Error(`${node.path} has no ${wantedMethod} method. Available: ${available}.`);
  }
  return { path: node.path, methods, children };
}

// ---- read-only guard for GET calls that make the node fetch a URL ----

/*
 * A few GET endpoints make the Proxmox node contact an address given as
 * parameter: the ACME directory lookups, the URL metadata query used by the
 * download dialog and the storage scans that connect to a server or portal
 * (nfs, cifs, pbs, iscsi, glusterfs on older releases). With them a read-only
 * token (PVEAuditor is enough for some) could make the node reach arbitrary
 * addresses, including ones only the node can reach. In read-only mode,
 * global or for the host, they are refused. The scan list follows the GET
 * parameters named server, portal or host in the Proxmox VE API schema
 * (pve-docs api-viewer apidoc.js).
 */
const URL_FETCH_GETS: ReadonlyArray<{ path: RegExp; params: readonly string[] }> = [
  { path: /^\/cluster\/acme\/(?:tos|meta|directories)$/, params: ['directory'] },
  { path: /^\/nodes\/[^/]+\/query-url-metadata$/, params: ['url'] },
  { path: /^\/nodes\/[^/]+\/scan\/(?:nfs|cifs|pbs|glusterfs)$/, params: ['server'] },
  { path: /^\/nodes\/[^/]+\/scan\/iscsi$/, params: ['portal'] },
];

/** Decoded, lower case, with repeated and trailing slashes removed, for matching only. */
function normalizeForMatch(path: string): string {
  let current = path;
  for (let round = 0; round < 3; round++) {
    let decoded: string;
    try {
      decoded = decodeURIComponent(current);
    } catch {
      break;
    }
    if (decoded === current) break;
    current = decoded;
  }
  return (
    current
      .toLowerCase()
      .replace(/\/{2,}/g, '/')
      .replace(/\/+$/, '') || '/'
  );
}

/** The reason a read-only GET is refused, or undefined when it is allowed. */
export function urlFetchProblem(path: string, params: Params | undefined): string | undefined {
  const normalized = normalizeForMatch(path);
  const rule = URL_FETCH_GETS.find((r) => r.path.test(normalized));
  if (!rule) return undefined;
  const given = Object.entries(params ?? {})
    .filter(([, value]) => value !== undefined && value !== null)
    .map(([key]) => key.toLowerCase());
  const hit = rule.params.find((p) => given.includes(p));
  if (hit === undefined) return undefined;
  return (
    `GET ${path} with "${hit}" makes the Proxmox node contact an address. This is refused in read-only mode, ` +
    'because it would let a read-only token reach any address the node can reach.'
  );
}

/** Parameter values that look like credentials are hidden in the confirmation question. */
const SECRET_PARAM = /pass|secret|token|key|cred/i;

function paramsForDisplay(params: Record<string, unknown> | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(params ?? {})) {
    out[key] = SECRET_PARAM.test(key) ? '***' : value;
  }
  return out;
}

export const apiTools: AnyToolDef[] = [
  defineTool({
    name: 'pve_api_get',
    category: 'api',
    title: 'Proxmox API GET',
    description:
      'GET any Proxmox API path (relative to /api2/json) for data no dedicated tool covers. ' +
      'Use pve_api_describe first to find the path and its parameters. Returns the "data" part of the response. ' +
      'In read-only mode, GET calls that make the node contact an address (ACME directory lookups with ' +
      'directory, query-url-metadata with url, scan/nfs, cifs, pbs and glusterfs with server, scan/iscsi ' +
      'with portal) are refused.',
    access: 'read',
    input: { path: pathSchema, params: paramsSchema },
    handler: async (args, ctx) => {
      const path = validateApiPath(args.path);
      const params = args.params as Params | undefined;
      if (ctx.settings.readOnly || ctx.client.readOnly) {
        const problem = urlFetchProblem(path, params);
        if (problem) throw new Error(problem);
      }
      return ctx.client.get(path, params);
    },
  }),

  defineTool({
    name: 'pve_api_request',
    category: 'api',
    title: 'Proxmox API write request',
    description:
      'POST, PUT or DELETE any Proxmox API path (relative to /api2/json) for changes no dedicated tool covers. ' +
      'DELETE needs user confirmation. Use pve_api_describe to check the method, parameters and permissions first. ' +
      'If the response is a task id (UPID) the call waits for the task, set wait=false to get the UPID immediately.',
    access: 'write',
    input: {
      method: z.enum(['POST', 'PUT', 'DELETE']).describe('HTTP method'),
      path: pathSchema,
      params: paramsSchema,
      wait: z
        .boolean()
        .optional()
        .describe('Wait for the Proxmox task when the response is a task id, default true'),
    },
    needsConfirmation: (args) => args.method === 'DELETE',
    confirmTarget: (args) =>
      `${args.method} ${jsonText(args.path)}` +
      (args.params && Object.keys(args.params).length > 0
        ? ` with ${jsonText(paramsForDisplay(args.params))}`
        : ''),
    handler: async (args, ctx) => {
      const path = validateApiPath(args.path);
      const data = await ctx.client.request(args.method, path, args.params as Params);
      return taskOutcome(ctx, data, args.wait);
    },
  }),

  defineTool({
    name: 'pve_api_describe',
    category: 'api',
    title: 'Describe Proxmox API path',
    description:
      'Look up the Proxmox API schema for a path: available methods with description, parameters (type, optional, enum, default), permissions and child paths. ' +
      'Concrete values match the schema placeholders, so /nodes/pve1/qemu/100/config finds /nodes/{node}/qemu/{vmid}/config. ' +
      'Pass "/" to list the top level paths. Use it before pve_api_get or pve_api_request.',
    access: 'read',
    input: {
      path: z
        .string()
        .min(1)
        .max(512)
        .describe('API path with concrete values, or "/" for the top level'),
      method: z.enum(['GET', 'POST', 'PUT', 'DELETE']).optional().describe('Only this method'),
    },
    handler: async (args, ctx) => {
      const path = args.path.trim() === '/' ? '/' : validateApiPath(args.path);
      const tree = await ctx.client.apiSchema();
      return describeApiPath(tree, path, args.method);
    },
  }),
];
