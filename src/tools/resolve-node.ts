import type { ProxmoxClient } from '../proxmox/types.js';

interface NodeRow {
  node?: string;
}

/** One row of GET /cluster/resources?type=storage (one per storage and node). */
export interface StorageResource {
  id?: string;
  storage?: string;
  node?: string;
  status?: string;
  shared?: number | boolean;
  content?: string;
  plugintype?: string;
  disk?: number;
  maxdisk?: number;
}

/** The given node, or the only node of the host. Fails with the node names when ambiguous. */
export async function defaultNode(client: ProxmoxClient, node?: string): Promise<string> {
  if (node) return node;
  const rows = (await client.get<NodeRow[]>('/nodes')) ?? [];
  const names = rows.map((r) => r.node).filter((n): n is string => typeof n === 'string');
  const only = names[0];
  if (names.length === 1 && only) return only;
  if (names.length === 0) throw new Error('The host reports no nodes.');
  throw new Error(`The host has several nodes (${names.join(', ')}). Pass node explicitly.`);
}

export async function storageResources(client: ProxmoxClient): Promise<StorageResource[]> {
  return (await client.get<StorageResource[]>('/cluster/resources', { type: 'storage' })) ?? [];
}

/**
 * The given node, or the only node on which the storage is present. Offline
 * nodes are ignored when at least one node is available.
 */
export async function storageNode(
  client: ProxmoxClient,
  storage: string,
  node?: string,
): Promise<string> {
  if (node) return node;
  const rows = (await storageResources(client)).filter((r) => r.storage === storage);
  const available = rows.filter((r) => r.status === 'available');
  const usable = available.length > 0 ? available : rows;
  const names = usable.map((r) => r.node).filter((n): n is string => typeof n === 'string');
  const only = names[0];
  if (names.length === 0) throw new Error(`Storage ${storage} was not found on any node.`);
  if (names.length === 1 && only) return only;
  throw new Error(
    `Storage ${storage} is present on several nodes (${names.join(', ')}). Pass node explicitly.`,
  );
}

/** Epoch seconds to an ISO 8601 string, undefined when the input is not a number. */
export function isoTime(seconds: unknown): string | undefined {
  return typeof seconds === 'number' && Number.isFinite(seconds)
    ? new Date(seconds * 1000).toISOString()
    : undefined;
}

const KEY_PATTERN = /^[A-Za-z][A-Za-z0-9_-]*$/;

/** Option names that a free-form record may not carry, with the reason shown in the error. */
export type ReservedOptions = Readonly<Record<string, string>>;

export interface MergeOptionsConfig {
  transform?: (key: string, value: string | number | boolean) => string | number | boolean;
  /**
   * Keys that are refused even when no typed field sets them, for example
   * the path parameters of the call or options that bypass a safety rule.
   */
  reserved?: ReservedOptions;
}

/**
 * Copies free-form option keys into a parameter object. Keys must look like
 * Proxmox option names, may not be reserved and may not collide with a typed
 * parameter, so a typo or an attempt to override a typed field fails loudly
 * instead of silently.
 */
export function mergeOptions(
  target: Record<string, string | number | boolean | undefined>,
  options: Record<string, string | number | boolean> | undefined,
  label: string,
  config: MergeOptionsConfig = {},
): void {
  for (const key of Object.keys(options ?? {})) checkOptionKey(key, label, config.reserved);
  for (const [key, value] of Object.entries(options ?? {})) {
    if (target[key] !== undefined) {
      throw new Error(`${label}: option "${key}" is already set through a typed field.`);
    }
    target[key] = config.transform ? config.transform(key, value) : value;
  }
}

/** Throws when `key` is not a plain option name or is reserved. */
export function checkOptionKey(key: string, label: string, reserved?: ReservedOptions): void {
  if (!KEY_PATTERN.test(key)) {
    throw new Error(`${label}: invalid option name "${key}".`);
  }
  if (reserved && Object.prototype.hasOwnProperty.call(reserved, key)) {
    throw new Error(`${label}: option "${key}" is not allowed here. ${reserved[key]}`);
  }
}

/** C0 controls, DEL and C1 controls. */
// eslint-disable-next-line no-control-regex -- matching control characters is the point
const CONTROL_CHAR = /[\u0000-\u001f\u007f-\u009f]/;

/**
 * Splits a list argument such as `delete` the way Proxmox does it
 * (PVE::Tools::split_list: commas, semicolons and whitespace separate
 * entries, empty entries vanish), so a safety check sees the same keys as
 * the server. Entries with control characters are refused: with a NUL in the
 * text split_list splits only at NUL, so `unused0\0` would hide the key
 * `unused0` from a check that splits at commas. JavaScript `\s` covers every
 * character Perl `\s` matches outside the refused controls, so the split here
 * never yields fewer keys than the server sees.
 */
export function splitList(list: readonly string[] | undefined, label: string): string[] {
  const out: string[] = [];
  for (const entry of list ?? []) {
    if (CONTROL_CHAR.test(entry)) {
      throw new Error(`${label}: entries must not contain control characters.`);
    }
    out.push(...entry.split(/[\s,;]+/).filter((key) => key !== ''));
  }
  return out;
}
