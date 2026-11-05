import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { CATEGORIES, defineTool, type AnyToolDef } from '../src/server/registry.js';

describe('defineTool', () => {
  it('keeps the input types and fits into AnyToolDef', () => {
    const tool = defineTool({
      name: 'pve_example',
      category: 'core',
      title: 'Example',
      description: 'Example tool.',
      access: 'read',
      input: { vmid: z.number() },
      handler: async (args) => args.vmid + (args.host ? 1 : 0),
    });
    const list: AnyToolDef[] = [tool];
    expect(list).toHaveLength(1);
    expect(CATEGORIES).toHaveLength(14);
  });
});
