import { Console } from 'node:console';

/**
 * Console methods that write to stdout. In serve mode stdout carries only
 * MCP protocol messages, so a stray call from this code or a dependency
 * would corrupt the stream. warn, error and assert already use stderr.
 */
export const STDOUT_CONSOLE_METHODS = [
  'log',
  'info',
  'debug',
  'dir',
  'dirxml',
  'table',
  'trace',
  'group',
  'groupCollapsed',
  'groupEnd',
  'count',
  'countReset',
  'time',
  'timeEnd',
  'timeLog',
] as const;

/**
 * Points every stdout writing method of `target` to a console that writes
 * both of its streams to `stream` (stderr by default). Group indentation,
 * counters and timers keep working because they live in that console.
 */
export function redirectConsole(
  target: Console = console,
  stream: NodeJS.WritableStream = process.stderr,
): void {
  const replacement = new Console({ stdout: stream, stderr: stream });
  const writable = target as unknown as Record<string, unknown>;
  const source = replacement as unknown as Record<string, (...args: unknown[]) => void>;
  for (const method of STDOUT_CONSOLE_METHODS) {
    const fn = source[method];
    if (typeof fn === 'function') writable[method] = fn.bind(replacement);
  }
}
