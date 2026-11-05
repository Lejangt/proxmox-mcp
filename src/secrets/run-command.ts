import { spawn } from 'node:child_process';
import { redactSecrets, sanitizeText, SecretError } from '../proxmox/errors.js';

/*
 * The only place in the code base that starts external processes for secret
 * lookups. Rules: argv array, never a shell, a minimal environment, timeout,
 * output limit and error messages that never contain stdout (the secret).
 */

export interface RunSecretCommandOptions {
  /** Executable followed by its arguments. */
  argv: readonly string[];
  /** Used in error messages, for example `bws for host "lab"`. */
  label: string;
  /** Variables set explicitly for the child (for example an access token). */
  env?: Readonly<Record<string, string>>;
  /** Names copied from the parent environment when they are set there. */
  passEnv?: readonly string[];
  /** Name prefixes copied from the parent environment (for example OP_SESSION_). */
  passEnvPrefixes?: readonly string[];
  /** Defaults to process.env. */
  parentEnv?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  maxOutputBytes?: number;
  /** Additional values that must never appear in an error message. */
  redact?: readonly string[];
}

export const DEFAULT_SECRET_TIMEOUT_MS = 30_000;
export const DEFAULT_SECRET_MAX_OUTPUT = 1024 * 1024;
const STDERR_KEEP_BYTES = 8 * 1024;
const STDERR_SHOWN_CHARS = 300;

/* Variables a CLI needs to find its binary, home, locale and temp dirs. */
const BASE_ENV_POSIX = [
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'TMPDIR',
  'XDG_CONFIG_HOME',
  'XDG_DATA_HOME',
  'XDG_CACHE_HOME',
  'XDG_RUNTIME_DIR',
];
const BASE_ENV_WIN32 = [
  'PATH',
  'PATHEXT',
  'SYSTEMROOT',
  'SYSTEMDRIVE',
  'WINDIR',
  'COMSPEC',
  'USERPROFILE',
  'USERNAME',
  'HOMEDRIVE',
  'HOMEPATH',
  'APPDATA',
  'LOCALAPPDATA',
  'PROGRAMDATA',
  'PROGRAMFILES',
  'TEMP',
  'TMP',
];

function lookup(env: NodeJS.ProcessEnv, name: string): string | undefined {
  if (process.platform !== 'win32') return env[name];
  // Windows environment names are case-insensitive.
  const key = Object.keys(env).find((k) => k.toUpperCase() === name.toUpperCase());
  return key === undefined ? undefined : env[key];
}

export function buildChildEnv(options: RunSecretCommandOptions): Record<string, string> {
  const parent = options.parentEnv ?? process.env;
  const base = process.platform === 'win32' ? BASE_ENV_WIN32 : BASE_ENV_POSIX;
  const out: Record<string, string> = {};
  for (const name of [...base, ...(options.passEnv ?? [])]) {
    const value = lookup(parent, name);
    if (value !== undefined) out[name] = value;
  }
  for (const prefix of options.passEnvPrefixes ?? []) {
    for (const [name, value] of Object.entries(parent)) {
      if (name.startsWith(prefix) && value !== undefined) out[name] = value;
    }
  }
  Object.assign(out, options.env ?? {});
  return out;
}

function stderrExcerpt(stderr: Buffer, stdout: Buffer, extra: readonly string[]): string {
  const text = stderr.toString('utf8');
  /*
   * A failing command may still have printed (part of) the secret on stdout,
   * and some tools echo their input on stderr. Every stdout line is removed
   * from the excerpt in addition to the known secrets.
   */
  const stdoutLines = stdout
    .toString('utf8')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length >= 4);
  const cleaned = sanitizeText(redactSecrets(text, [...extra, ...stdoutLines]), 4000)
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned) return '';
  return cleaned.length > STDERR_SHOWN_CHARS
    ? `${cleaned.slice(0, STDERR_SHOWN_CHARS)}...`
    : cleaned;
}

/** Runs the command and returns stdout as trimmed UTF-8. Empty output is an error. */
export function runSecretCommand(options: RunSecretCommandOptions): Promise<string> {
  const [file, ...args] = options.argv;
  const label = options.label;
  if (!file) return Promise.reject(new SecretError(`${label}: no command given`));
  const timeoutMs = options.timeoutMs ?? DEFAULT_SECRET_TIMEOUT_MS;
  const maxOutput = options.maxOutputBytes ?? DEFAULT_SECRET_MAX_OUTPUT;
  const redactValues = [...(options.redact ?? []), ...Object.values(options.env ?? {})];

  return new Promise<string>((resolve, reject) => {
    let settled = false;
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let failure: string | undefined;

    const posix = process.platform !== 'win32';
    const child = spawn(file, args, {
      shell: false,
      env: buildChildEnv(options),
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      // Own process group (and session) on POSIX: no controlling terminal to
      // prompt on, and a timeout can kill grandchildren that hold the pipes.
      detached: posix,
    });

    // Assigned below. Every caller of finish runs asynchronously after that.
    // eslint-disable-next-line prefer-const
    let timer: NodeJS.Timeout | undefined;
    const finish = (err: SecretError | undefined, value?: string) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (err) reject(err);
      else resolve(value!);
    };

    const kill = (reason: string) => {
      if (failure === undefined) failure = reason;
      try {
        if (posix && child.pid !== undefined) process.kill(-child.pid, 'SIGKILL');
        else child.kill('SIGKILL');
      } catch {
        child.kill('SIGKILL');
      }
      // Do not wait for 'close': a surviving grandchild could keep the pipes open.
      child.stdout.destroy();
      child.stderr.destroy();
      for (const chunk of stdout) chunk.fill(0);
      finish(new SecretError(`${label}: ${reason}`));
    };

    timer = setTimeout(() => kill(`timed out after ${Math.round(timeoutMs / 1000)}s`), timeoutMs);

    child.stdout.on('data', (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > maxOutput) {
        kill(`output is larger than ${maxOutput} bytes`);
        return;
      }
      stdout.push(chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      if (stderrBytes < STDERR_KEEP_BYTES) stderr.push(chunk);
      stderrBytes += chunk.length;
    });

    child.on('error', (err: NodeJS.ErrnoException) => {
      const reason =
        err.code === 'ENOENT'
          ? `command "${sanitizeText(file, 200)}" not found. Install it or set "binary" to its full path`
          : err.code === 'EACCES'
            ? `command "${sanitizeText(file, 200)}" is not executable`
            : `could not start "${sanitizeText(file, 200)}" (${err.code ?? 'error'})`;
      finish(new SecretError(`${label}: ${reason}`));
    });

    child.on('close', (code, signal) => {
      if (failure !== undefined) return;
      const out = Buffer.concat(stdout);
      if (code !== 0) {
        const excerpt = stderrExcerpt(Buffer.concat(stderr), out, redactValues);
        out.fill(0);
        const status =
          code === null ? `was killed by ${signal ?? 'a signal'}` : `exited with code ${code}`;
        finish(new SecretError(`${label}: command ${status}${excerpt ? `: ${excerpt}` : ''}`));
        return;
      }
      const value = out.toString('utf8').trim();
      out.fill(0);
      if (value === '') {
        finish(new SecretError(`${label}: command printed nothing`));
        return;
      }
      finish(undefined, value);
    });
  });
}
