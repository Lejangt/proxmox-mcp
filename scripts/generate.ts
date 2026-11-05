/*
 * Generates the files derived from the tool catalog:
 *   config.schema.json  JSON Schema of the settings file
 *   docs/tools.md       tool reference, one section per category
 *
 * `npm run generate` writes both files. `npm run generate -- --check` writes
 * nothing and exits with 1 when a file is missing or out of date, which CI uses.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { accessLetter, type CatalogEntry, settingsJsonSchema } from '../src/config/schema.js';
import { type AnyToolDef, CATEGORIES } from '../src/server/registry.js';
import { ALL_TOOLS } from '../src/tools/catalog.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const catalog: CatalogEntry[] = ALL_TOOLS.map(({ name, category, access, title }) => ({
  name,
  category,
  access,
  title,
}));

interface ParamSchema {
  properties?: Record<string, { description?: string }>;
  required?: string[];
}

function paramsOf(tool: AnyToolDef): ParamSchema {
  return z.toJSONSchema(z.object(tool.input), {
    io: 'input',
    unrepresentable: 'any',
  }) as ParamSchema;
}

/* Cuts a description after its first sentence. */
function firstSentence(text: string): string {
  const flat = text.trim().replace(/\s+/g, ' ');
  const end = flat.search(/[.!?](\s|$)/);
  return end === -1 ? flat : flat.slice(0, end + 1);
}

/* Pipes would end the table cell early. */
const tableCell = (text: string) => text.replace(/\|/g, '\\|');

function toolsMarkdown(): string {
  const localNames = ALL_TOOLS.filter((t) => t.local)
    .map((t) => `\`${t.name}\``)
    .join(', ');
  const out: string[] = [
    '# Tools',
    '',
    `Access: R = read, W = write, D = destructive. Every tool also takes the optional parameter \`host\`, except local tools (${localNames}), which never contact Proxmox.`,
    '',
  ];

  for (const category of CATEGORIES) {
    const tools = ALL_TOOLS.filter((t) => t.category === category.id);
    if (tools.length === 0) continue;

    out.push(`## ${category.title}`, '', category.description, '');
    out.push('| Tool | Access | Description |', '|---|---|---|');
    for (const tool of tools) {
      out.push(
        `| \`${tool.name}\` | ${accessLetter(tool.access)} | ${tableCell(firstSentence(tool.description))} |`,
      );
    }
    out.push('', '### Parameters', '');

    for (const tool of tools) {
      const params = paramsOf(tool);
      const lines = Object.entries(params.properties ?? {}).map(([key, value]) => {
        const required = params.required?.includes(key) ? 'required' : 'optional';
        const description = (value.description ?? 'No description.').replace(/\s+/g, ' ');
        return `- \`${key}\` (${required}): ${description}`;
      });
      if (lines.length === 0) {
        lines.push(
          tool.local ? '- None. Local tool, no `host` parameter.' : '- None besides `host`.',
        );
      }
      out.push(`**\`${tool.name}\`**`, '', ...lines, '');
    }
  }

  return out.join('\n');
}

const files = [
  {
    path: 'config.schema.json',
    content: `${JSON.stringify(settingsJsonSchema(catalog), null, 2)}\n`,
  },
  { path: 'docs/tools.md', content: toolsMarkdown() },
];

const check = process.argv.includes('--check');
let stale = false;

for (const file of files) {
  const target = join(root, file.path);
  if (check) {
    const current = existsSync(target) ? readFileSync(target, 'utf8') : undefined;
    if (current !== file.content) {
      console.error(`out of date: ${file.path}`);
      stale = true;
    }
    continue;
  }
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, file.content);
  console.log(`wrote ${file.path}`);
}

if (check && stale) {
  console.error('Run "npm run generate" and commit the result.');
  process.exitCode = 1;
} else if (check) {
  console.log('generated files are up to date');
}
