import type { ToolContext } from '../server/registry.js';
import type { ProxmoxClient } from './types.js';
import { pvePath } from './path.js';

export interface UpidInfo {
  upid: string;
  node: string;
  pid: number;
  pstart: number;
  /** Unix time in seconds. */
  starttime: number;
  type: string;
  id?: string;
  user: string;
}

export interface TaskResult {
  upid: string;
  node: string;
  type: string;
  id?: string;
  status: 'running' | 'stopped';
  exitstatus?: string;
  ok: boolean;
  durationSeconds?: number;
  log?: string[];
  timedOut?: boolean;
  note?: string;
}

export interface WaitOptions {
  timeoutSeconds: number;
  signal?: AbortSignal;
  /** Number of trailing log lines to attach, default 20. */
  logLines?: number;
  /** Poll interval in milliseconds, default 1000. */
  pollMs?: number;
}

// UPID:node:pid:pstart:starttime:type:id:user: with the numbers in hex.
const UPID_RE =
  /^UPID:([A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?):([0-9A-Fa-f]{8}):([0-9A-Fa-f]{8}):([0-9A-Fa-f]{8}):([A-Za-z0-9_-]+):([^:\s]*):([^:\s]+):$/;

export function isUpid(value: unknown): value is string {
  return typeof value === 'string' && value.length < 512 && UPID_RE.test(value);
}

export function parseUpid(upid: string): UpidInfo {
  const m = typeof upid === 'string' ? UPID_RE.exec(upid) : null;
  if (!m) {
    throw new Error(
      'Invalid UPID. Expected the format UPID:node:pid:pstart:starttime:type:id:user: as returned by Proxmox task calls.',
    );
  }
  const [, node, pid, pstart, starttime, type, id, user] = m as RegExpExecArray & string[];
  return {
    upid,
    node: node!,
    pid: parseInt(pid!, 16),
    pstart: parseInt(pstart!, 16),
    starttime: parseInt(starttime!, 16),
    type: type!,
    ...(id ? { id } : {}),
    user: user!,
  };
}

interface RawStatus {
  status?: string;
  exitstatus?: string;
  type?: string;
  id?: string;
  starttime?: number;
}

interface RawLogLine {
  n?: number;
  t?: string;
}

const LOG_PAGE = 500;
const LOG_MAX_PAGES = 40;

/**
 * Reads the last `count` log lines. Proxmox reports the number of lines as
 * `total` next to the data, then the tail is read with one more request.
 * Without `total` the log is paged from the start.
 */
export async function tailTaskLog(
  client: ProxmoxClient,
  info: UpidInfo,
  count: number,
): Promise<string[]> {
  if (count <= 0) return [];
  const path = pvePath`/nodes/${info.node}/tasks/${info.upid}/log`;
  const text = (rows: unknown): string[] =>
    (Array.isArray(rows) ? (rows as RawLogLine[]) : []).map((r) => String(r?.t ?? ''));

  const first = await client.getEnvelope<RawLogLine[]>(path, { start: 0, limit: count });
  let tail = text(first.data);
  const total = first.meta.total;
  if (typeof total === 'number' && Number.isInteger(total) && total >= 0) {
    if (total <= tail.length) return tail.slice(-count);
    const rest = await client.get<RawLogLine[]>(path, { start: total - count, limit: count });
    return text(rest).slice(-count);
  }

  if (tail.length < count) return tail;
  let start = tail.length;
  for (let page = 0; page < LOG_MAX_PAGES; page++) {
    const rows = text(await client.get<RawLogLine[]>(path, { start, limit: LOG_PAGE }));
    if (rows.length === 0) break;
    tail = tail.concat(rows);
    if (tail.length > count) tail = tail.slice(tail.length - count);
    if (rows.length < LOG_PAGE) break;
    start += rows.length;
  }
  return tail;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError(signal));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(abortError(signal));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function abortError(signal?: AbortSignal): Error {
  return signal?.reason instanceof Error ? signal.reason : new Error('Request was cancelled');
}

export async function waitForTask(
  client: ProxmoxClient,
  upid: string,
  options: WaitOptions,
): Promise<TaskResult> {
  const info = parseUpid(upid);
  const pollMs = Math.max(1, options.pollMs ?? 1000);
  const logLines = options.logLines ?? 20;
  const deadline = Date.now() + Math.max(0, options.timeoutSeconds) * 1000;
  const statusPath = pvePath`/nodes/${info.node}/tasks/${info.upid}/status`;

  let raw: RawStatus;
  // Proxmox reports no end time in the task status, so the duration is only
  // known when this call saw the task running. For a task that was already
  // stopped, "now minus start" would be its age and not its duration.
  let sawRunning = false;
  for (;;) {
    if (options.signal?.aborted) throw abortError(options.signal);
    raw = await client.get<RawStatus>(statusPath);
    if (raw?.status === 'stopped') break;
    sawRunning = true;
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    await sleep(Math.min(pollMs, remaining), options.signal);
  }

  const stopped = raw?.status === 'stopped';
  const start = typeof raw?.starttime === 'number' ? raw.starttime : info.starttime;
  const result: TaskResult = {
    upid,
    node: info.node,
    type: raw?.type ?? info.type,
    ...((raw?.id ?? info.id) ? { id: raw?.id ?? info.id } : {}),
    status: stopped ? 'stopped' : 'running',
    ...(raw?.exitstatus !== undefined ? { exitstatus: raw.exitstatus } : {}),
    ok: stopped && raw?.exitstatus === 'OK',
    ...(sawRunning ? { durationSeconds: Math.max(0, Math.round(Date.now() / 1000 - start)) } : {}),
  };
  if (!stopped) {
    result.timedOut = true;
    result.note =
      `The task is still running after ${options.timeoutSeconds} seconds. ` +
      'It continues on the Proxmox host. Call pve_task_wait with this UPID to keep waiting, or pve_task_status to check it.';
  }
  const log = await tailTaskLog(client, info, logLines);
  if (log.length > 0) result.log = log;
  return result;
}

/**
 * Turns the data of a task starting call into the tool result. A UPID is
 * awaited unless `wait` is false, any other value passes through unchanged.
 */
export async function taskOutcome(
  ctx: ToolContext,
  data: unknown,
  wait?: boolean,
): Promise<unknown> {
  if (!isUpid(data)) return data;
  if (wait === false) {
    return {
      upid: data,
      note: 'Task started and running in the background. Use pve_task_wait or pve_task_status with this UPID to follow it.',
    };
  }
  return waitForTask(ctx.client, data, {
    timeoutSeconds: ctx.settings.limits.taskWaitSeconds,
    signal: ctx.signal,
  });
}
