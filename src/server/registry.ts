import type { z } from 'zod';
import type { Settings } from '../config/types.js';
import type { HostRegistry, ProxmoxClient } from '../proxmox/types.js';

/*
 * SDK note for server.ts (@modelcontextprotocol/server 2.4):
 * registerTool(name, config, cb) takes `inputSchema` either as a zod object
 * (preferred, any StandardSchemaWithJSON) with cb(args, ctx), or as a plain
 * ZodRawShape, which is deprecated but still auto-wrapped with z.object().
 * Build `z.object({ ...def.input, host })` in server.ts and pass that object,
 * then call the handler with (args, ctx) after resolving the client.
 */

export type Access = 'read' | 'write' | 'destructive';

export type CategoryId =
  | 'core'
  | 'cluster'
  | 'nodes'
  | 'network'
  | 'guests'
  | 'snapshots'
  | 'storage'
  | 'backup'
  | 'tasks'
  | 'access'
  | 'firewall'
  | 'pools'
  | 'ha'
  | 'api';

export interface CategoryInfo {
  id: CategoryId;
  title: string;
  description: string;
}

export const CATEGORIES: CategoryInfo[] = [
  {
    id: 'core',
    title: 'Core',
    description: 'Configured Proxmox targets and the Proxmox version of a host.',
  },
  {
    id: 'cluster',
    title: 'Cluster',
    description: 'Cluster membership, resources, free VMIDs and the cluster log.',
  },
  {
    id: 'nodes',
    title: 'Nodes',
    description: 'Node status, metrics, services, logs, disks, updates and power control.',
  },
  {
    id: 'network',
    title: 'Network',
    description: 'Node network interfaces with staged changes that are applied explicitly.',
  },
  {
    id: 'guests',
    title: 'Guests',
    description: 'Create, inspect, configure, power, move and delete VMs and containers.',
  },
  {
    id: 'snapshots',
    title: 'Snapshots',
    description: 'List, create, roll back and delete guest snapshots.',
  },
  {
    id: 'storage',
    title: 'Storage',
    description: 'Storage definitions, volumes, ISO images and container templates.',
  },
  {
    id: 'backup',
    title: 'Backup',
    description: 'Backups, restores and scheduled backup jobs.',
  },
  {
    id: 'tasks',
    title: 'Tasks',
    description: 'Inspect, wait for and stop Proxmox tasks.',
  },
  {
    id: 'access',
    title: 'Access',
    description: 'Users, groups, roles, ACLs, realms, API tokens and effective permissions.',
  },
  {
    id: 'firewall',
    title: 'Firewall',
    description: 'Firewall rules and options at cluster, node and guest level.',
  },
  {
    id: 'pools',
    title: 'Pools',
    description: 'Resource pools and their members.',
  },
  {
    id: 'ha',
    title: 'High availability',
    description: 'HA manager status and HA resources.',
  },
  {
    id: 'api',
    title: 'Raw API',
    description: 'Escape hatch for any Proxmox API path without a dedicated tool.',
  },
];

export interface ToolContext {
  /** Already resolved for args.host. */
  client: ProxmoxClient;
  hosts: HostRegistry;
  settings: Settings;
  signal: AbortSignal;
  /** Writes to stderr, never pass secrets. */
  log(message: string): void;
}

export interface ToolDef<Shape extends z.ZodRawShape = z.ZodRawShape> {
  /** snake_case with prefix pve_ */
  name: string;
  category: CategoryId;
  title: string;
  /** Written for an agent: what the tool does, when to use it, notable params. */
  description: string;
  access: Access;
  /** The `host` argument is added by the framework. */
  input: Shape;
  /**
   * True for tools that never talk to Proxmox (pve_hosts_list). The framework
   * then adds no `host` argument, resolves no client (so a broken host or an
   * unreachable secret store cannot break the tool) and passes a `ctx.client`
   * that throws when used.
   */
  local?: boolean;
  /** True for tools that make Proxmox download from an external URL (openWorldHint). */
  openWorld?: boolean;
  /**
   * For tools that are not `destructive` as a whole but are for some
   * arguments (pve_api_request with method DELETE). When this returns true the
   * framework asks for confirmation like for a destructive tool. Declaring it
   * also sets destructiveHint on the tool, because the tool can destroy data.
   * It may be async and read from Proxmox through ctx (for example the current
   * state of the object the call changes), but must not change anything. A
   * lookup that fails, or a missing ctx, should answer true, so doubt leads
   * to a question.
   */
  needsConfirmation?(
    args: z.infer<z.ZodObject<Shape>> & { host?: string },
    ctx?: ToolContext,
  ): boolean | Promise<boolean>;
  /**
   * Concrete description of what the call affects, used in the confirmation
   * message, for example `VMID 100 ("web01", qemu on node pve1)` or
   * `snapshot "pre-upgrade" of VMID 100`. Required for every destructive tool
   * and every tool with needsConfirmation (enforced by a test). It may read
   * from Proxmox through ctx (for example the guest name) but must not change
   * anything, and should fall back to the plain arguments when a lookup
   * fails. Keep it free of secrets.
   */
  confirmTarget?(
    args: z.infer<z.ZodObject<Shape>> & { host?: string },
    ctx: ToolContext,
  ): string | Promise<string>;
  /** Method syntax keeps parameters bivariant so ToolDef<Shape> fits in AnyToolDef. */
  handler(
    args: z.infer<z.ZodObject<Shape>> & { host?: string },
    ctx: ToolContext,
  ): Promise<unknown>;
}

export type AnyToolDef = ToolDef<z.ZodRawShape>;

export function defineTool<Shape extends z.ZodRawShape>(def: ToolDef<Shape>): ToolDef<Shape> {
  return def;
}
