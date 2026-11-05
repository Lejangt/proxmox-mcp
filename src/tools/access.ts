import { z } from 'zod';
import { pvePath } from '../proxmox/path.js';
import { defineTool, type AnyToolDef } from '../server/registry.js';
import { isoTime } from './resolve-node.js';

type Row = Record<string, unknown>;

/** `name@realm` for users and `name@realm!tokenname` for API tokens. */
const userIdSchema = z
  .string()
  .regex(/^[^\s@!:/]{1,64}@[A-Za-z0-9._-]{1,32}$/, 'expected the format name@realm')
  .describe('Full user id in the format name@realm, for example "admin@pve"');

const KINDS = ['users', 'groups', 'roles', 'acl', 'realms', 'tokens'] as const;

/** Fields kept per kind unless `full` is requested. */
const BRIEF: Record<(typeof KINDS)[number], readonly string[]> = {
  users: [
    'userid',
    'enable',
    'expire',
    'comment',
    'email',
    'firstname',
    'lastname',
    'groups',
    'realm-type',
    'tokens',
  ],
  groups: ['groupid', 'comment', 'users'],
  roles: ['roleid', 'privs', 'special'],
  acl: ['path', 'type', 'ugid', 'roleid', 'propagate'],
  realms: ['realm', 'type', 'comment', 'default', 'tfa'],
  tokens: ['tokenid', 'comment', 'expire', 'privsep'],
};

/**
 * Keys that could carry secret material. Proxmox returns a token secret only
 * when the token is created, never on GET, and passwords and TFA keys are not
 * returned either. They are dropped here as a second line of defence.
 */
const SECRET_KEYS = new Set(['value', 'secret', 'password', 'keys', 'totp', 'tokenSecret']);

function clean(row: Row, fields: readonly string[] | undefined): Row {
  const out: Row = {};
  for (const [key, value] of Object.entries(row)) {
    if (SECRET_KEYS.has(key) || value === undefined || value === null) continue;
    if (fields && !fields.includes(key)) continue;
    out[key] = value;
  }
  if (typeof out.expire === 'number') {
    // 0 means "never expires", an ISO date is easier to read than epoch seconds.
    out.expire = out.expire === 0 ? 'never' : (isoTime(out.expire) ?? out.expire);
  }
  if (Array.isArray(out.tokens)) {
    out.tokens = (out.tokens as Row[]).map((t) => clean(t, BRIEF.tokens));
  }
  return out;
}

const accessList = defineTool({
  name: 'pve_access_list',
  category: 'access',
  title: 'List access objects',
  description:
    'Read the access configuration: kind users, groups, roles (with privileges), acl (path, user or ' +
    'group or token, role, propagate), realms (authentication domains) or tokens. kind tokens needs ' +
    'userid and lists the API tokens of that user (id, comment, expiry, privilege separation), never ' +
    'their secrets. Read only, there is no tool that changes users, roles or ACLs. ' +
    'full: true returns every field Proxmox reports. Needs the matching audit permissions.',
  access: 'read',
  input: {
    kind: z.enum(KINDS).describe('Entry type to read: users, groups, roles, acl, realms or tokens'),
    userid: userIdSchema.optional().describe('Required for kind tokens'),
    full: z.boolean().optional().describe('Return all fields instead of the compact set'),
  },
  handler: async (args, ctx) => {
    let path: string;
    switch (args.kind) {
      case 'users':
        path = '/access/users';
        break;
      case 'groups':
        path = '/access/groups';
        break;
      case 'roles':
        path = '/access/roles';
        break;
      case 'acl':
        path = '/access/acl';
        break;
      case 'realms':
        path = '/access/domains';
        break;
      case 'tokens':
        if (!args.userid) throw new Error('userid is required for kind tokens.');
        path = pvePath`/access/users/${args.userid}/token`;
        break;
    }
    const rows = (await ctx.client.get<Row[]>(path)) ?? [];
    const list = Array.isArray(rows) ? rows : [];
    const fields = args.full ? undefined : BRIEF[args.kind];
    return { kind: args.kind, count: list.length, items: list.map((r) => clean(r, fields)) };
  },
});

const accessPermissions = defineTool({
  name: 'pve_access_permissions',
  category: 'access',
  title: 'Effective permissions',
  description:
    'Effective permissions as privileges per path. Without userid these are the permissions of the ' +
    'API token this server uses, which tells what the tools can do. With userid (a user or a full ' +
    'token id such as admin@pve!mcp) the permissions of that identity, which needs Sys.Audit. ' +
    'path limits the result to one path, for example /vms/100 or /storage/local. ' +
    'noPropagate lists privileges that are not inherited by sub paths.',
  access: 'read',
  input: {
    path: z
      .string()
      .regex(/^\/[A-Za-z0-9/_.:@!-]{0,200}$/, 'invalid access path')
      .optional()
      .describe('Access control path such as /, /vms/100 or /pool/web'),
    userid: z
      .string()
      .regex(/^[^\s:/]{1,64}@[A-Za-z0-9._-]{1,32}(![A-Za-z0-9._-]{1,64})?$/, 'invalid user id')
      .optional()
      .describe('User id or full token id. Omit for the permissions of this server token'),
  },
  handler: async (args, ctx) => {
    const data =
      (await ctx.client.get<Record<string, Record<string, number>>>('/access/permissions', {
        path: args.path,
        userid: args.userid,
      })) ?? {};
    const paths: Record<string, { privileges: string[]; noPropagate?: string[] }> = {};
    for (const [path, privs] of Object.entries(data)) {
      const names = Object.keys(privs ?? {}).sort();
      const noPropagate = names.filter((n) => privs[n] === 0);
      paths[path] = {
        privileges: names.filter((n) => privs[n] !== 0),
        ...(noPropagate.length > 0 ? { noPropagate } : {}),
      };
    }
    return { userid: args.userid ?? 'current token', paths };
  },
});

export const accessTools: AnyToolDef[] = [accessList, accessPermissions];
