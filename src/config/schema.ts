import { z } from 'zod';
import type { Access, CategoryId } from '../server/registry.js';
import { CATEGORIES } from '../server/registry.js';
import type { SecretRef } from '../secrets/types.js';
import type { HostSettings, Settings } from './types.js';

/*
 * Every object schema is strict: an unknown key is an error, because a typo
 * such as `readonly: true` must never silently leave a safety switch off.
 */

/** Minimal tool description used by config rendering and validation. */
export interface CatalogEntry {
  name: string;
  category: CategoryId;
  access: Access;
  title: string;
}

export const HOST_ALIAS_PATTERN = /^[a-z0-9][a-z0-9_-]{0,31}$/;
export const TOOL_NAME_PATTERN = /^pve_[a-z0-9_]{1,62}$/;
/*
 * Proxmox token ids are `user@realm!tokenname`. The user part is limited to a
 * conservative ASCII set. '=' is excluded everywhere because the auth header
 * is `PVEAPIToken=<tokenId>=<secret>`.
 */
export const TOKEN_ID_PATTERN =
  /^[A-Za-z0-9._+~-]{1,64}@[A-Za-z][A-Za-z0-9._-]{0,31}![A-Za-z][A-Za-z0-9._-]{0,63}$/;
const UUID_PATTERN =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

export const CATEGORY_IDS = CATEGORIES.map((c) => c.id) as [CategoryId, ...CategoryId[]];
const CATEGORY_ID_SET = new Set<string>(CATEGORY_IDS);

/** Normalizes a SHA-256 fingerprint to upper case hex pairs joined by ':'. */
export function normalizeFingerprint(value: string): string | undefined {
  const hex = value.trim().replace(/:/g, '');
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) return undefined;
  return hex.toUpperCase().match(/.{2}/g)!.join(':');
}

const safeString = (what: string, max = 1024) =>
  z
    .string()
    .min(1, `${what} must not be empty`)
    .max(max)
    .refine((v) => !CONTROL_CHARS.test(v), `${what} must not contain control characters`);

/** A CLI argument that is placed as a positional value must not look like an option. */
const positionalArg = (what: string) =>
  safeString(what).refine((v) => !v.startsWith('-'), `${what} must not start with "-"`);

const binarySchema = safeString('binary', 4096).describe(
  'Executable name (looked up in PATH) or absolute path of the CLI.',
);

function isLoopback(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]';
}

const httpsUrl = (what: string, allowLoopbackHttp = false) =>
  z.string().refine((value) => {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      return false;
    }
    if (url.username || url.password) return false;
    if (url.protocol === 'https:') return true;
    return allowLoopbackHttp && url.protocol === 'http:' && isLoopback(url.hostname);
  }, `${what} must be an https:// URL without credentials`);

const envRef = z.strictObject({
  source: z.literal('env'),
  name: z.string().regex(ENV_NAME_PATTERN, 'name must be an environment variable name'),
});
const fileRef = z.strictObject({
  source: z.literal('file'),
  path: safeString('path', 4096),
});
const keyringRef = z.strictObject({
  source: z.literal('keyring'),
  service: safeString('service', 256).optional(),
  account: safeString('account', 256).optional(),
});
/* A nested keyring ref has no host alias to default to, so account is required. */
const nestedKeyringRef = keyringRef.extend({ account: safeString('account', 256) });
const onePasswordRef = z.strictObject({
  source: z.literal('1password'),
  ref: safeString('ref', 2048).refine(
    (v) => v.startsWith('op://') && !/\s/.test(v),
    'ref must be a secret reference like op://vault/item/field',
  ),
  account: safeString('account', 256).optional(),
  binary: binarySchema.optional(),
});
const passRef = z.strictObject({
  source: z.literal('pass'),
  name: positionalArg('name').refine(
    (v) => !v.split('/').some((p) => p === '..' || p === '.'),
    'name must not contain "." or ".." segments',
  ),
  binary: binarySchema.optional(),
});
const commandRef = z.strictObject({
  source: z.literal('command'),
  command: z
    .array(
      z
        .string()
        .max(4096)
        .refine((v) => !v.includes('\u0000'), 'no NUL characters'),
    )
    .min(1, 'command must name the executable')
    .max(64)
    .refine((argv) => (argv[0] ?? '').length > 0, 'command[0] must not be empty'),
  timeoutSeconds: z.number().int().min(1).max(300).optional(),
});

