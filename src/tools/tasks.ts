import { z } from 'zod';
import { pvePath } from '../proxmox/path.js';
import { parseUpid, tailTaskLog, waitForTask } from '../proxmox/tasks.js';
import { defineTool, type AnyToolDef } from '../server/registry.js';
import { nodeSchema, upidSchema, vmidSchema } from './common.js';

interface TaskRow {
  node?: string;
  upid?: string;
  starttime?: number;
  [key: string]: unknown;
}

interface LogRow {
  n?: number;
  t?: string;
}

export const taskTools: AnyToolDef[] = [
  defineTool({
    name: 'pve_task_list',
    category: 'tasks',
    title: 'List tasks',
    description:
      'List recent Proxmox tasks (start, stop, backup, migrate, ...), newest first. ' +
      'Without node it queries all online nodes. Filter by vmid, typefilter (task type such as qmstart, vzdump, qmigrate), ' +
      'statusfilter (ok, warning, error, unknown, comma separated) or errors=true for failed tasks only. ' +
      'Each entry has the upid, use pve_task_status, pve_task_log or pve_task_wait with it.',
    access: 'read',
    input: {
      node: nodeSchema.optional().describe('Only this node, default all online nodes'),
      vmid: vmidSchema.optional().describe('Only tasks of this guest'),
      typefilter: z.string().max(64).optional().describe('Only this task type, for example vzdump'),
      statusfilter: z
        .string()
        .max(64)
        .optional()
        .describe('Only these final states: ok, warning, error, unknown (comma separated)'),
      errors: z.boolean().optional().describe('Only tasks that ended with an error'),
      limit: z.number().int().min(1).max(500).optional().describe('Maximum entries, default 50'),
    },
    handler: async (args, ctx) => {
      const limit = args.limit ?? 50;
      const params = {
        limit,
        vmid: args.vmid,
        typefilter: args.typefilter,
        statusfilter: args.statusfilter,
        errors: args.errors,
      };

      let nodes: string[];
      if (args.node) {
        nodes = [args.node];
      } else {
        const list = await ctx.client.get<Array<{ node: string; status?: string }>>('/nodes');
        nodes = (Array.isArray(list) ? list : [])
          .filter((n) => n.status === undefined || n.status === 'online')
          .map((n) => n.node);
      }

      const fetchNode = async (node: string): Promise<TaskRow[]> => {
        const rows = await ctx.client.get<TaskRow[]>(pvePath`/nodes/${node}/tasks`, params);
        return (Array.isArray(rows) ? rows : []).map((r) => ({ node, ...r }));
      };

      const tasks: TaskRow[] = [];
      const failedNodes: string[] = [];
      if (args.node) {
        // A single named node surfaces its error instead of returning an empty list.
        tasks.push(...(await fetchNode(args.node)));
      } else {
        const settled = await Promise.allSettled(nodes.map(fetchNode));
        settled.forEach((s, i) => {
          if (s.status === 'fulfilled') tasks.push(...s.value);
          else failedNodes.push(nodes[i] as string);
        });
      }
      tasks.sort((a, b) => (b.starttime ?? 0) - (a.starttime ?? 0));
      return {
        count: Math.min(tasks.length, limit),
        tasks: tasks.slice(0, limit),
        ...(failedNodes.length > 0 ? { nodesNotQueried: failedNodes } : {}),
      };
    },
  }),

  defineTool({
    name: 'pve_task_status',
    category: 'tasks',
    title: 'Task status',
    description:
      'Status of one task by UPID: running or stopped, exit status (OK means success), type, user, start time. ' +
      'The node is taken from the UPID. Use pve_task_wait to wait for it to finish.',
    access: 'read',
    input: { upid: upidSchema },
    handler: async (args, ctx) => {
      const info = parseUpid(args.upid);
      const status = await ctx.client.get<Record<string, unknown>>(
        pvePath`/nodes/${info.node}/tasks/${info.upid}/status`,
      );
      return { upid: info.upid, node: info.node, ...status };
    },
  }),

  defineTool({
    name: 'pve_task_log',
    category: 'tasks',
    title: 'Task log',
    description:
      'Read the log of a task by UPID. Returns lines from "start" (default 0) up to "limit" lines (default 100). ' +
      'If more lines follow, call again with start set to nextStart. For the last lines of a long log use pve_task_wait or a high start.',
    access: 'read',
    input: {
      upid: upidSchema,
      start: z.number().int().min(0).optional().describe('First line to return, default 0'),
      limit: z
        .number()
        .int()
        .min(1)
        .max(2000)
        .optional()
        .describe('Maximum number of lines, default 100'),
    },
    handler: async (args, ctx) => {
      const info = parseUpid(args.upid);
      const start = args.start ?? 0;
      const limit = args.limit ?? 100;
      const rows = await ctx.client.get<LogRow[]>(
        pvePath`/nodes/${info.node}/tasks/${info.upid}/log`,
        { start, limit },
      );
      const lines = (Array.isArray(rows) ? rows : []).map((r) => String(r.t ?? ''));
      return {
        upid: info.upid,
        start,
        lines,
        ...(lines.length === limit ? { nextStart: start + lines.length } : {}),
      };
    },
  }),

  defineTool({
    name: 'pve_task_wait',
    category: 'tasks',
    title: 'Wait for task',
    description:
      'Wait until a task finishes and return its result: status, exit status, ok flag and the last log lines. ' +
      'Waiting is bounded, on timeout the task keeps running and the result says timedOut, call again to continue waiting. ' +
      'Use it after a tool was started with wait=false or after a timeout.',
    access: 'read',
    input: {
      upid: upidSchema,
      timeoutSeconds: z
        .number()
        .int()
        .min(1)
        .optional()
        .describe('How long to wait, capped by the configured limit (taskWaitSeconds)'),
      logLines: z
        .number()
        .int()
        .min(0)
        .max(200)
        .optional()
        .describe('Number of trailing log lines to include, default 20'),
    },
    handler: (args, ctx) => {
      const max = ctx.settings.limits.taskWaitSeconds;
      return waitForTask(ctx.client, args.upid, {
        timeoutSeconds: Math.min(args.timeoutSeconds ?? max, max),
        signal: ctx.signal,
        ...(args.logLines === undefined ? {} : { logLines: args.logLines }),
      });
    },
  }),

  defineTool({
    name: 'pve_task_stop',
    category: 'tasks',
    title: 'Stop task',
    description:
      'Stop a running task by UPID, for example a stuck backup or migration. The task is aborted and may leave partial results behind. ' +
      'Returns the task state afterwards.',
    access: 'write',
    input: { upid: upidSchema },
    handler: async (args, ctx) => {
      const info = parseUpid(args.upid);
      await ctx.client.delete(pvePath`/nodes/${info.node}/tasks/${info.upid}`);
      const log = await tailTaskLog(ctx.client, info, 5);
      const status = await ctx.client.get<Record<string, unknown>>(
        pvePath`/nodes/${info.node}/tasks/${info.upid}/status`,
      );
      return { upid: info.upid, node: info.node, stopRequested: true, ...status, log };
    },
  }),
];
