import { rm } from 'node:fs/promises';
import path from 'node:path';
import { formatIssues, hostSchema } from '../config/schema.js';
import type { HostSettings, Settings } from '../config/types.js';
import { removeHostFromDocument, writeSettingsFile } from '../config/write.js';
import type { SecretRef } from '../secrets/types.js';
import {
  maxPositionals,
  renderTable,
  requireInteractive,
  runCommand,
  type ContextInput,
} from './common.js';
import { checkHost } from './connection.js';
import type { CliContext } from './context.js';
import { describeHost, describeSecretRef, tlsMode } from './describe.js';
import { CliError, UsageError } from './errors.js';
import {
  existingSecret,
  promptNewHost,
  promptSecret,
  promptTls,
  promptTokenId,
  promptUrl,
  runChecks,
  saveHost,
  type HostDraft,
  type SecretChoice,
} from './host-wizard.js';
import { KEYRING_SERVICE } from './keyring.js';
import { renderHostReport } from './report.js';
import {
  configDir,
  configLocation,
  loadForCli,
  readConfigText,
  requireConfigText,
  validateText,
  type ConfigLocation,
} from './settings-file.js';

export interface HostRow {
  alias: string;
  url: string;
  readOnly: string;
  tls: string;
  secret: string;
  default: boolean;
  description?: string;
}

export function hostRows(settings: Settings): HostRow[] {
  const aliases = Object.keys(settings.hosts);
  const def = settings.defaultHost ?? (aliases.length === 1 ? aliases[0] : undefined);
  return aliases.map((alias) => {
    const host = settings.hosts[alias]!;
    const row: HostRow = {
      alias,
      url: host.url,
      readOnly: settings.readOnly ? 'yes (global)' : host.readOnly ? 'yes' : 'no',
      tls: tlsMode(host.tls),
      secret: describeSecretRef(host.tokenSecret, alias),
      default: alias === def,
    };
    if (host.description !== undefined) row.description = host.description;
    return row;
  });
}

function keyringTarget(
  ref: SecretRef,
  alias: string,
): { service: string; account: string } | undefined {
  if (ref.source !== 'keyring') return undefined;
  return { service: ref.service ?? KEYRING_SERVICE, account: ref.account ?? alias };
}

/** CA file written by setup for this alias, removed together with the host. */
export function managedCaFile(location: ConfigLocation, alias: string): string {
  return path.join(configDir(location), 'ca', `${alias}.pem`);
}

async function loadFile(ctx: CliContext): Promise<{
  location: ConfigLocation;
  text: string;
  settings: Settings;
}> {
  const location = configLocation(ctx);
  const text = await requireConfigText(location.path);
  const settings = validateText(text, await ctx.catalog(), `Settings file ${location.path}`);
  return { location, text, settings };
}

async function pickAlias(
  ctx: CliContext,
  settings: Settings,
  given: string | undefined,
  verb: string,
): Promise<string> {
  const aliases = Object.keys(settings.hosts);
  if (given !== undefined) {
    if (!(given in settings.hosts)) {
      throw new CliError(
        `Unknown host "${given.slice(0, 40)}". Known hosts: ${aliases.join(', ') || 'none'}`,
      );
    }
    return given;
  }
  if (aliases.length === 0)
    throw new CliError('No hosts are configured. Run proxmox-ve-mcp setup.');
  if (aliases.length === 1) return aliases[0]!;
  if (!ctx.interactive) throw new UsageError(`name the host to ${verb}`);
  return ctx.prompter.select({
    message: `Which host do you want to ${verb}?`,
    options: aliases.map((a) => ({ value: a, label: a, hint: settings.hosts[a]!.url })),
  });
}

// ---------------------------------------------------------------------------

