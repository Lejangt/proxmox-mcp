import { z } from 'zod';
import type { AnyToolDef, ToolContext } from '../../src/server/registry.js';
import { fakeContext } from './fixtures.js';
import type { FakeClient } from './fake-client.js';

/** Runs a tool the way the server does: the input is validated and defaulted by its zod shape first. */
export async function callTool(
  tools: AnyToolDef[],
  name: string,
  args: Record<string, unknown>,
  client: FakeClient,
  ctx: ToolContext = fakeContext(client),
): Promise<unknown> {
  const tool = tools.find((t) => t.name === name);
  if (!tool) throw new Error(`unknown tool ${name}`);
  const parsed = z.object(tool.input).parse(args);
  return tool.handler(parsed, ctx);
}

export const UPID = 'UPID:pve1:0000ABCD:0000ABCD:65000000:qmstart:100:root@pam:';
