import { randomBytes } from 'node:crypto';
import { chmod, mkdir, open, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { Document, isMap, isScalar, parseDocument, Scalar, YAMLMap } from 'yaml';
import type { Pair } from 'yaml';
import { ConfigError } from '../proxmox/errors.js';
import { CATEGORIES } from '../server/registry.js';
import {
  accessLetter,
  type CatalogEntry,
  formatIssues,
  hostSchema,
  type HostSettingsInput,
} from './schema.js';
import type { HostSettings, Settings } from './types.js';

/** Where editors with the YAML language server find the JSON Schema of the settings file. */
export const SETTINGS_SCHEMA_URL =
  'https://raw.githubusercontent.com/Lejangt/proxmox-mcp/main/config.schema.json';

const TO_STRING = { lineWidth: 0, indent: 2 } as const;

/**
 * Writes the settings file atomically (temp file in the same directory,
 * fsync, rename) with mode 0600. Missing parent directories are created with
 * mode 0700. Existing directories are left alone because the path may be
 * user chosen (for example a shared directory with its own permissions).
 */
export async function writeSettingsFile(filePath: string, text: string): Promise<void> {
  const dir = path.dirname(filePath);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const tmp = path.join(dir, `.${path.basename(filePath)}.${randomBytes(6).toString('hex')}.tmp`);
  const handle = await open(tmp, 'wx', 0o600);
  try {
    try {
      await handle.writeFile(text, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    if (process.platform !== 'win32') await chmod(tmp, 0o600);
    await rename(tmp, filePath);
  } catch (err) {
    await rm(tmp, { force: true });
    throw err;
  }
}

/** Sets a key with node key and value so comments can be attached to both. */
function put(doc: Document, map: YAMLMap, key: string, value: unknown): void {
  map.add(doc.createPair(key, value), true);
}

function findPair(map: YAMLMap, key: string): Pair<unknown, unknown> | undefined {
  return map.items.find((item) => {
    const k = item.key;
    return (isScalar(k) ? k.value : k) === key;
  }) as Pair<unknown, unknown> | undefined;
}

function keyNode(pair: Pair<unknown, unknown> | undefined): Scalar | undefined {
  return pair && isScalar(pair.key) ? pair.key : undefined;
}

function valueNode(pair: Pair<unknown, unknown> | undefined): Scalar | undefined {
  return pair && isScalar(pair.value) ? pair.value : undefined;
}

function commentBefore(map: YAMLMap, key: string, comment: string, spaceBefore = true): void {
  const node = keyNode(findPair(map, key));
  if (!node) return;
  node.commentBefore = comment
    .split('\n')
    .map((line) => (line ? ` ${line}` : ''))
    .join('\n');
  if (spaceBefore) node.spaceBefore = true;
}

function inlineComment(map: YAMLMap, key: string, comment: string): void {
  const node = valueNode(findPair(map, key));
  if (node) node.comment = ` ${comment}`;
}

function toolComment(tool: CatalogEntry): string {
  return `[${accessLetter(tool.access)}] ${tool.title}`;
}

function categoryComment(id: string): string {
  const info = CATEGORIES.find((c) => c.id === id);
  return info ? `${info.title}: ${info.description}` : id;
}

function hostToPlain(host: HostSettings): Record<string, unknown> {
  const tls: Record<string, unknown> = { verify: host.tls.verify };
  if (host.tls.caFile !== undefined) tls.caFile = host.tls.caFile;
  if (host.tls.fingerprint !== undefined) tls.fingerprint = host.tls.fingerprint;
  const out: Record<string, unknown> = {};
  if (host.description !== undefined) out.description = host.description;
  out.url = host.url;
  out.tokenId = host.tokenId;
  out.tokenSecret = JSON.parse(JSON.stringify(host.tokenSecret)) as unknown;
  out.tls = tls;
  out.readOnly = host.readOnly;
  out.timeoutSeconds = host.timeoutSeconds;
  return out;
}

function commentHost(hostMap: YAMLMap): void {
  inlineComment(hostMap, 'tokenId', 'API token id, user@realm!tokenname');
  commentBefore(
    hostMap,
    'tokenSecret',
    'Where the token secret lives. Never put the secret itself here.',
    false,
  );
  inlineComment(hostMap, 'readOnly', 'true: this host refuses every non-GET request');
  inlineComment(hostMap, 'timeoutSeconds', 'per request');
  const tls = findPair(hostMap, 'tls')?.value;
  if (isMap(tls)) {
    inlineComment(tls, 'verify', 'false disables TLS checks entirely, avoid it');
  }
}

/** Builds the categories map for every known category and tool. */
function buildCategories(
  doc: Document,
  settings: Pick<Settings, 'categories'>,
  catalog: readonly CatalogEntry[],
): YAMLMap {
  const categories = new YAMLMap();
  let first = true;
  for (const category of CATEGORIES) {
    const current = settings.categories[category.id];
    const tools = new YAMLMap();
    const known = catalog.filter((t) => t.category === category.id);
    for (const tool of known) {
      put(doc, tools, tool.name, current?.tools[tool.name] ?? true);
      inlineComment(tools, tool.name, toolComment(tool));
    }
    // Keep entries the catalog does not know so nothing a user wrote is lost.
    for (const [name, value] of Object.entries(current?.tools ?? {})) {
      if (!known.some((t) => t.name === name)) put(doc, tools, name, value);
    }
    const entry = new YAMLMap();
    put(doc, entry, 'enabled', current?.enabled ?? true);
    put(doc, entry, 'tools', tools.items.length > 0 ? tools : doc.createNode({}));
    put(doc, categories, category.id, entry);
    commentBefore(categories, category.id, categoryComment(category.id), !first);
    first = false;
  }
  return categories;
}

/**
 * Renders a complete, commented settings file. `catalog` lists every tool so
 * the file shows all categories and tools with their access level.
 */
export function renderSettingsDocument(
  settings: Settings,
  catalog: readonly CatalogEntry[],
): string {
  const doc = new Document({});
  const root = doc.contents as YAMLMap;
  doc.commentBefore =
    ` yaml-language-server: $schema=${SETTINGS_SCHEMA_URL}\n` +
    ' Settings for proxmox-ve-mcp. Unknown keys are an error.\n' +
    ' Environment variables can only tighten these settings:\n' +
    ' PROXMOX_MCP_READ_ONLY=1 and PROXMOX_MCP_DISABLE=category,tool_name.';

  put(doc, root, 'version', 1);
  put(doc, root, 'readOnly', settings.readOnly);
  put(doc, root, 'confirmDestructive', settings.confirmDestructive);
  commentBefore(root, 'readOnly', 'Global safety switches.');
  inlineComment(root, 'readOnly', 'true: only read tools exist, every non-GET request is refused');
  inlineComment(
    root,
    'confirmDestructive',
    'auto: ask through the MCP client when it can | always: refuse when it cannot ask | never',
  );

  if (settings.defaultHost !== undefined) {
    put(doc, root, 'defaultHost', settings.defaultHost);
    commentBefore(root, 'defaultHost', 'Host used when a tool call names no host.');
  }

  const hosts = new YAMLMap();
  for (const [alias, host] of Object.entries(settings.hosts)) {
    const node = doc.createNode(hostToPlain(host)) as YAMLMap;
    commentHost(node);
    put(doc, hosts, alias, node);
  }
  put(doc, root, 'hosts', hosts.items.length > 0 ? hosts : doc.createNode({}));
  commentBefore(
    root,
    'hosts',
    'Proxmox targets. The alias (key) is what tools accept as `host`.\n' +
      'tls: system CAs by default, caFile adds a CA, fingerprint pins the SHA-256 of the server certificate.',
  );

  const limits = doc.createNode(settings.limits) as YAMLMap;
  inlineComment(limits, 'maxOutputChars', 'longer tool output is truncated with a note');
  inlineComment(limits, 'taskWaitSeconds', 'upper bound for waiting on a Proxmox task');
  put(doc, root, 'limits', limits);
  commentBefore(root, 'limits', 'Output and waiting limits.');

  put(doc, root, 'categories', buildCategories(doc, settings, catalog));
  commentBefore(
    root,
    'categories',
    'Tool switches. A tool is active when its category is enabled and the tool is not false.\n' +
      'Access: [R] read, [W] write, [D] destructive (data loss or loss of access).',
  );

  return doc.toString(TO_STRING);
}

function parseExisting(text: string): Document.Parsed {
  const doc = parseDocument(text, { uniqueKeys: true, merge: false });
  if (doc.errors.length > 0) {
    throw new ConfigError(
      `settings file is not valid YAML: ${doc.errors[0]!.message.split('\n')[0]}`,
    );
  }
  if (!isMap(doc.contents)) {
    throw new ConfigError('settings file must contain a mapping at the top level');
  }
  return doc;
}

function ensureBlockMap(doc: Document, parent: YAMLMap, key: string): YAMLMap {
  const pair = findPair(parent, key);
  if (pair && isMap(pair.value)) {
    pair.value.flow = false;
    return pair.value;
  }
  if (pair && pair.value !== null && !(isScalar(pair.value) && pair.value.value === null)) {
    throw new ConfigError(`"${key}" must be a mapping`);
  }
  const map = doc.createNode({}) as YAMLMap;
  map.flow = false;
  if (pair) pair.value = map;
  else put(doc, parent, key, map);
  return map;
}

export interface SyncResult {
  text: string;
  /** Added entries as `category` or `category.tool`. */
  added: string[];
}

/**
 * Adds categories and tools from `catalog` that the file does not list yet.
 * Existing values, order and comments stay untouched. New tools are added as
 * `true`, which is what a missing tool means anyway (it follows its category).
 */
export function syncSettingsDocument(
  existingYamlText: string,
  catalog: readonly CatalogEntry[],
): SyncResult {
  const doc = parseExisting(existingYamlText);
  const root = doc.contents as YAMLMap;
  const added: string[] = [];
  const hadCategories = findPair(root, 'categories') !== undefined;
  const categories = ensureBlockMap(doc, root, 'categories');
  if (!hadCategories) {
    commentBefore(root, 'categories', 'Tool switches. [R] read, [W] write, [D] destructive.');
  }
  for (const category of CATEGORIES) {
    let entry = findPair(categories, category.id)?.value;
    if (!isMap(entry)) {
      if (entry !== undefined && entry !== null && !(isScalar(entry) && entry.value === null)) {
        throw new ConfigError(`categories.${category.id} must be a mapping`);
      }
      const fresh = doc.createNode({ enabled: true }) as YAMLMap;
      const pair = findPair(categories, category.id);
      if (pair) pair.value = fresh;
      else put(doc, categories, category.id, fresh);
      commentBefore(
        categories,
        category.id,
        categoryComment(category.id),
        categories.items.length > 1,
      );
      added.push(category.id);
      entry = fresh;
    }
    const entryMap = entry as YAMLMap;
    entryMap.flow = false;
    const tools = ensureBlockMap(doc, entryMap, 'tools');
    for (const tool of catalog.filter((t) => t.category === category.id)) {
      if (findPair(tools, tool.name)) continue;
      put(doc, tools, tool.name, true);
      inlineComment(tools, tool.name, toolComment(tool));
      added.push(`${category.id}.${tool.name}`);
    }
  }
  return { text: doc.toString(TO_STRING), added };
}

/*
 * Updates `map` in place so that it holds `value`: scalars are changed in
 * place (keeping their comments), nested maps are merged recursively, keys
 * that are not in `value` are removed.
 */
function mergeInto(doc: Document, map: YAMLMap, value: Record<string, unknown>): void {
  for (const item of [...map.items]) {
    const key = isScalar(item.key) ? item.key.value : item.key;
    if (typeof key !== 'string' || !(key in value)) map.delete(item.key);
  }
  for (const [key, next] of Object.entries(value)) {
    const pair = findPair(map, key);
    const isPlainObject = typeof next === 'object' && next !== null && !Array.isArray(next);
    if (pair && isPlainObject && isMap(pair.value)) {
      mergeInto(doc, pair.value, next as Record<string, unknown>);
    } else if (pair && !isPlainObject && !Array.isArray(next) && isScalar(pair.value)) {
      pair.value.value = next;
    } else if (pair) {
      pair.value = doc.createNode(next);
    } else {
      put(doc, map, key, doc.createNode(next));
    }
  }
}

/**
 * Adds a host or replaces the values of an existing one. The host is
 * validated first. Comments on keys that keep existing stay in place.
 */
export function upsertHostInDocument(
  existingYamlText: string,
  alias: string,
  host: HostSettingsInput,
): string {
  const parsed = hostSchema.safeParse(host);
  if (!parsed.success) {
    throw new ConfigError(`host "${alias}" is invalid:\n${formatIssues(parsed.error)}`);
  }
  const doc = parseExisting(existingYamlText);
  const root = doc.contents as YAMLMap;
  const hosts = ensureBlockMap(doc, root, 'hosts');
  const plain = hostToPlain(parsed.data);
  const existing = findPair(hosts, alias);
  if (existing && isMap(existing.value)) {
    mergeInto(doc, existing.value, plain);
  } else {
    const node = doc.createNode(plain) as YAMLMap;
    commentHost(node);
    put(doc, hosts, alias, node);
  }
  return doc.toString(TO_STRING);
}

/** Removes a host. When it was the default host, defaultHost is removed too. */
export function removeHostFromDocument(existingYamlText: string, alias: string): string {
  const doc = parseExisting(existingYamlText);
  const root = doc.contents as YAMLMap;
  const hosts = findPair(root, 'hosts')?.value;
  if (!isMap(hosts) || !findPair(hosts, alias)) {
    throw new ConfigError(`host "${alias}" is not defined`);
  }
  hosts.delete(alias);
  const defaultHost = valueNode(findPair(root, 'defaultHost'));
  if (defaultHost?.value === alias) root.delete('defaultHost');
  return doc.toString(TO_STRING);
}

/** Sets or (with undefined) removes defaultHost. The alias must exist. */
export function setDefaultHostInDocument(
  existingYamlText: string,
  alias: string | undefined,
): string {
  const doc = parseExisting(existingYamlText);
  const root = doc.contents as YAMLMap;
  if (alias === undefined) {
    root.delete('defaultHost');
    return doc.toString(TO_STRING);
  }
  const hosts = findPair(root, 'hosts')?.value;
  if (!isMap(hosts) || !findPair(hosts, alias)) {
    throw new ConfigError(`host "${alias}" is not defined`);
  }
  const pair = findPair(root, 'defaultHost');
  const node = valueNode(pair);
  if (node) node.value = alias;
  else put(doc, root, 'defaultHost', alias);
  return doc.toString(TO_STRING);
}