async function cmdList(ctx: CliContext, json: boolean): Promise<number> {
  const loaded = await loadForCli(ctx);
  const rows = hostRows(loaded.settings);
  if (json) {
    ctx.stdout(`${JSON.stringify(rows, null, 2)}\n`);
    return 0;
  }
  const c = ctx.color;
  ctx.stderr(`${c.dim(`Settings: ${loaded.path ?? 'environment (PROXMOX_URL)'}`)}\n\n`);
  if (rows.length === 0) {
    ctx.stdout('No hosts are configured. Add one with: proxmox-ve-mcp host add\n');
    return 0;
  }
  ctx.stdout(
    renderTable(
      ['ALIAS', 'URL', 'READ-ONLY', 'TLS', 'SECRET', 'DEFAULT'],
      rows.map((r) => [r.alias, r.url, r.readOnly, r.tls, r.secret, r.default ? 'yes' : '']),
      (cell, _row, col) =>
        col === 0 ? c.bold(cell) : col === 3 && cell.trim() === 'off' ? c.red(cell) : cell,
    ),
  );
  return 0;
}

async function cmdAdd(ctx: CliContext): Promise<number> {
  requireInteractive(ctx, 'host add');
  const location = configLocation(ctx);
  const text = await readConfigText(location.path);
  const settings =
    text === undefined
      ? undefined
      : validateText(text, await ctx.catalog(), `Settings file ${location.path}`);
  const p = ctx.prompter;
  p.intro('proxmox-ve-mcp host add');
  const aliases = new Set(Object.keys(settings?.hosts ?? {}));
  const draft = await promptNewHost(ctx, {
    location,
    existingAliases: aliases,
    keyringAvailable: await ctx.keyring.available(),
  });
  let makeDefault = false;
  if (aliases.size > 0) {
    makeDefault = await p.confirm({
      message: `Make "${draft.alias}" the default host?`,
      initialValue: settings?.defaultHost === undefined,
    });
  }
  const saved = await saveHost(ctx, location, draft, { makeDefault });
  for (const entry of saved.keyringStored) p.success(`Stored the ${entry} in the OS keychain.`);
  p.outro(`Host "${draft.alias}" saved to ${saved.path}`);
  return 0;
}

