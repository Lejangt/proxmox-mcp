import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import pc from 'picocolors';
import type { CatalogEntry } from '../../src/config/schema.js';
import type { CliContext } from '../../src/cli/context.js';
import type { KeyringOps } from '../../src/cli/keyring.js';
import type { Prompter, Spinner } from '../../src/cli/prompts.js';

export const TEST_CATALOG: CatalogEntry[] = [
  { name: 'pve_hosts_list', category: 'core', access: 'read', title: 'List configured hosts' },
  { name: 'pve_guest_list', category: 'guests', access: 'read', title: 'List guests' },
  { name: 'pve_guest_power', category: 'guests', access: 'write', title: 'Power actions' },
  { name: 'pve_guest_delete', category: 'guests', access: 'destructive', title: 'Delete a guest' },
];

export interface FakeKeyring extends KeyringOps {
  entries: Map<string, string>;
  isAvailable: boolean;
}

export function fakeKeyring(available = true): FakeKeyring {
  const entries = new Map<string, string>();
  return {
    entries,
    isAvailable: available,
    async available() {
      return this.isAvailable;
    },
    async set(service, account, value) {
      entries.set(`${service}/${account}`, value);
    },
    async delete(service, account) {
      return entries.delete(`${service}/${account}`);
    },
  };
}

/** Prompter that answers from a queue and fails on any unexpected prompt. */
export function scriptedPrompter(answers: unknown[]): Prompter & { messages: string[] } {
  const messages: string[] = [];
  const next = (kind: string, message: string) => {
    messages.push(`${kind}: ${message}`);
    if (answers.length === 0) throw new Error(`unexpected prompt (${kind}): ${message}`);
    return answers.shift();
  };
  const spinner = (): Spinner => ({
    start: (m) => messages.push(`spin: ${m}`),
    stop: (m) => messages.push(`spin ok: ${m}`),
    error: (m) => messages.push(`spin error: ${m}`),
  });
  return {
    messages,
    intro: (m) => messages.push(`intro: ${m}`),
    outro: (m) => messages.push(`outro: ${m}`),
    note: (m, t) => messages.push(`note ${t ?? ''}: ${m}`),
    info: (m) => messages.push(`info: ${m}`),
    success: (m) => messages.push(`success: ${m}`),
    warn: (m) => messages.push(`warn: ${m}`),
    error: (m) => messages.push(`error: ${m}`),
    step: (m) => messages.push(`step: ${m}`),
    text: async (o) => String(next('text', o.message)),
    password: async (o) => String(next('password', o.message)),
    select: async <T>(o: { message: string }) => next('select', o.message) as T,
    confirm: async (o) => Boolean(next('confirm', o.message)),
    spinner,
  };
}

export interface TestCli {
  ctx: CliContext;
  out(): string;
  err(): string;
  keyring: FakeKeyring;
  prompter: ReturnType<typeof scriptedPrompter>;
}

export function testCli(
  options: {
    configPath?: string;
    env?: NodeJS.ProcessEnv;
    interactive?: boolean;
    answers?: unknown[];
    stdin?: string | (Readable & { isTTY?: boolean });
    catalog?: readonly CatalogEntry[];
    keyring?: FakeKeyring;
    platform?: NodeJS.Platform;
    home?: string;
  } = {},
): TestCli {
  let out = '';
  let err = '';
  const keyring = options.keyring ?? fakeKeyring();
  const prompter = scriptedPrompter(options.answers ?? []);
  const stdin =
    typeof options.stdin === 'string'
      ? Readable.from([Buffer.from(options.stdin)])
      : (options.stdin ?? Readable.from([]));
  const ctx: CliContext = {
    env: options.env ?? {},
    platform: options.platform ?? 'linux',
    home: options.home ?? '/home/test',
    stdout: (t) => {
      out += t;
    },
    stderr: (t) => {
      err += t;
    },
    stdin,
    interactive: options.interactive ?? false,
    color: pc.createColors(false),
    prompter,
    keyring,
    catalog: async () => options.catalog ?? TEST_CATALOG,
    ...(options.configPath !== undefined ? { configPath: options.configPath } : {}),
  };
  return { ctx, out: () => out, err: () => err, keyring, prompter };
}

export function tempDir(): { dir: string; file(name: string): string; cleanup(): void } {
  const dir = mkdtempSync(path.join(tmpdir(), 'pve-mcp-cli-'));
  return {
    dir,
    file: (name) => path.join(dir, name),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}
