import { z } from 'zod';
import { guestPath, resolveGuest } from '../proxmox/guests.js';
import { pvePath } from '../proxmox/path.js';
import { defineTool, type AnyToolDef, type ToolContext } from '../server/registry.js';
import { guestTypeSchema, nodeSchema, vmidSchema } from './common.js';
import { defaultNode, mergeOptions, splitList } from './resolve-node.js';
import { guestLabel, jsonText, nodeLabel, quote } from './targets.js';

type Row = Record<string, unknown>;
type Scalar = string | number | boolean;

const LEVELS = ['cluster', 'node', 'guest'] as const;

/** Where the firewall config lives. Shared by every firewall tool. */
const scopeInput = {
  level: z
    .enum(LEVELS)
    .describe(
      'Firewall level: cluster (datacenter wide), node (needs node unless the host has one node) or guest (needs vmid)',
    ),
  node: nodeSchema
    .optional()
    .describe('level node: the node. level guest: optional hint, found from the VMID otherwise.'),
  vmid: vmidSchema.optional().describe('Required for level guest'),
  guestType: guestTypeSchema
    .optional()
    .describe('level guest only: qemu or lxc, found from the VMID'),
};

interface ScopeArgs {
  level: (typeof LEVELS)[number];
  node?: string | undefined;
  vmid?: number | undefined;
  guestType?: 'qemu' | 'lxc' | undefined;
}

/**
 * Resolves the scope to the API path of its firewall section, for example
 * `/cluster/firewall` or `/nodes/pve1/qemu/100/firewall`. Arguments that do not
 * belong to the level are an error, so a rule meant for one guest can never
 * land on the cluster because a field was misread.
 */
export async function firewallBase(ctx: ToolContext, args: ScopeArgs): Promise<string> {
  switch (args.level) {
    case 'cluster':
      if (args.node !== undefined || args.vmid !== undefined || args.guestType !== undefined) {
        throw new Error('level cluster takes no node, vmid or guestType.');
      }
      return '/cluster/firewall';
    case 'node': {
      if (args.vmid !== undefined || args.guestType !== undefined) {
        throw new Error(
          'level node takes no vmid or guestType. Use level guest for a VM or container.',
        );
      }
      const node = await defaultNode(ctx.client, args.node);
      return pvePath`/nodes/${node}/firewall`;
    }
    case 'guest': {
      if (args.vmid === undefined) throw new Error('level guest requires vmid.');
      const g = await resolveGuest(ctx.client, args.vmid, {
        ...(args.node ? { node: args.node } : {}),
        ...(args.guestType ? { type: args.guestType } : {}),
      });
      return guestPath(g, '/firewall');
    }
  }
}

function scopeLabel(args: ScopeArgs): string {
  if (args.level === 'guest') return `guest ${args.vmid ?? '?'}`;
  if (args.level === 'node') return `node ${args.node ?? '(only node)'}`;
  return 'cluster';
}

/** The firewall level for the confirmation question, with node or guest resolved. */
async function scopeTarget(ctx: ToolContext, args: ScopeArgs): Promise<string> {
  if (args.level === 'cluster') return 'cluster level (datacenter wide)';
  if (args.level === 'node') return `node level of ${await nodeLabel(ctx, args.node)}`;
  if (args.vmid === undefined) return 'guest level';
  return `guest level of ${await guestLabel(ctx, { vmid: args.vmid, node: args.node, type: args.guestType })}`;
}

const RULE_SUMMARY_FIELDS = [
  'type',
  'action',
  'macro',
  'proto',
  'source',
  'dest',
  'sport',
  'dport',
  'iface',
  'enable',
] as const;

/** `in DROP proto "tcp" dport "22"` from rule fields, values quoted. */
export function ruleSummary(rule: Row): string {
  const parts: string[] = [];
  for (const key of RULE_SUMMARY_FIELDS) {
    const value = rule[key];
    if (value === undefined || value === null || value === '') continue;
    if (key === 'type' || key === 'action') parts.push(quote(String(value), 64));
    else if (key === 'enable') parts.push(value === 0 || value === false ? 'disabled' : 'enabled');
    else parts.push(`${key} ${quote(String(value), 100)}`);
  }
  return parts.join(' ');
}

