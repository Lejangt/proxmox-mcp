import { parseArgs, type ParseArgsOptionsConfig } from 'node:util';
import { extractConfigPath } from './args.js';
import { createContext, type CliContext } from './context.js';
import { CliError, exitCodeOf, messageOf, UsageError } from './errors.js';

export interface ParsedArgs {
  positionals: string[];
  values: Record<string, string | boolean | undefined>;
}

export interface CommandSpec {
  /** Help text shown for --help. */
  help: string;
  options?: ParseArgsOptionsConfig;
  run(args: ParsedArgs, ctx: CliContext): Promise<number>;
}

/** Context passed in by tests, or a fresh one for real runs. */
export type ContextInput = CliContext | Partial<CliContext> | undefined;

function toContext(input: ContextInput): CliContext {
  if (input && 'prompter' in input && 'stdout' in input && 'keyring' in input) {
    return input as CliContext;
  }
  return createContext(input ?? {});
}

/**
 * Runs a command: handles --config, --help and argument errors, prints
 * failures as one message without a stack trace and returns the exit code.
 */
export async function runCommand(
  spec: CommandSpec,
  argv: string[],
  input?: ContextInput,
): Promise<number> {
  const ctx = toContext(input);
  try {
    const { configPath, rest } = extractConfigPath(argv);
    if (configPath !== undefined) {
      if (configPath === '') throw new UsageError('--config needs a path');
      ctx.configPath = configPath;
    }
    if (rest.includes('--help') || rest.includes('-h')) {
      ctx.stdout(spec.help.endsWith('\n') ? spec.help : `${spec.help}\n`);
      return 0;
    }
    let parsed: ParsedArgs;
    try {
      const result = parseArgs({
        args: rest,
        options: spec.options ?? {},
        allowPositionals: true,
        strict: true,
      });
      parsed = {
        positionals: result.positionals,
        values: result.values as ParsedArgs['values'],
      };
    } catch (err) {
      throw new UsageError((err as Error).message.split('\n')[0] ?? 'invalid arguments');
    }
    return await spec.run(parsed, ctx);
  } catch (err) {
    const message = messageOf(err);
    const code = exitCodeOf(err);
    const c = ctx.color;
    if (code === 130) ctx.stderr(`${c.yellow(message)}\n`);
    else ctx.stderr(`${c.red('error:')} ${message}\n`);
    if (err instanceof UsageError) {
      ctx.stderr(`Run with --help for usage.\n`);
    }
    return code;
  }
}

/** Fails unless prompts can be shown. */
export function requireInteractive(ctx: CliContext, what: string): void {
  if (!ctx.interactive) {
    throw new CliError(`${what} needs an interactive terminal.`);
  }
}

/** Pads plain text to a width. Colors must be applied after padding. */
export function pad(text: string, width: number): string {
  return text.length >= width ? text : text + ' '.repeat(width - text.length);
}

/** Renders rows as an aligned table. `style` colors a cell after padding. */
export function renderTable(
  headers: string[],
  rows: string[][],
  style?: (cell: string, row: number, col: number) => string,
): string {
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? '').length)));
  const line = (cells: string[], row: number) =>
    cells
      .map((cell, col) => {
        const padded = col === cells.length - 1 ? cell : pad(cell, widths[col] ?? 0);
        return style && row >= 0 ? style(padded, row, col) : padded;
      })
      .join('  ')
      .trimEnd();
  return [line(headers, -1), ...rows.map((r, i) => line(r, i))].join('\n') + '\n';
}

/** Rejects unexpected positional arguments. */
export function maxPositionals(args: ParsedArgs, count: number): void {
  if (args.positionals.length > count) {
    throw new UsageError(`unexpected argument: ${args.positionals[count]}`);
  }
}
