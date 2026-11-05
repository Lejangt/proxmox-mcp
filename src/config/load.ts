import { constants, type Stats } from 'node:fs';
import { open, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { parseDocument } from 'yaml';
import { ConfigError } from '../proxmox/errors.js';
import type { SecretRef } from '../secrets/types.js';
import { untrustedDirProblem, untrustedFileProblem } from './file-trust.js';
import { resolveConfigPath } from './paths.js';
import {
  CATEGORY_IDS,
  type CatalogEntry,
  formatIssues,
  settingsSchema,
  type SettingsInput,
} from './schema.js';
import type { Settings } from './types.js';

export interface LoadSettingsOptions {
  /** Value of --config. */
  configPath?: string;
  env?: NodeJS.ProcessEnv;
  /**
   * Tool catalog used to reject unknown tool names in the file and in
   * PROXMOX_MCP_DISABLE. Defaults to ALL_TOOLS from src/tools/catalog.ts.
   */
  catalog?: readonly CatalogEntry[];
}

export interface LoadedSettings {
  settings: Settings;
  source: 'file' | 'env';
  path?: string;
  warnings: string[];
}

const MAX_CONFIG_BYTES = 1024 * 1024;
const ENV_HOST_ALIAS = 'default';
const SETUP_HINT = 'Run `proxmox-ve-mcp setup` to create one.';

const TRUE_VALUES = new Set(['1', 'true', 'yes', 'on']);
const FALSE_VALUES = new Set(['0', 'false', 'no', 'off', '']);

/**
 * Parses a boolean environment variable. Unknown values are an error instead
 * of being guessed, so a typo cannot turn a safety switch off.
 */
function envFlag(env: NodeJS.ProcessEnv, name: string): boolean | undefined {
  const raw = env[name];
  if (raw === undefined) return undefined;
  const value = raw.trim().toLowerCase();
  if (TRUE_VALUES.has(value)) return true;
  if (FALSE_VALUES.has(value)) return false;
  throw new ConfigError(
    `${name} must be 1 or 0 (true/false, yes/no, on/off), got an unknown value`,
  );
}

async function defaultCatalog(): Promise<readonly CatalogEntry[]> {
  const mod = await import('../tools/catalog.js');
  return mod.ALL_TOOLS;
}

/**
 * Parses and validates settings YAML. Duplicate keys, YAML errors and schema
 * violations are errors. Values are never echoed in messages because a
 * misplaced secret could be one of them.
 */
export function parseSettingsText(text: string, origin = 'settings file'): Settings {
  const doc = parseDocument(text, { prettyErrors: true, uniqueKeys: true, merge: false });
  if (doc.errors.length > 0) {
    const first = doc.errors[0]!;
    throw new ConfigError(`${origin} is not valid YAML: ${first.message.split('\n')[0]}`);
  }
  let data: unknown;
  try {
    data = doc.toJS({ maxAliasCount: 50 });
  } catch (err) {
    throw new ConfigError(`${origin} could not be read: ${(err as Error).message}`);
  }
  if (data === null || data === undefined) {
    throw new ConfigError(`${origin} is empty. ${SETUP_HINT}`);
  }
  return validateSettings(data, origin);
}

export function validateSettings(data: unknown, origin = 'settings'): Settings {
  const result = settingsSchema.safeParse(data);
  if (!result.success) {
    throw new ConfigError(`${origin} is invalid:\n${formatIssues(result.error)}`);
  }
  return result.data;
}

/** Rejects tool names that the catalog does not know or that sit in the wrong category. */
export function checkToolNames(settings: Settings, catalog: readonly CatalogEntry[]): void {
  if (catalog.length === 0) return;
  const byName = new Map(catalog.map((t) => [t.name, t]));
  const problems: string[] = [];
  for (const [category, value] of Object.entries(settings.categories)) {
    for (const name of Object.keys(value.tools)) {
      const tool = byName.get(name);
      if (!tool) problems.push(`categories.${category}.tools.${name}: unknown tool`);
      else if (tool.category !== category) {
        problems.push(
          `categories.${category}.tools.${name}: tool belongs to category "${tool.category}"`,
        );
      }
    }
  }
  if (problems.length > 0) {
    throw new ConfigError(
      `settings list tools that do not exist in this version (a typo would leave a tool enabled):\n${problems.join('\n')}`,
    );
  }
}

/**
 * Applies PROXMOX_MCP_READ_ONLY and PROXMOX_MCP_DISABLE. Both can only make
 * the settings stricter. Unknown names in PROXMOX_MCP_DISABLE are an error.
 */
export function applyEnvTightening(
  settings: Settings,
  env: NodeJS.ProcessEnv,
  catalog: readonly CatalogEntry[],
): Settings {
  const out: Settings = structuredClone(settings);
  if (envFlag(env, 'PROXMOX_MCP_READ_ONLY') === true) out.readOnly = true;
  const disable = env.PROXMOX_MCP_DISABLE;
  if (disable !== undefined) {
    const categoryIds = new Set<string>(CATEGORY_IDS);
    const byName = new Map(catalog.map((t) => [t.name, t]));
    const unknown: string[] = [];
    for (const raw of disable.split(',')) {
      const name = raw.trim();
      if (name === '') continue;
      if (categoryIds.has(name)) {
        const current = out.categories[name] ?? { enabled: true, tools: {} };
        out.categories[name] = { ...current, enabled: false };
        continue;
      }
      const tool = byName.get(name);
      if (tool) {
        const current = out.categories[tool.category] ?? { enabled: true, tools: {} };
        out.categories[tool.category] = { ...current, tools: { ...current.tools, [name]: false } };
        continue;
      }
      unknown.push(name);
    }
    if (unknown.length > 0) {
      throw new ConfigError(
        `PROXMOX_MCP_DISABLE names unknown categories or tools: ${unknown
          .map((n) => JSON.stringify(n.slice(0, 64)))
          .join(', ')}`,
      );
    }
  }
  return out;
}

/** Builds settings for env-only mode with a single host named "default". */
export function settingsFromEnv(env: NodeJS.ProcessEnv): Settings {
  const url = env.PROXMOX_URL;
  const tokenId = env.PROXMOX_TOKEN_ID;
  if (!url || !tokenId) {
    throw new ConfigError('Env-only mode needs PROXMOX_URL and PROXMOX_TOKEN_ID.');
  }
  const hasSecret = env.PROXMOX_TOKEN_SECRET !== undefined && env.PROXMOX_TOKEN_SECRET !== '';
  const hasSecretFile =
    env.PROXMOX_TOKEN_SECRET_FILE !== undefined && env.PROXMOX_TOKEN_SECRET_FILE !== '';
  if (hasSecret && hasSecretFile) {
    throw new ConfigError(
      'Set either PROXMOX_TOKEN_SECRET or PROXMOX_TOKEN_SECRET_FILE, not both.',
    );
  }
  if (!hasSecret && !hasSecretFile) {
    throw new ConfigError('Env-only mode needs PROXMOX_TOKEN_SECRET or PROXMOX_TOKEN_SECRET_FILE.');
  }
  // The plaintext secret stays in the environment and is referenced, it is
  // never copied into the settings object.
  const tokenSecret: SecretRef = hasSecret
    ? { source: 'env', name: 'PROXMOX_TOKEN_SECRET' }
    : { source: 'file', path: env.PROXMOX_TOKEN_SECRET_FILE! };
  const tls: NonNullable<SettingsInput['hosts']>[string]['tls'] = {};
  const verify = envFlag(env, 'PROXMOX_TLS_VERIFY');
  if (verify === false) tls.verify = false;
  if (env.PROXMOX_CA_FILE) tls.caFile = env.PROXMOX_CA_FILE;
  if (env.PROXMOX_TLS_FINGERPRINT) tls.fingerprint = env.PROXMOX_TLS_FINGERPRINT;
  const input: SettingsInput = {
    version: 1,
    defaultHost: ENV_HOST_ALIAS,
    hosts: {
      [ENV_HOST_ALIAS]: {
        url,
        tokenId,
        tokenSecret,
        tls,
        readOnly: envFlag(env, 'PROXMOX_READ_ONLY') === true,
      },
    },
  };
  return validateSettings(input, 'environment configuration');
}

/**
 * Refuses directories through which another user could replace the
 * settings file: the directory as configured and, for a symlink, the
 * directory of the real file.
 */
async function checkSettingsDirs(file: string): Promise<void> {
  const dirs = new Set([path.dirname(path.resolve(file))]);
  try {
    dirs.add(path.dirname(await realpath(file)));
  } catch {
    // The file itself is opened and checked below, this only adds a directory.
  }
  for (const dir of dirs) {
    let info: Stats;
    try {
      info = await stat(dir);
    } catch {
      continue;
    }
    const problem = untrustedDirProblem('settings file', {
      path: dir,
      mode: info.mode,
      uid: info.uid,
    });
    if (problem) throw new ConfigError(problem);
  }
}

/**
 * Reads the settings file through one handle, so the checks apply to the
 * content that is parsed. On POSIX a file that is writable by group or
 * others, or owned by another user than the server user or root, is
 * refused. Readable by group or others only gives a warning, the file holds
 * no secrets.
 */
async function readSettingsFile(file: string, warnings: string[]): Promise<string> {
  const posix = process.platform !== 'win32';
  if (posix) await checkSettingsDirs(file);
  let handle;
  try {
    handle = await open(file, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));
  } catch (err) {
    throw new ConfigError(
      `Cannot read settings file ${file}: ${(err as NodeJS.ErrnoException).code ?? 'error'}`,
    );
  }
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new ConfigError(`Settings path ${file} is not a file.`);
    if (info.size > MAX_CONFIG_BYTES) {
      throw new ConfigError(`Settings file ${file} is larger than 1 MiB.`);
    }
    if (posix) {
      const problem = untrustedFileProblem('Settings file', {
        path: file,
        mode: info.mode,
        uid: info.uid,
      });
      if (problem) throw new ConfigError(problem);
      if ((info.mode & 0o044) !== 0) {
        warnings.push(
          `Settings file ${file} is readable by group or others (mode ${(info.mode & 0o777).toString(8)}). Run: chmod 600 ${file}`,
        );
      }
    }
    return await handle.readFile('utf8');
  } finally {
    await handle.close();
  }
}

