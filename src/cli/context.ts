import { homedir } from 'node:os';
import type { Readable } from 'node:stream';
import pc from 'picocolors';
import type { CatalogEntry } from '../config/schema.js';
import { createClackPrompter, type Prompter } from './prompts.js';
import { systemKeyring, type KeyringOps } from './keyring.js';

export type Colors = ReturnType<typeof pc.createColors>;

/**
 * Everything a command touches outside its own logic. Tests build one with
 * `createContext({ ... })` and replace streams, prompts, keyring and env.
 */
export interface CliContext {
  /** Value of --config, when given. */
  configPath?: string;
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  home: string;
  stdout(text: string): void;
  stderr(text: string): void;
  stdin: Readable & { isTTY?: boolean };
  /** True when stdin and stdout are terminals, so prompts can be shown. */
  interactive: boolean;
  color: Colors;
  prompter: Prompter;
  keyring: KeyringOps;
  catalog(): Promise<readonly CatalogEntry[]>;
}

async function defaultCatalog(): Promise<readonly CatalogEntry[]> {
  return (await import('../tools/catalog.js')).ALL_TOOLS;
}

function colorEnabled(env: NodeJS.ProcessEnv, isTTY: boolean): boolean {
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== '') return false;
  if (env.FORCE_COLOR !== undefined && env.FORCE_COLOR !== '0') return true;
  return isTTY && env.TERM !== 'dumb';
}

export function createContext(overrides: Partial<CliContext> = {}): CliContext {
  const env = overrides.env ?? process.env;
  const interactive = overrides.interactive ?? Boolean(process.stdin.isTTY && process.stdout.isTTY);
  return {
    env,
    platform: process.platform,
    home: homedir(),
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
    stdin: process.stdin,
    interactive,
    color: pc.createColors(colorEnabled(env, Boolean(process.stdout.isTTY))),
    prompter: overrides.prompter ?? createClackPrompter(),
    keyring: systemKeyring,
    catalog: defaultCatalog,
    ...overrides,
  };
}
