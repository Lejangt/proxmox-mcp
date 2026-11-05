import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { open, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { syncSettingsDocument } from '../config/write.js';
import { writeSettingsFile } from '../config/write.js';
import { maxPositionals, requireInteractive, runCommand, type ContextInput } from './common.js';
import type { CliContext } from './context.js';
import { CliError, messageOf, UsageError } from './errors.js';
import {
  configLocation,
  loadForCli,
  readConfigText,
  requireConfigText,
  validateText,
  writeValidated,
} from './settings-file.js';

/**
 * Splits an editor command like `code --wait` into argv without a shell.
 * Single quotes keep everything literal, double quotes allow \" and \\.
 * On Windows a backslash is a path separator and stays literal.
 */
export function splitCommandLine(value: string, platform: NodeJS.Platform): string[] {
  const out: string[] = [];
  let current = '';
  let inToken = false;
  let quote: '"' | "'" | undefined;
  for (let i = 0; i < value.length; i++) {
    const ch = value[i]!;
    if (quote === "'") {
      if (ch === "'") quote = undefined;
      else current += ch;
      continue;
    }
    if (quote === '"') {
      if (ch === '"') quote = undefined;
      else if (ch === '\\' && (value[i + 1] === '"' || value[i + 1] === '\\')) {
        current += value[++i];
      } else current += ch;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      inToken = true;
    } else if (/\s/.test(ch)) {
      if (inToken) out.push(current);
      current = '';
      inToken = false;
    } else if (ch === '\\' && platform !== 'win32' && i + 1 < value.length) {
      current += value[++i];
      inToken = true;
    } else {
      current += ch;
      inToken = true;
    }
  }
  if (quote) throw new CliError('The editor command has an unterminated quote.');
  if (inToken) out.push(current);
  return out;
}

/** argv of the editor from $VISUAL or $EDITOR, with a platform default. */
export function editorCommand(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string[] {
  const raw = env.VISUAL?.trim() || env.EDITOR?.trim();
  if (!raw) return [platform === 'win32' ? 'notepad' : 'vi'];
  const argv = splitCommandLine(raw, platform);
  if (argv.length === 0) return [platform === 'win32' ? 'notepad' : 'vi'];
  return argv;
}

function runEditor(argv: string[], file: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(argv[0]!, [...argv.slice(1), file], { stdio: 'inherit', shell: false });
    child.once('error', (err: NodeJS.ErrnoException) =>
      reject(
        new CliError(
          `Cannot start the editor ${JSON.stringify(argv[0])} (${err.code ?? err.message}). Set $VISUAL or $EDITOR.`,
        ),
      ),
    );
    child.once('exit', (code, signal) => resolve(signal ? 1 : (code ?? 1)));
  });
}

async function cmdPath(ctx: CliContext): Promise<number> {
  const location = configLocation(ctx);
  ctx.stdout(`${location.path}\n`);
  if ((await readConfigText(location.path)) === undefined) {
    ctx.stderr(`${ctx.color.dim('(does not exist yet, run proxmox-ve-mcp setup)')}\n`);
  }
  return 0;
}

async function cmdValidate(ctx: CliContext): Promise<number> {
  const location = configLocation(ctx);
  const text = await requireConfigText(location.path);
  const catalog = await ctx.catalog();
  validateText(text, catalog, `Settings file ${location.path}`);
  const loaded = await loadForCli(ctx);
  const c = ctx.color;
  for (const warning of loaded.warnings) ctx.stderr(`${c.yellow('warning:')} ${warning}\n`);
  const missing = syncSettingsDocument(text, catalog).added;
  const hosts = Object.keys(loaded.settings.hosts).length;
  ctx.stdout(`${c.green('valid')} ${location.path} (${hosts} host${hosts === 1 ? '' : 's'})\n`);
  if (missing.length > 0) {
    ctx.stdout(
      `${missing.length} categories or tools of this version are not listed in the file, they follow their category. ` +
        'Run `proxmox-ve-mcp config sync` to list them.\n',
    );
  }
  return 0;
}