/** Actions that drop traffic, on cluster or node level they can lock out API and SSH. */
function isBlockingAction(action: string | undefined): boolean {
  const upper = action?.toUpperCase();
  return upper === 'DROP' || upper === 'REJECT';
}

/** Rule fields that decide which traffic a rule matches and what happens to it. */
const FILTER_FIELDS = [
  'type',
  'action',
  'macro',
  'proto',
  'source',
  'dest',
  'sport',
  'dport',
  'iface',
  'icmp-type',
  'enable',
] as const;

/** Proxmox reports enable as 1 or 0. Anything else counts as on, so doubt leads to a question. */
function isOn(value: unknown): boolean {
  return !(value === 0 || value === false || value === '0');
}

function fieldText(key: string, value: unknown): string | undefined {
  if (key === 'enable') return isOn(value) ? '1' : '0';
  if (value === undefined || value === null || value === '') return undefined;
  const text = String(value);
  return key === 'type' || key === 'action' ? text.toUpperCase() : text;
}

/**
 * True when the rule can drop traffic: DROP or REJECT, a security group (its
 * rules are not looked at, a group may hold DROP rules) or an unknown action.
 */
function mayBlock(rule: Row): boolean {
  if (String(rule.type).toLowerCase() === 'group') return true;
  if (typeof rule.action !== 'string' || rule.action === '') return true;
  return isBlockingAction(rule.action);
}

/** True when the rule can let traffic in: ACCEPT or a security group. */
function mayAccept(rule: Row): boolean {
  if (String(rule.type).toLowerCase() === 'group') return true;
  return typeof rule.action === 'string' && rule.action.toUpperCase() === 'ACCEPT';
}

interface RuleUpdateArgs extends ScopeArgs {
  pos: number;
  moveto?: number | undefined;
  delete?: string[] | undefined;
  action?: string | undefined;
  [field: string]: unknown;
}

/**
 * Whether a rule update on cluster or node level can lock out access. The
 * current rule is read, because the arguments alone do not tell: `enable:
 * true` can arm a disabled DROP rule, a new source can widen one, and
 * disabling, moving or editing an ACCEPT rule can remove the access it
 * grants. It asks when the update changes a filtering field (or moves the
 * rule) and the rule is active and may block afterwards, or was an active
 * rule that may accept before. Comment or log changes never ask. When the
 * rule cannot be read it asks.
 */
export async function ruleUpdateNeedsConfirmation(
  args: RuleUpdateArgs,
  ctx: ToolContext | undefined,
): Promise<boolean> {
  if (args.level === 'guest') return false;
  if (isBlockingAction(args.action) || ctx === undefined) return true;
  const deleted = new Set(splitList(args.delete, 'delete'));
  let before: Row;
  try {
    const base = await firewallBase(ctx, args);
    const row = await ctx.client.get<Row>(base + pvePath`/rules/${args.pos}`);
    if (row === null || typeof row !== 'object' || Array.isArray(row)) return true;
    before = row;
  } catch {
    return true;
  }
  const after: Row = { ...before };
  for (const key of deleted) delete after[key];
  for (const key of FILTER_FIELDS) if (args[key] !== undefined) after[key] = args[key];
  const changed =
    args.moveto !== undefined ||
    FILTER_FIELDS.some(
      (key) =>
        deleted.has(key) ||
        (args[key] !== undefined && fieldText(key, args[key]) !== fieldText(key, before[key])),
    );
  if (!changed) return false;
  if (isOn(after.enable) && mayBlock(after)) return true;
  return isOn(before.enable) && mayAccept(before);
}

const POS_HINT =
  'Rule positions start at 0 and shift when a rule is added, moved or deleted, so read the rules ' +
  'right before changing one and pass the digest from that read to detect concurrent edits.';

const posSchema = z.number().int().min(0).max(10000).describe('Rule position, starting at 0');

const digestSchema = z
  .string()
  .regex(/^[A-Fa-f0-9]{40,128}$/, 'digest is a hex string as returned by the read tools')
  .optional()
  .describe('Digest from the last read. Proxmox refuses the change if the config changed since');

