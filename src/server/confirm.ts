import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import {
  CLIENT_CAPABILITIES_META_KEY,
  createRequestStateCodec,
  inputRequired,
  inputResponse,
  type ClientCapabilities,
  type InputRequiredResult,
  type RequestStateCodec,
  type ServerContext,
} from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { ConfirmMode } from '../config/types.js';

/**
 * Confirmation of destructive tools through MCP elicitation.
 *
 * SDK v2 serves two protocol eras with one handler: a tool callback returns
 * `inputRequired(...)` to ask the client for input and is called again with
 * the answer in `ctx.mcpReq.inputResponses`. On 2026-07-28 connections the
 * client fulfils the request itself, on 2025-era connections (most stdio
 * clients today) the SDK shim sends a real `elicitation/create` request and
 * re-enters the handler. That is why this module returns a decision for the
 * tool callback to act on instead of awaiting `ctx.mcpReq.elicitInput`.
 *
 * A confirmation is bound to the exact call it was asked for. The question
 * carries a `requestState` that holds a binding over tool name, host and the
 * canonical arguments, keyed with a random per-process secret, and the state
 * itself is sealed with the SDK's HMAC codec (also keyed per process). An
 * answer is only accepted when the echoed state verifies and its binding
 * matches the arguments of the call that carries the answer, so an answer
 * cannot be replayed for other arguments, and an answer that was never asked
 * for (no state) is ignored. The arguments are those returned by the tool's
 * `prepare`, which runs again in the answering call, so state pinned there
 * (the digest of a firewall rule list) is covered by the binding as well.
 */

export type ConfirmDecision =
  | { kind: 'proceed' }
  | { kind: 'ask'; result: InputRequiredResult }
  | { kind: 'refuse'; message: string };

export interface ConfirmRequest {
  mode: ConfirmMode;
  tool: string;
  host: string;
  /** What the call affects, for example "VMID 100". */
  target?: string;
  /** Capabilities the client declared, undefined when unknown. */
  capabilities: ClientCapabilities | undefined;
  inputResponses: Record<string, unknown> | undefined;
  /** Binding of this call (confirmBinding of tool, host and arguments). */
  binding: string;
  /** Verified requestState payload echoed by the client, undefined when none was sent. */
  echoedState: unknown;
  /** Sealed requestState to attach when asking, carries `binding`. */
  newState: string;
}

/** Payload of the confirmation requestState. */
export interface ConfirmState {
  v: 1;
  binding: string;
}

const CONFIRM_KEY = 'confirm';
/** A question older than this is no longer accepted as an answer. */
const STATE_TTL_SECONDS = 600;

const confirmSchema = z.object({
  confirm: z.boolean().describe('Set to true to run this operation'),
});

/** Form mode is supported when declared, a bare `elicitation: {}` counts as form (older clients). */
export function supportsFormElicitation(caps: ClientCapabilities | undefined): boolean {
  const elicitation = caps?.elicitation;
  if (!elicitation) return false;
  return elicitation.form !== undefined || elicitation.url === undefined;
}

/**
 * Every character outside printable ASCII as `\uXXXX`. Line and paragraph
 * separators, NEL, bidirectional overrides and isolates, zero width and
 * other invisible characters would otherwise let a value add lines to the
 * question or reorder how it reads. Printable ASCII passes unchanged, so
 * applying it twice changes nothing.
 */