function isMissing(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException).code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}

/**
 * Loads the settings file (or env-only settings), validates it and applies
 * the env tightening switches.
 */
export async function loadSettings(options: LoadSettingsOptions = {}): Promise<LoadedSettings> {
  const env = options.env ?? process.env;
  const warnings: string[] = [];
  const resolved = resolveConfigPath({
    env,
    ...(options.configPath !== undefined ? { configPath: options.configPath } : {}),
  });

  let fileStat: Stats | undefined;
  try {
    fileStat = await stat(resolved.path);
  } catch (err) {
    if (!isMissing(err)) {
      throw new ConfigError(
        `Cannot read settings file ${resolved.path}: ${(err as NodeJS.ErrnoException).code ?? 'error'}`,
      );
    }
  }

  let settings: Settings;
  let source: 'file' | 'env';
  if (fileStat) {
    if (!fileStat.isFile()) throw new ConfigError(`Settings path ${resolved.path} is not a file.`);
    if (env.PROXMOX_URL) {
      warnings.push(
        `Both a settings file (${resolved.path}) and PROXMOX_URL are present. The settings file wins, PROXMOX_* host variables are ignored.`,
      );
    }
    const text = await readSettingsFile(resolved.path, warnings);
    settings = parseSettingsText(text, `Settings file ${resolved.path}`);
    source = 'file';
  } else if (resolved.explicit) {
    throw new ConfigError(`Settings file ${resolved.path} does not exist. ${SETUP_HINT}`);
  } else if (env.PROXMOX_URL) {
    settings = settingsFromEnv(env);
    source = 'env';
  } else {
    throw new ConfigError(
      `No settings found: ${resolved.path} does not exist and PROXMOX_URL is not set. ${SETUP_HINT} ` +
        'Alternatively set PROXMOX_URL, PROXMOX_TOKEN_ID and PROXMOX_TOKEN_SECRET_FILE (or PROXMOX_TOKEN_SECRET).',
    );
  }

  const catalog = options.catalog ?? (await defaultCatalog());
  checkToolNames(settings, catalog);
  settings = applyEnvTightening(settings, env, catalog);

  for (const [alias, host] of Object.entries(settings.hosts)) {
    if (!host.tls.verify) {
      warnings.push(
        `Host "${alias}": TLS verification is disabled. Anyone on the network path can read the API token. Use tls.fingerprint or tls.caFile instead.`,
      );
    }
  }
  if (Object.keys(settings.hosts).length === 0) {
    warnings.push(`No hosts are configured. ${SETUP_HINT}`);
  }

  return {
    settings,
    source,
    ...(source === 'file' ? { path: resolved.path } : {}),
    warnings,
  };
}