/* Refs that may appear inside bws.accessToken and vault.token: no bws, no vault, no recursion. */
const nestedSecretRefSchema = z.discriminatedUnion('source', [
  envRef,
  fileRef,
  nestedKeyringRef,
  onePasswordRef,
  passRef,
  commandRef,
]);

const bwsRef = z.strictObject({
  source: z.literal('bws'),
  secretId: z.string().regex(UUID_PATTERN, 'secretId must be a UUID'),
  accessToken: nestedSecretRefSchema.optional(),
  serverUrl: httpsUrl('serverUrl').optional(),
  binary: binarySchema.optional(),
});
const vaultRef = z.strictObject({
  source: z.literal('vault'),
  path: positionalArg('path'),
  field: safeString('field', 256),
  mount: safeString('mount', 256).optional(),
  address: httpsUrl('address', true).optional(),
  token: nestedSecretRefSchema.optional(),
  namespace: safeString('namespace', 256).optional(),
  binary: binarySchema.optional(),
});

export const secretRefSchema = z.discriminatedUnion('source', [
  envRef,
  fileRef,
  keyringRef,
  bwsRef,
  onePasswordRef,
  vaultRef,
  passRef,
  commandRef,
]);

export const tlsSchema = z
  .strictObject({
    verify: z.boolean().default(true),
    caFile: safeString('caFile', 4096).optional(),
    fingerprint: z
      .string()
      .transform((value, ctx) => {
        const normalized = normalizeFingerprint(value);
        if (!normalized) {
          ctx.addIssue({
            code: 'custom',
            message: 'fingerprint must be a SHA-256 fingerprint (64 hex digits, colons optional)',
          });
          return z.NEVER;
        }
        return normalized;
      })
      .optional(),
  })
  .superRefine((tls, ctx) => {
    if (!tls.verify && (tls.caFile !== undefined || tls.fingerprint !== undefined)) {
      ctx.addIssue({
        code: 'custom',
        message: 'verify: false cannot be combined with caFile or fingerprint, choose one',
        path: ['verify'],
      });
    }
  });

export const hostSchema = z.strictObject({
  description: safeString('description', 500).optional(),
  url: httpsUrl('url').transform((value, ctx) => {
    const url = new URL(value);
    if ((url.pathname !== '/' && url.pathname !== '') || url.search || url.hash) {
      ctx.addIssue({
        code: 'custom',
        message:
          'url must not contain a path, query or fragment (example: https://pve.example.com:8006)',
      });
      return z.NEVER;
    }
    return url.origin;
  }),
  tokenId: z
    .string()
    .regex(
      TOKEN_ID_PATTERN,
      'tokenId must look like user@realm!tokenname (example: mcp@pve!agent)',
    ),
  tokenSecret: secretRefSchema,
  tls: tlsSchema.prefault({}),
  readOnly: z.boolean().default(false),
  timeoutSeconds: z.number().int().min(1).max(3600).default(30),
});

const categoryKey = z.string().refine((key) => CATEGORY_ID_SET.has(key), {
  message: `unknown category, known categories: ${CATEGORY_IDS.join(', ')}`,
});

export const categorySchema = z.strictObject({
  enabled: z.boolean().default(true),
  tools: z
    .record(z.string().regex(TOOL_NAME_PATTERN, 'tool names look like pve_something'), z.boolean())
    .default({}),
});

