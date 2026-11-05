import { homedir } from 'node:os';
import path from 'node:path';

export const APP_DIR_NAME = 'proxmox-ve-mcp';
export const CONFIG_FILE_NAME = 'config.yaml';
export const CONFIG_ENV_VAR = 'PROXMOX_MCP_CONFIG';

export interface PathOptions {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  home?: string;
}

/** Expands a leading `~` (alone or followed by a separator) to the home directory. */
export function expandHome(value: string, home: string = homedir()): string {
  if (value === '~') return home;
  if (value.startsWith('~/') || value.startsWith('~\\')) return path.join(home, value.slice(2));
  return value;
}

/** Directory that holds the settings file by default. */
export function defaultConfigDir(options: PathOptions = {}): string {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const home = options.home ?? homedir();
  if (platform === 'win32') {
    const appData = env.APPDATA;
    const base =
      appData && path.win32.isAbsolute(appData)
        ? appData
        : path.win32.join(home, 'AppData', 'Roaming');
    return path.win32.join(base, APP_DIR_NAME);
  }
  // The XDG spec says relative values must be ignored.
  const xdg = env.XDG_CONFIG_HOME;
  const base = xdg && path.posix.isAbsolute(xdg) ? xdg : path.posix.join(home, '.config');
  return path.posix.join(base, APP_DIR_NAME);
}

export function defaultConfigPath(options: PathOptions = {}): string {
  const platform = options.platform ?? process.platform;
  const join = platform === 'win32' ? path.win32.join : path.posix.join;
  return join(defaultConfigDir(options), CONFIG_FILE_NAME);
}

export interface ResolvedConfigPath {
  path: string;
  /** True when the path came from --config or PROXMOX_MCP_CONFIG. */
  explicit: boolean;
}

/**
 * Resolves the settings file path: `--config` (passed as `configPath`) wins
 * over PROXMOX_MCP_CONFIG, which wins over the platform default.
 */
export function resolveConfigPath(
  options: PathOptions & { configPath?: string } = {},
): ResolvedConfigPath {
  const env = options.env ?? process.env;
  const home = options.home ?? homedir();
  const explicit = options.configPath ?? (env[CONFIG_ENV_VAR] || undefined);
  if (explicit !== undefined && explicit !== '') {
    return { path: path.resolve(expandHome(explicit, home)), explicit: true };
  }
  return { path: defaultConfigPath(options), explicit: false };
}