const LOG_LEVELS = [
  'emerg',
  'alert',
  'crit',
  'err',
  'warning',
  'notice',
  'info',
  'debug',
  'nolog',
] as const;

const ruleText = (max: number) => z.string().max(max);

/** Rule fields as Proxmox names them, shared by add and update. */
const ruleFields = {
  enable: z.boolean().optional().describe('Whether the rule is active, default true on add'),
  source: ruleText(200)
    .optional()
    .describe('Source address, CIDR, range, alias or +ipset, for example 192.0.2.0/24'),
  dest: ruleText(200).optional().describe('Destination address, same forms as source'),
  proto: ruleText(32).optional().describe('Protocol name or number, for example tcp, udp, icmp'),
  dport: ruleText(100).optional().describe('Destination port, name, number, range or list'),
  sport: ruleText(100).optional().describe('Source port, same forms as dport'),
  iface: ruleText(32).optional().describe('Interface name, for guests the net key such as net0'),
  macro: ruleText(64).optional().describe('Predefined macro such as SSH, HTTPS or Ping'),
  comment: ruleText(256).optional().describe('Free text comment for the rule'),
  log: z.enum(LOG_LEVELS).optional().describe('Log level for this rule'),
  'icmp-type': ruleText(64).optional().describe('Only with proto icmp or icmpv6'),
};

const ruleType = z
  .enum(['in', 'out', 'forward', 'group'])
  .describe('Rule direction: in, out, forward, or group (refers to a security group)');

const ruleAction = z
  .string()
  .regex(/^[A-Za-z][A-Za-z0-9_-]{0,63}$/, 'ACCEPT, DROP, REJECT or a security group name')
  .describe('ACCEPT, DROP, REJECT, or the name of a security group (type group)');

function ruleParams(args: Row): Record<string, Scalar | undefined> {
  const names = [
    'type',
    'action',
    'enable',
    'source',
    'dest',
    'proto',
    'dport',
    'sport',
    'iface',
    'macro',
    'comment',
    'log',
    'icmp-type',
  ];
  const out: Record<string, Scalar | undefined> = {};
  for (const name of names) out[name] = args[name] as Scalar | undefined;
  return out;
}

const firewallRules = defineTool({
  name: 'pve_firewall_rules',
  category: 'firewall',
  title: 'List firewall rules',
  description:
    'Firewall rules at cluster, node or guest level, in evaluation order with their position. ' +
    'The result carries the digest of the rule file. ' +
    POS_HINT,
  access: 'read',
  input: scopeInput,
  handler: async (args, ctx) => {
    const base = await firewallBase(ctx, args);
    const rows = (await ctx.client.get<Row[]>(base + '/rules')) ?? [];
    let digest = rows.map((r) => r.digest).find((d): d is string => typeof d === 'string');
    if (digest === undefined && rows.length > 0) {
      // Some versions return the digest only on the single rule, so fetch the first one for it.
      try {
        const pos = typeof rows[0]?.pos === 'number' ? rows[0].pos : 0;
        const first = await ctx.client.get<{ digest?: string }>(base + pvePath`/rules/${pos}`);
        digest = first?.digest;
      } catch {
        // The digest is a convenience, the list stays valid without it.
      }
    }
    return {
      scope: scopeLabel(args),
      count: rows.length,
      ...(digest !== undefined ? { digest } : {}),
      rules: rows.map((row) => {
        const rule = { ...row };
        delete rule.digest;
        return rule;
      }),
    };
  },
});

const firewallRuleAdd = defineTool({
  name: 'pve_firewall_rule_add',
  category: 'firewall',
  title: 'Add firewall rule',
  description:
    'Add a firewall rule at cluster, node or guest level. type in, out or forward (group applies a ' +
    'security group named in action). Without pos the rule is appended at the end, with pos it is ' +
    'inserted there and later rules shift down. Rules are evaluated top to bottom, the first match ' +
    'wins. A DROP or REJECT rule on cluster or node level, or enabling the firewall, can lock you out ' +
    'of the web UI and API (port 8006) and SSH, so such a rule asks the user first. ' +
    POS_HINT,
  access: 'write',
  input: {
    ...scopeInput,
    type: ruleType,
    action: ruleAction,
    ...ruleFields,
    pos: posSchema.optional().describe('Insert at this position instead of appending'),
    digest: digestSchema,
  },
  needsConfirmation: (args) => args.level !== 'guest' && isBlockingAction(args.action),
  confirmTarget: async (args, ctx) =>
    `add firewall rule ${ruleSummary(args)} at ${args.pos === undefined ? 'the end' : `position ${args.pos}`} on ${await scopeTarget(ctx, args)}`,
  handler: async (args, ctx) => {
    const base = await firewallBase(ctx, args);
    await ctx.client.post(base + '/rules', {
      ...ruleParams(args),
      pos: args.pos,
      digest: args.digest,
    });
    return { scope: scopeLabel(args), added: true, pos: args.pos ?? 'end' };
  },
});

