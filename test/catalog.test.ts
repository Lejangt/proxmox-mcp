import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ALL_TOOLS } from '../src/tools/catalog.js';

const ACCESS = { R: 'read', W: 'write', D: 'destructive' } as const;

/** Rows of the "Categories and tools" table in docs/architecture.md: the contract. */
function contractRows(): Array<{ category: string; name: string; access: string }> {
  const doc = readFileSync(new URL('../docs/architecture.md', import.meta.url), 'utf8');
  const rows: Array<{ category: string; name: string; access: string }> = [];
  for (const line of doc.split('\n')) {
    const cells = line.split('|').map((c) => c.trim());
    // | category | tool | access | purpose |
    if (cells.length < 5 || !/^pve_[a-z0-9_]+$/.test(cells[2] ?? '')) continue;
    const letter = cells[3] as keyof typeof ACCESS;
    rows.push({ category: cells[1] ?? '', name: cells[2] ?? '', access: ACCESS[letter] });
  }
  return rows;
}

describe('tool catalog', () => {
  it('lists every tool name exactly once', () => {
    const names = ALL_TOOLS.map((t) => t.name);
    const duplicates = names.filter((n, i) => names.indexOf(n) !== i);
    expect(duplicates).toEqual([]);
  });

  it('contains every tool of the contract table with its category and access level', () => {
    const rows = contractRows();
    expect(rows.length).toBeGreaterThan(60);
    const byName = new Map(ALL_TOOLS.map((t) => [t.name, t]));
    for (const row of rows) {
      const tool = byName.get(row.name);
      expect(tool, `${row.name} is missing from the catalog`).toBeDefined();
      expect(`${tool?.name}:${tool?.category}:${tool?.access}`).toBe(
        `${row.name}:${row.category}:${row.access}`,
      );
    }
  });

  it('has no tool outside the contract table', () => {
    const contract = new Set(contractRows().map((r) => r.name));
    expect(ALL_TOOLS.map((t) => t.name).filter((n) => !contract.has(n))).toEqual([]);
  });
});