export function printableAscii(text: string): string {
  return text.replace(
    /[^\x20-\x7e]/g,
    (ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`,
  );
}

/**
 * Longest target text, after escaping, that a confirmation question carries.
 * Values the call acts on are never cut in a question, because a model that
 * follows injected instructions could place its payload in the part left
 * out. A target longer than this is refused instead of shown.
 */
export const MAX_TARGET_CHARS = 5000;

/**
 * Thrown by a confirmTarget to refuse the call instead of asking, for example
 * when the values it would have to show are too long to read, or when what it
 * read from Proxmox is no longer what the call would act on.
 */
export class ConfirmRefusal extends Error {
  override name = 'ConfirmRefusal';
}

/**
 * `text` when it fits, otherwise its start and its end with the number of
 * characters left out in between, so the end of a long value stays visible.
 * Only for descriptive values read from Proxmox (a guest name, the schedule
 * of a job), never for a value the call acts on.
 */
export function cutMiddle(text: string, max: number): string {
  if (text.length <= max) return text;
  const tail = Math.floor(max / 2);
  const head = max - tail;
  return `${text.slice(0, head)}...[${text.length - max} characters omitted]...${text.slice(text.length - tail)}`;
}

export function confirmMessage(req: Pick<ConfirmRequest, 'tool' | 'host' | 'target'>): string {
  const target = req.target ? `, target: ${req.target}` : '';
  return printableAscii(
    `Confirm destructive operation: ${req.tool} on host "${req.host}"${target}. This cannot be undone. Run it?`,
  );
}

/** JSON with sorted object keys and without undefined values, so equal arguments give equal text. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonical(value)) ?? 'null';
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((v) => (v === undefined ? null : canonical(v)));
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      const v = (value as Record<string, unknown>)[key];
      if (v !== undefined) out[key] = canonical(v);
    }
    return out;
  }
  return value;
}

/**
 * Seals and binds confirmation state. One instance per server, both keys are
 * random per process, so state minted by another process never verifies.
 */
export interface ConfirmBinder {
  /** HMAC-SHA256 over tool name, host alias and the canonical arguments (without `host`). */
  binding(tool: string, host: string, args: Record<string, unknown>): string;
  mint(binding: string): Promise<string>;
  /** Pass as ServerOptions.requestState.verify. Throws on a bad, foreign or expired state. */
  verify(state: string, ctx: ServerContext): Promise<ConfirmState>;
}

export function createConfirmBinder(): ConfirmBinder {
  const bindingKey = randomBytes(32);
  const codec: RequestStateCodec<ConfirmState> = createRequestStateCodec<ConfirmState>({
    key: randomBytes(32),
    ttlSeconds: STATE_TTL_SECONDS,
  });
  return {
    binding(tool, host, args) {
      const rest = { ...args };
      delete rest.host;
      return createHmac('sha256', bindingKey)
        .update(canonicalJson(['proxmox-ve-mcp.confirm.v1', tool, host, rest]))
        .digest('base64url');
    },
    mint: (binding) => codec.mint({ v: 1, binding }),
    verify: (state, ctx) => codec.verify(state, ctx),
  };
}

function stateBinding(state: unknown): string | undefined {
  if (state === null || typeof state !== 'object') return undefined;
  const { v, binding } = state as Partial<ConfirmState>;
  return v === 1 && typeof binding === 'string' ? binding : undefined;
}

function sameBinding(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

export function decideConfirmation(req: ConfirmRequest): ConfirmDecision {
  if (req.mode === 'never') return { kind: 'proceed' };

  if (!supportsFormElicitation(req.capabilities)) {
    // auto relies on the approval prompt of the client, always needs our own.
    if (req.mode === 'auto') return { kind: 'proceed' };
    return {
      kind: 'refuse',
      message:
        `${req.tool} needs user confirmation (confirmDestructive: always) but this MCP client cannot ask ` +
        'questions (no elicitation support). Nothing was changed. Use a client with elicitation support ' +
        'or set confirmDestructive to auto or never in the settings file.',
    };
  }

  if (req.target !== undefined) {
    const length = printableAscii(req.target).length;
    if (length > MAX_TARGET_CHARS) {
      return {
        kind: 'refuse',
        message:
          `${req.tool}: the confirmation question would show ${length} characters of arguments, at most ` +
          `${MAX_TARGET_CHARS} are shown and nothing is cut. Nothing was changed. Call it with shorter values.`,
      };
    }
  }

  const ask: ConfirmDecision = {
    kind: 'ask',
    result: inputRequired({
      inputRequests: {
        [CONFIRM_KEY]: inputRequired.elicit({
          message: confirmMessage(req),
          requestedSchema: confirmSchema,
        }),
      },
      requestState: req.newState,
    }),
  };

  const answer = inputResponse(req.inputResponses, CONFIRM_KEY);
  if (answer.kind === 'missing') return ask;
  // An answer without our state was never asked for in this flow: ignore it and ask.
  if (req.echoedState === undefined) return ask;
  const echoed = stateBinding(req.echoedState);
  if (echoed === undefined || !sameBinding(echoed, req.binding)) {
    return {
      kind: 'refuse',
      message:
        `${req.tool}: the confirmation was given for a different call (tool, host or arguments differ, ` +
        'or the state the call was pinned to changed since the question). Nothing was changed. Call the ' +
        'tool again to be asked for the current arguments.',
    };
  }
  if (answer.kind === 'elicit' && answer.action === 'accept') {
    const parsed = confirmSchema.safeParse(answer.content);
    if (parsed.success && parsed.data.confirm) return { kind: 'proceed' };
  }
  return {
    kind: 'refuse',
    message: `${req.tool} was not confirmed by the user. Nothing was changed.`,
  };
}

/** Client capabilities of the current request, from the 2026 envelope or the initialize handshake. */
export function capabilitiesOf(
  ctx: ServerContext,
  fallback: () => ClientCapabilities | undefined,
): ClientCapabilities | undefined {
  const envelope = ctx.mcpReq.envelope as Record<string, unknown> | undefined;
  const fromEnvelope = envelope?.[CLIENT_CAPABILITIES_META_KEY] as ClientCapabilities | undefined;
  return fromEnvelope ?? fallback();
}