const firewallRuleUpdate = defineTool({
  name: 'pve_firewall_rule_update',
  category: 'firewall',
  title: 'Update firewall rule',
  description:
    'Change the rule at a position. Only the given fields change, delete lists fields to clear ' +
    '(for example ["comment", "dport"]). moveto moves the rule to a new position, Proxmox ignores all ' +
    'other fields in that call, so move and edit in separate calls. On cluster or node level the user ' +
    'is asked first when the rule is active and can drop traffic after the change (DROP, REJECT or a ' +
    'security group) or when an active ACCEPT or group rule is disabled, moved or changed in a ' +
    'filtering field. Comment and log changes do not ask. ' +
    POS_HINT,
  access: 'write',
  input: {
    ...scopeInput,
    pos: posSchema,
    type: ruleType.optional(),
    action: ruleAction.optional(),
    ...ruleFields,
    moveto: posSchema.optional().describe('Move the rule to this position (no other change)'),
    delete: z
      .array(z.string().regex(/^[A-Za-z][A-Za-z0-9_-]*$/))
      .max(20)
      .optional()
      .describe('Fields to remove from the rule'),
    digest: digestSchema,
  },
  needsConfirmation: (args, ctx) => ruleUpdateNeedsConfirmation(args, ctx),
  confirmTarget: async (args, ctx) => {
    let current = '';
    try {
      const base = await firewallBase(ctx, args);
      const row = await ctx.client.get<Row>(base + pvePath`/rules/${args.pos}`);
      if (row && typeof row === 'object') current = ` (now ${ruleSummary(row)})`;
    } catch {
      current = '';
    }
    const cleared = args.delete?.length ? `, clear ${args.delete.join(', ')}` : '';
    const change =
      args.moveto !== undefined
        ? `move firewall rule ${args.pos}${current} to position ${args.moveto}`
        : `change firewall rule ${args.pos}${current} to ${ruleSummary(args)}${cleared}`;
    return `${change} on ${await scopeTarget(ctx, args)}`;
  },
  handler: async (args, ctx) => {
    const base = await firewallBase(ctx, args);
    const fields = ruleParams(args);
    if (args.moveto !== undefined) {
      if (Object.values(fields).some((v) => v !== undefined) || args.delete?.length) {
        throw new Error(
          'moveto cannot be combined with other changes. Move the rule in its own call.',
        );
      }
    }
    await ctx.client.put(base + pvePath`/rules/${args.pos}`, {
      ...fields,
      moveto: args.moveto,
      delete: args.delete?.length ? args.delete.join(',') : undefined,
      digest: args.digest,
    });
    return {
      scope: scopeLabel(args),
      pos: args.pos,
      ...(args.moveto !== undefined ? { movedTo: args.moveto } : { updated: true }),
    };
  },
});

const firewallRuleDelete = defineTool({
  name: 'pve_firewall_rule_delete',
  category: 'firewall',
  title: 'Delete firewall rule',
  description:
    'Delete the rule at a position. Rules after it move up by one, so delete several rules from the ' +
    'highest position down, or read the rules again between calls. Removing an ACCEPT rule can cut off ' +
    'access. ' +
    POS_HINT,
  access: 'destructive',
  input: { ...scopeInput, pos: posSchema, digest: digestSchema },
  confirmTarget: async (args, ctx) => {
    let rule = '';
    try {
      const base = await firewallBase(ctx, args);
      const row = await ctx.client.get<Row>(base + pvePath`/rules/${args.pos}`);
      if (row && typeof row === 'object') rule = ` (${ruleSummary(row)})`;
    } catch {
      rule = '';
    }
    return `delete firewall rule ${args.pos}${rule} on ${await scopeTarget(ctx, args)}`;
  },
  handler: async (args, ctx) => {
    const base = await firewallBase(ctx, args);
    await ctx.client.delete(base + pvePath`/rules/${args.pos}`, { digest: args.digest });
    return { scope: scopeLabel(args), pos: args.pos, deleted: true };
  },
});

