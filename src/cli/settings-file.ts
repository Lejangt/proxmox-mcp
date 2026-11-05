import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import {
  checkToolNames,
  loadSettings,
  parseSettingsText,
  type LoadedSettings,
} from '../config/load.js';
import { defaultConfigPath, resolveConfigPath } from '../config/paths.js';
import type { CatalogEntry } from '../config/schema.js';
import type { Settings } from '../config/types.js';
import { writeSettingsFile } from '../config/write.js';
import { CliError } from './errors.js';
import type { CliContext } from './context.js';

const MAX_CONFIG_BYTES = 1024 * 1024;

export interface ConfigLocation {
  path: string;
  /** True when the path differs from the platform default. */
  custom: boolean;
}

export function configLocation(ctx: CliContext): ConfigLocation {
  const resolved = resolveConfigPath({
    env: ctx.env,
    platform: ctx.platform,
    home: ctx.home,
    ...(ctx.configPath !== undefined ? { configPath: ctx.configPath } : {}),
  });
  const def = defaultConfigPath({ env: ctx.env, platform: ctx.platform, home: ctx.home });
  return { path: resolved.path, custom: resolved.path !== def };
}

/** Directory of the settings file, used for files managed next to it (ca/). */
export function configDir(location: ConfigLocation): string {
  return path.dirname(location.path);
}

/** Reads the settings file. Returns undefined when it does not exist. */
export async function readConfigText(filePath: string): Promise<string | undefined> {
  let info;
  try {
    info = await stat(filePath);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return undefined;
    throw new CliError(`Cannot read ${filePath} (${code ?? 'error'})`);
  }
  if (!info.isFile()) throw new CliError(`${filePath} is not a file`);
  if (info.size > MAX_CONFIG_BYTES) throw new CliError(`${filePath} is larger than 1 MiB`);
  return readFile(filePath, 'utf8');
}

export async function requireConfigText(filePath: string): Promise<string> {
  const text = await readConfigText(filePath);
  if (text === undefined) {
    throw new CliError(
      `No settings file at ${filePath}. Run \`proxmox-ve-mcp setup\` to create one.`,
    );
  }
  return text;
}

/** Parses and validates settings text against the schema and the tool catalog. */
export function validateText(
  text: string,
  catalog: readonly CatalogEntry[],
  origin = 'settings file',
): Settings {
  const settings = parseSettingsText(text, origin);
  checkToolNames(settings, catalog);
  return settings;
}

/** Validates first, then writes atomically with mode 0600. Never writes an invalid file. */
export async function writeValidated(
  filePath: string,
  text: string,
  catalog: readonly CatalogEntry[],
): Promise<Settings> {
  const settings = validateText(text, catalog, 'the new settings');
  await writeSettingsFile(filePath, text);
  return settings;
}

/** Loads settings like the server does (file or env-only mode, env tightening applied). */
export async function loadForCli(ctx: CliContext): Promise<LoadedSettings> {
  return loadSettings({
    env: ctx.env,
    catalog: await ctx.catalog(),
    ...(ctx.configPath !== undefined ? { configPath: ctx.configPath } : {}),
  });
}