export const settingsSchema = z
  .strictObject({
    version: z.literal(1),
    readOnly: z.boolean().default(false),
    confirmDestructive: z.enum(['auto', 'always', 'never']).default('auto'),
    defaultHost: z.string().regex(HOST_ALIAS_PATTERN).optional(),
    hosts: z
      .record(
        z
          .string()
          .regex(
            HOST_ALIAS_PATTERN,
            'host aliases use lower case letters, digits, "_" and "-" (max 32, first a letter or digit)',
          ),
        hostSchema,
      )
      .default({}),
    limits: z
      .strictObject({
        maxOutputChars: z.number().int().min(1000).max(10_000_000).default(60000),
        taskWaitSeconds: z.number().int().min(0).max(86_400).default(600),
      })
      .prefault({}),
    categories: z.record(categoryKey, categorySchema).default({}),
  })
  .superRefine((settings, ctx) => {
    if (settings.defaultHost !== undefined && !(settings.defaultHost in settings.hosts)) {
      ctx.addIssue({
        code: 'custom',
        path: ['defaultHost'],
        message: `defaultHost "${settings.defaultHost}" is not defined under hosts (known: ${
          Object.keys(settings.hosts).join(', ') || 'none'
        })`,
      });
    }
  });

export type SettingsInput = z.input<typeof settingsSchema>;
export type HostSettingsInput = z.input<typeof hostSchema>;

/*
 * Compile time check that the schema output fits the hand written contract
 * types. If one of these lines fails, schema and src/config/types.ts drifted.
 */
type Extends<A, B> = [A] extends [B] ? true : false;
type Assert<T extends true> = T;
export type SchemaMatchesSettings = Assert<Extends<z.output<typeof settingsSchema>, Settings>>;
export type SchemaMatchesHost = Assert<Extends<z.output<typeof hostSchema>, HostSettings>>;
export type SchemaMatchesSecretRef = Assert<Extends<z.output<typeof secretRefSchema>, SecretRef>>;
export type SettingsMatchSchemaKeys = Assert<
  Extends<keyof Settings, keyof z.output<typeof settingsSchema>>
>;

/** Formats zod issues as `path: message` lines without echoing input values. */
export function formatIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const path = issue.path.map(String).join('.');
      return path ? `${path}: ${issue.message}` : issue.message;
    })
    .join('\n');
}

/**
 * JSON Schema of the settings file (input side, so defaults are optional).
 * With a catalog, every category lists its tools so editors can complete
 * and validate tool names.
 */
export function settingsJsonSchema(catalog?: readonly CatalogEntry[]): Record<string, unknown> {
  const schema = z.toJSONSchema(settingsSchema, {
    io: 'input',
    target: 'draft-2020-12',
    unrepresentable: 'any',
  }) as Record<string, unknown>;
  schema.title = 'proxmox-ve-mcp settings';
  const properties = schema.properties as Record<string, Record<string, unknown>> | undefined;
  const categories = properties?.categories;
  if (categories) {
    const categoryValue = categories.additionalProperties as Record<string, unknown> | undefined;
    const categoryProps: Record<string, unknown> = {};
    for (const category of CATEGORIES) {
      const value = structuredClone(categoryValue ?? {}) as Record<string, unknown>;
      value.description = `${category.title}: ${category.description}`;
      const tools = catalog?.filter((t) => t.category === category.id) ?? [];
      if (tools.length > 0) {
        const valueProps = value.properties as Record<string, Record<string, unknown>> | undefined;
        if (valueProps?.tools) {
          valueProps.tools = {
            type: 'object',
            properties: Object.fromEntries(
              tools.map((t) => [
                t.name,
                { type: 'boolean', description: `[${accessLetter(t.access)}] ${t.title}` },
              ]),
            ),
            additionalProperties: false,
          };
        }
      }
      categoryProps[category.id] = value;
    }
    categories.properties = categoryProps;
    categories.additionalProperties = false;
    delete categories.propertyNames;
  }
  return schema;
}

export function accessLetter(access: Access): 'R' | 'W' | 'D' {
  return access === 'read' ? 'R' : access === 'write' ? 'W' : 'D';
}