const firewallOptions = defineTool({
  name: 'pve_firewall_options',
  category: 'firewall',
  title: 'Firewall options',
  description:
    'Firewall options at cluster, node or guest level: enable flag, input/output/forward policies, ' +
    'log levels and similar settings, plus the digest for pve_firewall_options_set. The firewall is ' +
    'only active at a level when its enable option is true (the cluster switch must be on as well).',
  access: 'read',
  input: scopeInput,
  handler: async (args, ctx) => {
    const base = await firewallBase(ctx, args);
    const data = (await ctx.client.get<Row>(base + '/options')) ?? {};
    return { scope: scopeLabel(args), options: data };
  },
});

/** Options whose change can lock the caller out when set at cluster or node level. */
const LOCKOUT_OPTIONS = ['enable', 'policy_in', 'policy_out', 'policy_forward'];

const firewallOptionsSet = defineTool({
  name: 'pve_firewall_options_set',
  category: 'firewall',
  title: 'Change firewall options',
  description:
    'Change firewall options at cluster, node or guest level. options is a map of Proxmox option ' +
    'names to values (enable, policy_in, policy_out, policy_forward, log_level_in, log_level_out, ' +
    'nosmurfs, tcpflags, ndp, macfilter, ipfilter, dhcp, ...), delete lists options to reset to their ' +
    'default. Option names depend on the level, read pve_firewall_options first. Enabling the ' +
    'firewall or setting a DROP or REJECT policy at cluster or node level can lock you out of the API ' +
    'and SSH, so changing or resetting enable or a policy there asks for confirmation (the default ' +
    'input policy is DROP). Pass the digest from the last read.',
  access: 'write',
  input: {
    ...scopeInput,
    options: z
      .record(z.string(), z.union([z.string(), z.number(), z.boolean()]))
      .optional()
      .describe('Option name to value, for example {"enable": true, "policy_in": "DROP"}'),
    delete: z
      .array(z.string().regex(/^[A-Za-z][A-Za-z0-9_-]*$/))
      .max(30)
      .optional()
      .describe('Options to reset to their default'),
    digest: digestSchema,
  },
  needsConfirmation: (args) =>
    args.level !== 'guest' &&
    LOCKOUT_OPTIONS.some(
      (k) => args.options?.[k] !== undefined || splitList(args.delete, 'delete').includes(k),
    ),
  confirmTarget: async (args, ctx) => {
    const changes = [
      args.options ? `set ${jsonText(args.options)}` : undefined,
      args.delete?.length ? `reset ${args.delete.join(', ')} to the default` : undefined,
    ].filter(Boolean);
    return `${changes.join(' and ')} in the firewall options on ${await scopeTarget(ctx, args)}`;
  },
  handler: async (args, ctx) => {
    if (!args.options && !args.delete?.length) {
      throw new Error('Pass options to set, delete to reset, or both.');
    }
    for (const reserved of ['digest', 'delete']) {
      if (args.options && reserved in args.options) {
        throw new Error(`"${reserved}" is not an option, pass it as its own argument.`);
      }
    }
    const base = await firewallBase(ctx, args);
    const params: Record<string, Scalar | undefined> = {};
    mergeOptions(params, args.options, 'pve_firewall_options_set');
    await ctx.client.put(base + '/options', {
      ...params,
      delete: args.delete?.length ? args.delete.join(',') : undefined,
      digest: args.digest,
    });
    return { scope: scopeLabel(args), updated: true };
  },
});

export const firewallTools: AnyToolDef[] = [
  firewallRules,
  firewallRuleAdd,
  firewallRuleUpdate,
  firewallRuleDelete,
  firewallOptions,
  firewallOptionsSet,
];
