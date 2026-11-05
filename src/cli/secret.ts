import type { Readable } from 'node:stream';
import { upsertHostInDocument } from '../config/write.js';
import { registerSecret } from '../proxmox/errors.js';
import type { SecretRef } from '../secrets/types.js';
import { runCommand, type ContextInput } from './common.js';
import type { CliContext } from './context.js';
import { describeSecretRef } from './describe.js';
import { CliError, UsageError } from './errors.js';
import { KEYRING_SERVICE } from './keyring.js';
import {
  configLocation,
  requireConfigText,
  validateText,
  writeValidated,
} from './settings-file.js';

const MAX_LINE_BYTES = 4096;
const SECRET_VALUE_PATTERN = /^[\x21-\x7e]{1,512}$/;

/**
 * Reads the first line of a stream (without the line break). Stops reading
 * at the first newline and fails above 4 KiB, so a wrong pipe cannot fill
 * memory.
 */
export async function readFirstLine(stream: Readable): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of stream) {
    const buf = typeof chunk === 'string' ? Buffer.from(chunk) : (chunk as Buffer);
    const nl = buf.indexOf(0x0a);
    const part = nl === -1 ? buf : buf.subarray(0, nl);
    size += part.length;
    if (size > MAX_LINE_BYTES) throw new CliError('The input line is longer than 4 KiB.');
    chunks.push(part);
    if (nl !== -1) break;
  }
  const line = Buffer.concat(chunks);
  const text = line.toString('utf8').replace(/\r$/, '');
  line.fill(0);
  return text;
}

export function checkSecretValue(value: string): string {
  const trimmed = value.trim();
  if (trimmed === '') throw new CliError('The secret is empty.');
  if (!SECRET_VALUE_PATTERN.test(trimmed)) {
    throw new CliError('The secret may only contain printable characters without spaces.');
  }
  return trimmed;
}

function target(ref: SecretRef, alias: string): { service: string; account: string } {
  if (ref.source === 'keyring') {
    return { service: ref.service ?? KEYRING_SERVICE, account: ref.account ?? alias };
  }
  return { service: KEYRING_SERVICE, account: alias };
}

const HELP = `Usage: proxmox-ve-mcp secret set <alias> [--stdin] [--use-keyring]

Stores or replaces the API token secret of a host in the OS keychain.
The secret is read from a hidden prompt, or with --stdin as the first line
of standard input. It is never accepted as an argument, because arguments
end up in the shell history and in the process list.

Options:
  --stdin           read the secret from standard input (one line)
  --use-keyring     switch the host to the keychain when it uses another source
  --config <path>   settings file
  -h, --help        show this help

Example:
  bws secret get <id> --output json | jq -r .value | proxmox-ve-mcp secret set homelab --stdin
`;

async function cmdSet(
  ctx: CliContext,
  alias: string,
  options: { stdin: boolean; useKeyring: boolean },
): Promise<number> {
  const location = configLocation(ctx);
  const text = await requireConfigText(location.path);
  const catalog = await ctx.catalog();
  const settings = validateText(text, catalog, `Settings file ${location.path}`);
  const host = settings.hosts[alias];
  if (!host) {
    const known = Object.keys(settings.hosts).join(', ') || 'none';
    throw new CliError(
      `Unknown host "${alias.slice(0, 40)}". Known hosts: ${known}. Add it with proxmox-ve-mcp host add.`,
    );
  }

  if (!(await ctx.keyring.available())) {
    throw new CliError(
      'The OS keychain is not available on this system (the optional package @napi-rs/keyring ' +
        'did not load or no keychain service answered). Use another secret source: proxmox-ve-mcp host edit',
    );
  }

  let value: string;
  if (options.stdin) {
    if (ctx.stdin.isTTY) {
      throw new UsageError(
        '--stdin expects piped input. Run without --stdin to type the secret into a hidden prompt.',
      );
    }
    value = checkSecretValue(await readFirstLine(ctx.stdin));
  } else {
    if (!ctx.interactive) {
      throw new UsageError('no terminal for a hidden prompt, pipe the secret in with --stdin');
    }
    value = checkSecretValue(
      await ctx.prompter.password({
        message: `Token secret for ${alias} (${host.tokenId}), input is hidden`,
        validate: (v) => {
          try {
            checkSecretValue(v);
            return undefined;
          } catch (err) {
            return (err as Error).message;
          }
        },
      }),
    );
  }
  registerSecret(value);

  const { service, account } = target(host.tokenSecret, alias);
  try {
    await ctx.keyring.set(service, account, value);
  } catch (err) {
    throw new CliError(`Cannot store the secret in the OS keychain: ${(err as Error).message}`);
  }
  ctx.stdout(`Stored the token secret of "${alias}" in the OS keychain (${service}/${account}).\n`);

  if (host.tokenSecret.source !== 'keyring') {
    const current = describeSecretRef(host.tokenSecret, alias);
    let switchIt = options.useKeyring;
    if (!switchIt && ctx.interactive && !options.stdin) {
      switchIt = await ctx.prompter.confirm({
        message: `Host "${alias}" reads its secret from ${current}. Switch it to the OS keychain?`,
        initialValue: true,
      });
    }
    if (switchIt) {
      const next = upsertHostInDocument(text, alias, {
        ...host,
        tokenSecret: { source: 'keyring' },
      });
      await writeValidated(location.path, next, catalog);
      ctx.stdout(`Host "${alias}" now reads its secret from the OS keychain.\n`);
    } else {
      ctx.stdout(
        `Host "${alias}" still reads its secret from ${current}. Pass --use-keyring to switch.\n`,
      );
    }
  }
  return 0;
}

export function run(args: string[], ctx?: ContextInput): Promise<number> {
  return runCommand(
    {
      help: HELP,
      options: { stdin: { type: 'boolean' }, 'use-keyring': { type: 'boolean' } },
      async run(parsed, ctx) {
        const [sub, alias, ...extra] = parsed.positionals;
        if (sub !== 'set') {
          throw new UsageError(
            sub === undefined
              ? 'name a subcommand: set'
              : `unknown subcommand "${sub.slice(0, 40)}"`,
          );
        }
        if (alias === undefined) throw new UsageError('name the host: secret set <alias>');
        if (extra.length > 0) {
          // The extra argument is not echoed, it may well be the secret itself.
          throw new UsageError(
            'secret set takes no value argument. Arguments end up in the shell history and the ' +
              'process list, use the hidden prompt or --stdin instead. If that argument was the ' +
              'secret, treat it as exposed and create a new token.',
          );
        }
        return cmdSet(ctx, alias, {
          stdin: parsed.values.stdin === true,
          useKeyring: parsed.values['use-keyring'] === true,
        });
      },
    },
    args,
    ctx,
  );
}