async function cmdEdit(ctx: CliContext, given: string | undefined): Promise<number> {
  requireInteractive(ctx, 'host edit');
  const { location, settings } = await loadFile(ctx);
  const alias = await pickAlias(ctx, settings, given, 'edit');
  const original = settings.hosts[alias]!;
  const p = ctx.prompter;
  p.intro(`proxmox-ve-mcp host edit ${alias}`);

  const host: HostSettings = structuredClone(original);
  let secret: SecretChoice = existingSecret(original.tokenSecret, ctx.env);
  let caFile: HostDraft['caFile'];
  let keyringAvailable: boolean | undefined;

  for (;;) {
    p.note(describeHost(alias, host).join('\n'), alias);
    const field = await p.select({
      message: 'What do you want to change?',
      options: [
        { value: 'url', label: 'URL' },
        { value: 'tokenId', label: 'Token ID' },
        { value: 'secret', label: 'Secret source' },
        { value: 'tls', label: 'TLS (pin, CA file, verification)' },
        { value: 'readOnly', label: `Read-only (now ${host.readOnly ? 'yes' : 'no'})` },
        { value: 'description', label: 'Description' },
        { value: 'timeout', label: `Timeout (now ${host.timeoutSeconds}s)` },
        { value: 'test', label: 'Test the connection' },
        { value: 'save', label: 'Save and exit' },
        { value: 'cancel', label: 'Exit without saving' },
      ],
    });
    if (field === 'cancel') {
      p.outro('Nothing was changed.');
      return 0;
    }
    if (field === 'save') break;
    if (field === 'url') {
      const url = await promptUrl(p, host.url);
      const changed = url !== host.url;
      host.url = url;
      if (
        changed &&
        (await p.confirm({ message: 'Check the TLS certificate of the new URL now?' }))
      ) {
        const tls = await promptTls(ctx, host.url, alias, location);
        if (tls !== 'url') {
          host.tls = tls.tls;
          caFile = tls.caFile;
        }
      }
    }
    if (field === 'tokenId') host.tokenId = (await promptTokenId(p, host.tokenId)).trim();
    if (field === 'secret') {
      keyringAvailable ??= await ctx.keyring.available();
      secret = await promptSecret(ctx, alias, keyringAvailable);
      host.tokenSecret = secret.ref;
    }
    if (field === 'tls') {
      const tls = await promptTls(ctx, host.url, alias, location);
      if (tls !== 'url') {
        host.tls = tls.tls;
        caFile = tls.caFile;
      }
    }
    if (field === 'readOnly') {
      host.readOnly = await p.confirm({
        message: 'Make this host read-only?',
        initialValue: host.readOnly,
      });
    }
    if (field === 'description') {
      const description = await p.text({
        message: 'Description (empty removes it)',
        defaultValue: '',
        ...(host.description !== undefined ? { initialValue: host.description } : {}),
      });
      if (description) host.description = description;
      else delete host.description;
    }
    if (field === 'timeout') {
      const value = await p.text({
        message: 'Timeout per request in seconds (1 to 3600)',
        initialValue: String(host.timeoutSeconds),
        validate: (v) =>
          /^\d+$/.test(v.trim()) && Number(v) >= 1 && Number(v) <= 3600
            ? undefined
            : 'Enter a whole number from 1 to 3600.',
      });
      host.timeoutSeconds = Number(value);
    }
    if (field === 'test') await runChecks(ctx, alias, host, secret);
  }

  const parsed = hostSchema.safeParse(host);
  if (!parsed.success)
    throw new CliError(`host "${alias}" is invalid:\n${formatIssues(parsed.error)}`);
  const saved = await saveHost(ctx, location, {
    alias,
    host: parsed.data,
    secret,
    ...(caFile ? { caFile } : {}),
  });
  for (const entry of saved.keyringStored) p.success(`Stored the ${entry} in the OS keychain.`);

  const oldTarget = keyringTarget(original.tokenSecret, alias);
  const newTarget = keyringTarget(host.tokenSecret, alias);
  if (
    oldTarget &&
    (!newTarget ||
      newTarget.service !== oldTarget.service ||
      newTarget.account !== oldTarget.account)
  ) {
    const remove = await p.confirm({
      message: `The old token secret is still in the OS keychain (${oldTarget.service}/${oldTarget.account}). Delete it?`,
      initialValue: false,
    });
    if (remove) await ctx.keyring.delete(oldTarget.service, oldTarget.account);
  }
  p.outro(`Host "${alias}" saved to ${saved.path}`);
  return 0;
}

export interface RemoveOptions {
  yes: boolean;
  deleteSecret: boolean;
}

