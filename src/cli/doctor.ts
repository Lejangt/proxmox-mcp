import type { LoadedSettings } from '../config/load.js';
import { maxPositionals, runCommand, type ContextInput } from './common.js';
import { checkHost, type CheckHostOptions, type CheckLine, type HostReport } from './connection.js';
import type { CliContext } from './context.js';
import { CliError, messageOf } from './errors.js';
import { renderHostReport, renderLine } from './report.js';
import { configLocation, loadForCli } from './settings-file.js';
import { computeToolStates } from './tools.js';

export interface DoctorResult {
  settings: CheckLine[];
  hosts: HostReport[];
  failures: number;
  warnings: number;
}

/** Runs every check. Never resolves a secret into the output. */
export async function runDoctor(
  ctx: CliContext,
  only?: string,
  options: Omit<CheckHostOptions, 'env'> = {},
): Promise<DoctorResult> {
  const lines: CheckLine[] = [];
  let loaded: LoadedSettings;
  try {
    loaded = await loadForCli(ctx);
  } catch (err) {
    lines.push({ status: 'fail', label: 'Settings', detail: messageOf(err) });
    return { settings: lines, hosts: [], failures: 1, warnings: 0 };
  }
  const settings = loaded.settings;
  lines.push({
    status: 'ok',
    label: 'Settings',
    detail:
      loaded.source === 'file'
        ? `${loaded.path} is valid`
        : 'environment variables (env-only mode, no settings file)',
  });
  for (const warning of loaded.warnings) {
    // Disabled TLS is reported per host below.
    if (/TLS verification is disabled/.test(warning)) continue;
    lines.push({ status: 'warn', label: 'Settings', detail: warning });
  }
  if (loaded.source === 'env' && ctx.env.PROXMOX_TOKEN_SECRET) {
    lines.push({
      status: 'warn',
      label: 'Secret',
      detail:
        'PROXMOX_TOKEN_SECRET holds the token secret in plain text in the environment. ' +
        'Prefer PROXMOX_TOKEN_SECRET_FILE or a settings file with a secret store.',
    });
  }
  if (settings.readOnly) {
    lines.push({ status: 'ok', label: 'Mode', detail: 'global read-only, only read tools exist' });
  }

  const states = computeToolStates(settings, await ctx.catalog());
  lines.push({
    status: 'ok',
    label: 'Tools',
    detail: `${states.filter((s) => s.active).length} of ${states.length} active (details: proxmox-ve-mcp tools)`,
  });

  const usesKeyring = Object.values(settings.hosts).some(
    (h) =>
      h.tokenSecret.source === 'keyring' ||
      (h.tokenSecret.source === 'bws' && h.tokenSecret.accessToken?.source === 'keyring') ||
      (h.tokenSecret.source === 'vault' && h.tokenSecret.token?.source === 'keyring'),
  );
  if (usesKeyring) {
    const ok = await ctx.keyring.available();
    lines.push(
      ok
        ? { status: 'ok', label: 'Keychain', detail: 'OS keychain is available' }
        : {
            status: 'fail',
            label: 'Keychain',
            detail:
              'a host uses the OS keychain, but it is not available (optional package @napi-rs/keyring or no keychain service)',
          },
    );
  }

  const aliases = Object.keys(settings.hosts);
  if (only !== undefined && !aliases.includes(only)) {
    throw new CliError(
      `Unknown host "${only.slice(0, 40)}". Known hosts: ${aliases.join(', ') || 'none'}`,
    );
  }
  if (aliases.length === 0) {
    lines.push({
      status: 'fail',
      label: 'Hosts',
      detail: 'no hosts are configured, add one with proxmox-ve-mcp host add',
    });
  }
  const selected = only !== undefined ? [only] : aliases;
  const hosts = await Promise.all(
    selected.map((alias) => checkHost(alias, settings.hosts[alias]!, { ...options, env: ctx.env })),
  );
  const all = [...lines, ...hosts.flatMap((h) => h.lines)];
  return {
    settings: lines,
    hosts,
    failures: all.filter((l) => l.status === 'fail').length,
    warnings: all.filter((l) => l.status === 'warn').length,
  };
}

const HELP = `Usage: proxmox-ve-mcp doctor [alias] [--config <path>]

Checks the settings and, for every host (or only [alias]): that the secret can
be read (the value is never shown), the TLS settings and the server
certificate, the connection, the Proxmox version and the token permissions.
Exits with 1 when a check fails.

Options:
  --config <path>   settings file
  -h, --help        show this help
`;

export function run(args: string[], ctx?: ContextInput): Promise<number> {
  return runCommand(
    {
      help: HELP,
      async run(parsed, ctx) {
        maxPositionals(parsed, 1);
        const c = ctx.color;
        const result = await runDoctor(ctx, parsed.positionals[0]);
        ctx.stdout(`${c.bold('proxmox-ve-mcp doctor')}  ${c.dim(configLocation(ctx).path)}\n\n`);
        for (const line of result.settings) ctx.stdout(renderLine(line, c));
        for (const report of result.hosts) ctx.stdout(`\n${renderHostReport(report, c)}`);
        const summary =
          result.failures === 0
            ? c.green(
                `All checks passed${result.warnings ? `, ${result.warnings} warning${result.warnings === 1 ? '' : 's'}` : ''}.`,
              )
            : c.red(
                `${result.failures} check${result.failures === 1 ? '' : 's'} failed${result.warnings ? `, ${result.warnings} warning${result.warnings === 1 ? '' : 's'}` : ''}.`,
              );
        ctx.stdout(`\n${summary}\n`);
        return result.failures === 0 ? 0 : 1;
      },
    },
    args,
    ctx,
  );
}