async function cmdSync(ctx: CliContext, dryRun: boolean): Promise<number> {
  const location = configLocation(ctx);
  const text = await requireConfigText(location.path);
  const catalog = await ctx.catalog();
  validateText(text, catalog, `Settings file ${location.path}`);
  const result = syncSettingsDocument(text, catalog);
  const c = ctx.color;
  if (result.added.length === 0) {
    ctx.stdout(`${location.path} already lists every category and tool.\n`);
    return 0;
  }
  if (!dryRun) await writeValidated(location.path, result.text, catalog);
  ctx.stdout(
    `${dryRun ? 'Would add' : 'Added'} ${result.added.length} entr${result.added.length === 1 ? 'y' : 'ies'} to ${location.path}:\n`,
  );
  for (const entry of result.added) ctx.stdout(`  ${c.green('+')} ${entry}\n`);
  return 0;
}

async function cmdEdit(ctx: CliContext): Promise<number> {
  requireInteractive(ctx, 'config edit');
  const location = configLocation(ctx);
  const original = await requireConfigText(location.path);
  const catalog = await ctx.catalog();
  const argv = editorCommand(ctx.env, ctx.platform);
  const p = ctx.prompter;

  // The editor works on a private copy, the real file is only replaced by a valid version.
  const dir = path.dirname(location.path);
  const tmp = path.join(
    dir,
    `.${path.basename(location.path)}.edit-${randomBytes(4).toString('hex')}.yaml`,
  );
  const handle = await open(tmp, 'wx', 0o600);
  try {
    await handle.writeFile(original, 'utf8');
  } finally {
    await handle.close();
  }
  try {
    for (;;) {
      const code = await runEditor(argv, tmp);
      if (code !== 0) {
        throw new CliError(`The editor exited with code ${code}, the settings file is unchanged.`);
      }
      const edited = await readFile(tmp, 'utf8');
      if (edited === original) {
        ctx.stdout('No changes.\n');
        return 0;
      }
      try {
        validateText(edited, catalog, 'The edited settings');
      } catch (err) {
        p.error(messageOf(err));
        const next = await p.select({
          message: 'The edited settings are invalid. What now?',
          options: [
            { value: 'again', label: 'Edit again' },
            { value: 'discard', label: 'Discard the changes', hint: 'keeps the current file' },
          ],
        });
        if (next === 'again') continue;
        ctx.stdout('Changes discarded, the settings file is unchanged.\n');
        return 1;
      }
      const current = await readConfigText(location.path);
      if (current !== original) {
        const overwrite = await p.confirm({
          message: 'The settings file was changed by something else meanwhile. Overwrite it?',
          initialValue: false,
        });
        if (!overwrite) {
          ctx.stdout('Not saved.\n');
          return 1;
        }
      }
      await writeSettingsFile(location.path, edited);
      ctx.stdout(`${ctx.color.green('Saved')} ${location.path}\n`);
      return 0;
    }
  } finally {
    await rm(tmp, { force: true });
  }
}

const HELP = `Usage: proxmox-ve-mcp config <path|validate|sync|edit> [--config <path>]

  path        print the path of the settings file
  validate    check the file against the schema and the tool catalog
  sync        add categories and tools of this version that the file does not
              list yet, existing values and comments stay (--dry-run to preview)
  edit        open the file in $VISUAL or $EDITOR, save only when it is valid

Options:
  --config <path>   settings file (default: platform config directory, or PROXMOX_MCP_CONFIG)
  -h, --help        show this help
`;

export function run(args: string[], ctx?: ContextInput): Promise<number> {
  return runCommand(
    {
      help: HELP,
      options: { 'dry-run': { type: 'boolean' } },
      async run(parsed, ctx) {
        maxPositionals(parsed, 1);
        const sub = parsed.positionals[0];
        if (parsed.values['dry-run'] && sub !== 'sync') {
          throw new UsageError('--dry-run only applies to config sync');
        }
        switch (sub) {
          case 'path':
            return cmdPath(ctx);
          case 'validate':
            return cmdValidate(ctx);
          case 'sync':
            return cmdSync(ctx, parsed.values['dry-run'] === true);
          case 'edit':
            return cmdEdit(ctx);
          case undefined:
            throw new UsageError('name a subcommand: path, validate, sync or edit');
          default:
            throw new UsageError(`unknown subcommand "${sub.slice(0, 40)}"`);
        }
      },
    },
    args,
    ctx,
  );
}