async function cmdRemove(
  ctx: CliContext,
  given: string | undefined,
  options: RemoveOptions,
): Promise<number> {
  const { location, text, settings } = await loadFile(ctx);
  const alias = await pickAlias(ctx, settings, given, 'remove');
  const host = settings.hosts[alias]!;
  const p = ctx.prompter;
  if (!options.yes) {
    if (!ctx.interactive) throw new UsageError('pass --yes to remove a host without a prompt');
    const sure = await p.confirm({
      message: `Remove host "${alias}" (${host.url}) from ${location.path}?`,
      initialValue: false,
    });
    if (!sure) {
      ctx.stdout('Nothing was removed.\n');
      return 0;
    }
  }
  const target = keyringTarget(host.tokenSecret, alias);
  let deleteSecret = options.deleteSecret;
  if (target && !deleteSecret && !options.yes && ctx.interactive) {
    deleteSecret = await p.confirm({
      message: `Also delete the token secret from the OS keychain (${target.service}/${target.account})?`,
      initialValue: false,
    });
  }

  const next = removeHostFromDocument(text, alias);
  validateText(next, await ctx.catalog(), 'the new settings');
  await writeSettingsFile(location.path, next);
  ctx.stdout(`Removed host "${alias}" from ${location.path}\n`);
  if (settings.defaultHost === alias) {
    ctx.stdout('It was the default host, defaultHost was removed as well.\n');
  }

  const ca = managedCaFile(location, alias);
  if (host.tls.caFile !== undefined && path.resolve(host.tls.caFile) === ca) {
    await rm(ca, { force: true });
    ctx.stdout(`Removed the CA file ${ca}\n`);
  }
  if (target && deleteSecret) {
    try {
      const existed = await ctx.keyring.delete(target.service, target.account);
      ctx.stdout(
        existed
          ? 'Deleted the token secret from the OS keychain.\n'
          : 'There was no keychain entry to delete.\n',
      );
    } catch (err) {
      throw new CliError(
        `The host was removed, but the keychain entry could not be deleted: ${(err as Error).message}`,
      );
    }
  } else if (target) {
    ctx.stdout(
      `The token secret stays in the OS keychain (${target.service}/${target.account}).\n`,
    );
  }
  return 0;
}

async function cmdTest(ctx: CliContext, given: string | undefined): Promise<number> {
  const loaded = await loadForCli(ctx);
  const aliases = Object.keys(loaded.settings.hosts);
  if (given !== undefined && !aliases.includes(given)) {
    throw new CliError(
      `Unknown host "${given.slice(0, 40)}". Known hosts: ${aliases.join(', ') || 'none'}`,
    );
  }
  const selected = given !== undefined ? [given] : aliases;
  if (selected.length === 0)
    throw new CliError('No hosts are configured. Run proxmox-ve-mcp setup.');
  const reports = await Promise.all(
    selected.map((alias) => checkHost(alias, loaded.settings.hosts[alias]!, { env: ctx.env })),
  );
  let failed = false;
  reports.forEach((report, i) => {
    if (i > 0) ctx.stdout('\n');
    ctx.stdout(renderHostReport(report, ctx.color));
    failed ||= report.failed;
  });
  return failed ? 1 : 0;
}

const HELP = `Usage: proxmox-ve-mcp host <command> [alias] [options]

Commands:
  list                show all hosts (--json for machine readable output)
  add                 add a host interactively (certificate check, token, secret, test)
  edit [alias]        change URL, token ID, secret source, TLS, read-only or description
  remove [alias]      remove a host (--yes skips the prompt, --delete-secret also
                      deletes its OS keychain entry)
  test [alias]        test secret, certificate, connection and token permissions

Options:
  --config <path>     settings file
  -h, --help          show this help
`;

export function run(args: string[], ctx?: ContextInput): Promise<number> {
  return runCommand(
    {
      help: HELP,
      options: {
        json: { type: 'boolean' },
        yes: { type: 'boolean', short: 'y' },
        'delete-secret': { type: 'boolean' },
      },
      async run(parsed, ctx) {
        maxPositionals(parsed, 2);
        const [sub, alias] = parsed.positionals;
        switch (sub) {
          case 'list':
            maxPositionals(parsed, 1);
            return cmdList(ctx, parsed.values.json === true);
          case 'add':
            maxPositionals(parsed, 1);
            return cmdAdd(ctx);
          case 'edit':
            return cmdEdit(ctx, alias);
          case 'remove':
          case 'rm':
            return cmdRemove(ctx, alias, {
              yes: parsed.values.yes === true,
              deleteSecret: parsed.values['delete-secret'] === true,
            });
          case 'test':
            return cmdTest(ctx, alias);
          case undefined:
            throw new UsageError('name a subcommand: list, add, edit, remove or test');
          default:
            throw new UsageError(`unknown subcommand "${sub.slice(0, 40)}"`);
        }
      },
    },
    args,
    ctx,
  );
}
