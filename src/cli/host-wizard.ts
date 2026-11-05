import { randomBytes } from 'node:crypto';
import path from 'node:path';
import pc from 'picocolors';
import { expandHome } from '../config/paths.js';
import {
  HOST_ALIAS_PATTERN,
  normalizeFingerprint,
  secretRefSchema,
  TOKEN_ID_PATTERN,
  formatIssues,
  type HostSettingsInput,
} from '../config/schema.js';
import type { HostSettings, TlsSettings } from '../config/types.js';
import {
  renderSettingsDocument,
  setDefaultHostInDocument,
  upsertHostInDocument,
  writeSettingsFile,
} from '../config/write.js';
import { validateSettings } from '../config/load.js';
import { registerSecret } from '../proxmox/errors.js';
import { probeCertificate, type ProbedCertificate } from '../proxmox/tls.js';
import { resolveSecret } from '../secrets/resolve.js';
import type { SecretRef } from '../secrets/types.js';
import { checkHost, type HostReport } from './connection.js';
import type { CliContext } from './context.js';
import { describeSecretRef } from './describe.js';
import { CancelledError, CliError, messageOf } from './errors.js';
import { KEYRING_SERVICE } from './keyring.js';
import type { Prompter, SelectOption } from './prompts.js';
import { renderLine } from './report.js';
import { configDir, readConfigText, validateText, type ConfigLocation } from './settings-file.js';
import { readCaFile, verifyWithCa } from './tls-check.js';
import { normalizeHostUrl } from './url.js';

/* Proxmox token secrets are UUIDs. The client accepts printable ASCII only. */
const SECRET_VALUE_PATTERN = /^[\x21-\x7e]{1,512}$/;
const UUID_PATTERN =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;

export const BWS_SERVERS = {
  us: 'https://vault.bitwarden.com',
  eu: 'https://vault.bitwarden.eu',
} as const;

export const TOKEN_HELP = [
  'Create an API token on a Proxmox node, for example:',
  '',
  '  pveum user add mcp@pve',
  '  pveum user token add mcp@pve agent --privsep 1',
  "  pveum acl modify / --tokens 'mcp@pve!agent' --roles PVEAuditor",
  '',
  'The secret is shown only once, when the token is created.',
  'With --privsep 1 the token only has the permissions granted to the token',
  'itself (the acl line above). Without that line it can do nothing at all.',
  'Pick roles to match what the agent may do, see docs/permissions.md.',
].join('\n');

export interface PendingKeyring {
  service: string;
  account: string;
  value: string;
  label: string;
}

export interface SecretChoice {
  /** The reference written to the settings file. */
  ref: SecretRef;
  /** Reference and environment used for the test before anything is stored. */
  testRef: SecretRef;
  testEnv: NodeJS.ProcessEnv;
  /** Keychain entries to write when the host is saved. */
  keyring: PendingKeyring[];
}

export interface TlsChoice {
  tls: TlsSettings;
  /** CA file to write next to the settings file when the host is saved. */
  caFile?: { path: string; pem: string };
}

export interface HostDraft {
  alias: string;
  host: HostSettings;
  secret: SecretChoice;
  caFile?: { path: string; pem: string };
}

function validator(fn: (value: string) => string | undefined) {
  return fn;
}

/** Secret choice for an existing reference that is not changed. */
export function existingSecret(ref: SecretRef, env: NodeJS.ProcessEnv): SecretChoice {
  return { ref, testRef: ref, testEnv: env, keyring: [] };
}

/** Resolves the secret of a draft for the connection test. The value is never shown. */
export function secretGetter(alias: string, choice: SecretChoice): () => Promise<string> {
  let pending: Promise<string> | undefined;
  return () => {
    pending ??= resolveSecret(choice.testRef, { host: alias, env: choice.testEnv });
    return pending;
  };
}

// ---------------------------------------------------------------------------
// Single steps

export async function promptAlias(
  p: Prompter,
  existing: ReadonlySet<string>,
  initial?: string,
): Promise<string> {
  return p.text({
    message: 'Alias for this host (used as `host` in tool calls)',
    placeholder: 'homelab',
    ...(initial !== undefined ? { initialValue: initial } : {}),
    validate: validator((v) => {
      const value = v.trim();
      if (!HOST_ALIAS_PATTERN.test(value)) {
        return 'Use lower case letters, digits, "_" and "-" (max 32, starting with a letter or digit).';
      }
      if (existing.has(value)) return `"${value}" already exists. Use proxmox-ve-mcp host edit.`;
      return undefined;
    }),
  });
}

export async function promptUrl(p: Prompter, initial?: string): Promise<string> {
  const value = await p.text({
    message: 'Proxmox host name, IP or URL',
    placeholder: 'pve.example.com or https://192.0.2.10:8006',
    ...(initial !== undefined ? { initialValue: initial } : {}),
    validate: validator((v) => {
      try {
        normalizeHostUrl(v);
        return undefined;
      } catch (err) {
        return (err as Error).message;
      }
    }),
  });
  const url = normalizeHostUrl(value);
  if (url !== value.trim()) p.info(`Using ${url}`);
  return url;
}

export async function promptTokenId(p: Prompter, initial?: string): Promise<string> {
  p.note(TOKEN_HELP, 'API token');
  return p.text({
    message: 'Token ID',
    placeholder: 'mcp@pve!agent',
    ...(initial !== undefined ? { initialValue: initial } : {}),
    validate: validator((v) =>
      TOKEN_ID_PATTERN.test(v.trim())
        ? undefined
        : 'A token ID looks like user@realm!tokenname, for example mcp@pve!agent.',
    ),
  });
}

function certificateNote(cert: ProbedCertificate): string {
  return [
    `Subject:     ${cert.subject || '(none)'}`,
    `Issuer:      ${cert.issuer || '(none)'}`,
    `Names (SAN): ${cert.subjectAltNames.join(', ') || '(none)'}`,
    `Valid:       ${cert.validFrom} to ${cert.validTo}`,
    `SHA-256:     ${cert.fingerprint256}`,
    `Self-signed: ${cert.selfSigned ? 'yes' : 'no'}`,
    `Problem:     ${cert.trustError ?? 'not trusted'}`,
  ].join('\n');
}

const FINGERPRINT_HELP =
  'Compare it on the Proxmox node before you trust it:\n' +
  '  openssl x509 -noout -fingerprint -sha256 -in /etc/pve/local/pve-ssl.pem\n' +
  '(use pveproxy-ssl.pem instead when a custom certificate is installed),\n' +
  'or in the web UI under Node > System > Certificates.';

async function chooseCaFile(
  ctx: CliContext,
  url: string,
  expectedFingerprint: string | undefined,
): Promise<TlsChoice | undefined> {
  const p = ctx.prompter;
  const input = await p.text({
    message: 'Path of the CA certificate (PEM)',
    placeholder: '~/pve-root-ca.pem',
    validate: validator((v) => (v.trim() === '' ? 'Enter a path.' : undefined)),
  });
  const file = path.resolve(expandHome(input, ctx.home));
  let pems: string[];
  try {
    pems = await readCaFile(file);
  } catch (err) {
    p.error(`Cannot use ${file}: ${messageOf(err)}`);
    return undefined;
  }
  const check = await verifyWithCa(url, pems, {
    ...(expectedFingerprint !== undefined ? { expectedFingerprint } : {}),
  });
  if (!check.ok) {
    p.error(`This CA does not validate the server certificate for ${url}: ${check.reason}`);
    return undefined;
  }
  p.success('The CA validates the server certificate and host name.');
  return { tls: { verify: true, caFile: file } };
}

async function confirmInsecure(p: Prompter): Promise<TlsChoice | undefined> {
  p.warn(
    'Without TLS verification anyone on the network path between this machine and Proxmox ' +
      'can impersonate the server and read the API token.',
  );
  const sure = await p.confirm({
    message: 'Disable TLS verification for this host anyway?',
    initialValue: false,
  });
  return sure ? { tls: { verify: false } } : undefined;
}

async function manualTls(ctx: CliContext, url: string): Promise<TlsChoice | 'url'> {
  const p = ctx.prompter;
  for (;;) {
    const choice = await p.select({
      message: 'How should the server certificate be checked?',
      options: [
        { value: 'retry', label: 'Try to connect again' },
        { value: 'url', label: 'Change the URL' },
        { value: 'pin', label: 'Enter the SHA-256 fingerprint by hand' },
        { value: 'ca', label: 'Use a CA certificate file' },
        { value: 'system', label: 'Trust the system CAs', hint: 'certificate from a public CA' },
        { value: 'insecure', label: 'Disable verification', hint: 'not recommended' },
      ],
    });
    if (choice === 'retry') return promptTls(ctx, url);
    if (choice === 'url') return 'url';
    if (choice === 'system') return { tls: { verify: true } };
    if (choice === 'pin') {
      p.note(FINGERPRINT_HELP, 'Fingerprint');
      const value = await p.text({
        message: 'SHA-256 fingerprint',
        placeholder: 'AB:CD:...:EF',
        validate: validator((v) =>
          normalizeFingerprint(v) ? undefined : 'Enter 64 hex digits, colons are optional.',
        ),
      });
      return { tls: { verify: true, fingerprint: normalizeFingerprint(value)! } };
    }
    if (choice === 'ca') {
      const input = await p.text({
        message: 'Path of the CA certificate (PEM)',
        validate: validator((v) => (v.trim() === '' ? 'Enter a path.' : undefined)),
      });
      const file = path.resolve(expandHome(input, ctx.home));
      try {
        await readCaFile(file);
        return { tls: { verify: true, caFile: file } };
      } catch (err) {
        p.error(`Cannot use ${file}: ${messageOf(err)}`);
        continue;
      }
    }
    const insecure = await confirmInsecure(p);
    if (insecure) return insecure;
  }
}

/**
 * Probes the certificate (no credentials are sent) and lets the user decide
 * how to trust it. Returns 'url' when the user wants to change the URL.
 */
export async function promptTls(
  ctx: CliContext,
  url: string,
  alias?: string,
  location?: ConfigLocation,
): Promise<TlsChoice | 'url'> {
  const p = ctx.prompter;
  const spin = p.spinner();
  spin.start(`Checking the TLS certificate of ${url}`);
  let cert: ProbedCertificate;
  try {
    cert = await probeCertificate(url);
  } catch (err) {
    spin.error(`Cannot reach ${url}: ${messageOf(err)}`);
    return manualTls(ctx, url);
  }
  if (cert.trustedBySystem) {
    spin.stop(`The certificate is trusted by the system CAs (${cert.subject || url}).`);
    return { tls: { verify: true } };
  }
  spin.stop('The certificate is not trusted by the system CAs.');
  p.note(certificateNote(cert), 'Server certificate');

  let chainCa: string | undefined;
  if (cert.chainCaPems.length > 0) {
    const check = await verifyWithCa(url, cert.chainCaPems, {
      expectedFingerprint: cert.fingerprint256,
    });
    if (check.ok) chainCa = cert.chainCaPems.join('\n');
  }
  const caTarget =
    alias !== undefined && location !== undefined
      ? path.join(configDir(location), 'ca', `${alias}.pem`)
      : undefined;

  for (;;) {
    const options: SelectOption<string>[] = [
      {
        value: 'pin',
        label: 'Pin this certificate (SHA-256 fingerprint)',
        hint: cert.selfSigned || !chainCa ? 'recommended' : 'must be pinned again after a renewal',
      },
    ];
    if (chainCa && caTarget) {
      options.push({
        value: 'chain',
        label: 'Trust the CA the server sent along',
        hint: `saved as ${caTarget}`,
      });
    }
    options.push(
      { value: 'ca', label: 'Use my own CA certificate file' },
      { value: 'url', label: 'Change the URL' },
      { value: 'insecure', label: 'Disable verification', hint: 'not recommended' },
    );
    const choice = await p.select({ message: 'How should this host be trusted?', options });
    if (choice === 'url') return 'url';
    if (choice === 'pin') {
      p.note(
        `${cert.fingerprint256}\n\n${FINGERPRINT_HELP}\n\n` +
          'When the certificate changes (renewal, new node certificate) the connection fails\n' +
          'until the new fingerprint is pinned: proxmox-ve-mcp host edit',
        'Fingerprint',
      );
      const ok = await p.confirm({ message: 'Pin this fingerprint?', initialValue: true });
      if (ok) return { tls: { verify: true, fingerprint: cert.fingerprint256 } };
      continue;
    }
    if (choice === 'chain' && chainCa && caTarget) {
      return {
        tls: { verify: true, caFile: caTarget },
        caFile: { path: caTarget, pem: `${chainCa}\n` },
      };
    }
    if (choice === 'ca') {
      const result = await chooseCaFile(ctx, url, cert.fingerprint256);
      if (result) return result;
      continue;
    }
    const insecure = await confirmInsecure(p);
    if (insecure) return insecure;
  }
}

// ---------------------------------------------------------------------------
// Secret source

type SourceId = 'keyring' | 'bws' | '1password' | 'vault' | 'pass' | 'file' | 'env' | 'command';

function checkRef(ref: unknown): SecretRef {
  const parsed = secretRefSchema.safeParse(ref);
  if (!parsed.success) throw new CliError(formatIssues(parsed.error));
  return parsed.data as SecretRef;
}

async function promptSecretValue(p: Prompter, message: string): Promise<string> {
  const value = await p.password({
    message,
    validate: validator((v) => {
      const t = v.trim();
      if (t === '') return 'Enter the value.';
      if (!SECRET_VALUE_PATTERN.test(t)) return 'Only printable characters without spaces.';
      return undefined;
    }),
  });
  const trimmed = value.trim();
  // Registered so that it is scrubbed from anything printed later.
  registerSecret(trimmed);
  return trimmed;
}

const testEnvName = () => `PROXMOX_VE_MCP_SETUP_${randomBytes(4).toString('hex').toUpperCase()}`;

async function buildSource(
  ctx: CliContext,
  alias: string,
  source: SourceId,
  keyringAvailable: boolean,
): Promise<SecretChoice> {
  const p = ctx.prompter;
  const env = ctx.env;
  switch (source) {
    case 'keyring': {
      const value = await promptSecretValue(p, 'Token secret (input is hidden)');
      if (!UUID_PATTERN.test(value)) {
        p.warn(
          'This does not look like a Proxmox token secret (a UUID). Check it if the test fails.',
        );
      }
      const name = testEnvName();
      return {
        ref: { source: 'keyring' },
        testRef: { source: 'env', name },
        testEnv: { ...env, [name]: value },
        keyring: [{ service: KEYRING_SERVICE, account: alias, value, label: 'token secret' }],
      };
    }
    case 'bws': {
      const secretId = await p.text({
        message: 'Bitwarden secret ID (UUID)',
        placeholder: '00000000-0000-0000-0000-000000000000',
        validate: validator((v) => (UUID_PATTERN.test(v.trim()) ? undefined : 'Enter a UUID.')),
      });
      const server = await p.select({
        message: 'Bitwarden server',
        options: [
          { value: 'us', label: 'US cloud', hint: BWS_SERVERS.us },
          { value: 'eu', label: 'EU cloud', hint: BWS_SERVERS.eu },
          { value: 'custom', label: 'Self-hosted or other URL' },
        ],
      });
      let serverUrl: string | undefined;
      if (server === 'eu') serverUrl = BWS_SERVERS.eu;
      if (server === 'custom') {
        serverUrl = await p.text({
          message: 'Server URL',
          placeholder: 'https://bitwarden.example.com',
          validate: validator((v) => {
            try {
              const u = new URL(v.trim());
              return u.protocol === 'https:' && !u.username && !u.password
                ? undefined
                : 'Enter an https:// URL without credentials.';
            } catch {
              return 'Enter an https:// URL.';
            }
          }),
        });
      }
      const tokenOptions: SelectOption<string>[] = [
        {
          value: 'env',
          label: 'Environment variable BWS_ACCESS_TOKEN',
          hint: 'must be set in the environment of the MCP client',
        },
      ];
      if (keyringAvailable) {
        tokenOptions.unshift({ value: 'keyring', label: 'OS keychain', hint: 'recommended' });
      }
      const where = await p.select({
        message: 'Where does the Bitwarden access token come from?',
        options: tokenOptions,
      });
      const base = {
        source: 'bws' as const,
        secretId: secretId.trim(),
        ...(serverUrl !== undefined ? { serverUrl } : {}),
      };
      if (where === 'keyring') {
        const value = await promptSecretValue(p, 'Bitwarden access token (input is hidden)');
        const account = `${alias}-bws-access-token`;
        const name = testEnvName();
        return {
          ref: checkRef({ ...base, accessToken: { source: 'keyring', account } }),
          testRef: checkRef({ ...base, accessToken: { source: 'env', name } }),
          testEnv: { ...env, [name]: value },
          keyring: [{ service: KEYRING_SERVICE, account, value, label: 'Bitwarden access token' }],
        };
      }
      if (!env.BWS_ACCESS_TOKEN) {
        p.warn('BWS_ACCESS_TOKEN is not set in this shell, so the test below will fail.');
      }
      const ref = checkRef(base);
      return existingSecret(ref, env);
    }
    case '1password': {
      const ref = await p.text({
        message: '1Password secret reference',
        placeholder: 'op://Infrastructure/Proxmox MCP/credential',
        validate: validator((v) =>
          v.trim().startsWith('op://') ? undefined : 'A reference starts with op://',
        ),
      });
      const account = await p.text({
        message: '1Password account (optional, empty for the default)',
        defaultValue: '',
      });
      return existingSecret(
        checkRef({ source: '1password', ref: ref.trim(), ...(account ? { account } : {}) }),
        env,
      );
    }
    case 'vault': {
      const binary = await p.select({
        message: 'Which CLI?',
        options: [
          { value: 'vault', label: 'HashiCorp Vault (vault)' },
          { value: 'bao', label: 'OpenBao (bao)' },
        ],
      });
      const mount = await p.text({ message: 'KV mount', initialValue: 'secret' });
      const secretPath = await p.text({
        message: 'Secret path',
        placeholder: 'proxmox/mcp',
        validate: validator((v) => (v.trim() === '' ? 'Enter a path.' : undefined)),
      });
      const field = await p.text({ message: 'Field', initialValue: 'token' });
      const address = await p.text({
        message: 'Server address (optional, empty uses VAULT_ADDR or BAO_ADDR)',
        defaultValue: '',
      });
      return existingSecret(
        checkRef({
          source: 'vault',
          path: secretPath,
          field,
          ...(mount ? { mount } : {}),
          ...(address ? { address } : {}),
          ...(binary === 'bao' ? { binary: 'bao' } : {}),
        }),
        env,
      );
    }
    case 'pass': {
      const name = await p.text({
        message: 'pass entry name',
        placeholder: 'proxmox/mcp-token',
        validate: validator((v) => (v.trim() === '' ? 'Enter a name.' : undefined)),
      });
      return existingSecret(checkRef({ source: 'pass', name }), env);
    }
    case 'file': {
      const input = await p.text({
        message: 'Path of the file that holds the token secret',
        placeholder: '~/.config/proxmox-ve-mcp/homelab.secret',
        validate: validator((v) => (v.trim() === '' ? 'Enter a path.' : undefined)),
      });
      // Relative paths would depend on the working directory of the MCP client.
      const filePath =
        input.startsWith('~') || path.isAbsolute(input) ? input : path.resolve(input);
      return existingSecret(checkRef({ source: 'file', path: filePath }), env);
    }
    case 'env': {
      const name = await p.text({
        message: 'Name of the environment variable',
        initialValue: 'PROXMOX_TOKEN_SECRET',
        validate: validator((v) =>
          ENV_NAME_PATTERN.test(v.trim()) ? undefined : 'Enter a variable name like PVE_SECRET.',
        ),
      });
      p.warn(
        'The variable must be set in the environment of the MCP client, which usually means ' +
          'the secret sits in plain text in its config file. Prefer the keychain or a file.',
      );
      return existingSecret(checkRef({ source: 'env', name }), env);
    }
    case 'command': {
      const mode = await p.select({
        message: 'How do you want to enter the command?',
        options: [
          { value: 'steps', label: 'Step by step', hint: 'one argument per prompt' },
          { value: 'json', label: 'As a JSON array', hint: '["my-tool", "get", "pve"]' },
        ],
      });
      let argv: string[];
      if (mode === 'json') {
        const raw = await p.text({
          message: 'Command as JSON array',
          validate: validator((v) => {
            try {
              const parsed: unknown = JSON.parse(v);
              return Array.isArray(parsed) &&
                parsed.length > 0 &&
                parsed.every((a) => typeof a === 'string') &&
                parsed[0] !== ''
                ? undefined
                : 'Enter a non-empty array of strings.';
            } catch {
              return 'This is not valid JSON.';
            }
          }),
        });
        argv = JSON.parse(raw) as string[];
      } else {
        const exe = await p.text({
          message: 'Executable (name in PATH or absolute path)',
          validate: validator((v) => (v.trim() === '' ? 'Enter the executable.' : undefined)),
        });
        argv = [exe];
        for (let i = 1; i < 64; i++) {
          const arg = await p.text({
            message: `Argument ${i} (empty to finish)`,
            defaultValue: '',
          });
          if (arg === '') break;
          argv.push(arg);
        }
      }
      p.info(
        'The command runs without a shell and with a minimal environment. Its output is used as the secret.',
      );
      return existingSecret(checkRef({ source: 'command', command: argv }), env);
    }
  }
}

/** Asks where the token secret lives and tests the reference (never shows the value). */
export async function promptSecret(
  ctx: CliContext,
  alias: string,
  keyringAvailable: boolean,
): Promise<SecretChoice> {
  const p = ctx.prompter;
  const options: SelectOption<SourceId>[] = [
    { value: 'bws', label: 'Bitwarden Secrets Manager', hint: 'bws CLI' },
    { value: '1password', label: '1Password', hint: 'op CLI' },
    { value: 'vault', label: 'HashiCorp Vault or OpenBao', hint: 'vault or bao CLI' },
    { value: 'pass', label: 'pass', hint: 'the standard unix password manager' },
    { value: 'file', label: 'File', hint: 'readable by you only (chmod 600)' },
    { value: 'env', label: 'Environment variable', hint: 'set by the MCP client' },
    { value: 'command', label: 'Custom command', hint: 'prints the secret on stdout' },
  ];
  if (keyringAvailable) {
    options.unshift({ value: 'keyring', label: 'OS keychain', hint: 'recommended' });
  } else {
    p.info('The OS keychain is not available here, so it is not offered.');
  }
  for (;;) {
    const source = await p.select({ message: 'Where should the token secret live?', options });
    let choice: SecretChoice;
    try {
      choice = await buildSource(ctx, alias, source, keyringAvailable);
    } catch (err) {
      if (err instanceof CancelledError) throw err;
      p.error(messageOf(err));
      continue;
    }
    if (source === 'keyring') return choice;

    const spin = p.spinner();
    spin.start(`Reading the secret from ${describeSecretRef(choice.ref, alias)}`);
    try {
      await secretGetter(alias, choice)();
      spin.stop('The secret could be read.');
      return choice;
    } catch (err) {
      spin.error(messageOf(err));
    }
    const next = await p.select({
      message: 'The secret could not be read. What now?',
      options: [
        { value: 'again', label: 'Choose the source again' },
        {
          value: 'keep',
          label: 'Keep it anyway',
          hint: 'for example when only the MCP client has the variable or login',
        },
      ],
    });
    if (next === 'keep') return choice;
  }
}

// ---------------------------------------------------------------------------
// Whole host

export async function runChecks(
  ctx: CliContext,
  alias: string,
  host: HostSettings,
  secret: SecretChoice,
): Promise<HostReport> {
  const p = ctx.prompter;
  const spin = p.spinner();
  spin.start('Testing the connection (GET /version and /access/permissions)');
  const report = await checkHost(alias, host, {
    env: secret.testEnv,
    getSecret: secretGetter(alias, secret),
  });
  if (report.failed) spin.error('The connection test found problems.');
  else spin.stop('Connection test finished.');
  const plain = pc.createColors(false);
  p.note(
    report.lines.map((l) => renderLine(l, plain).replace(/^ {2}/, '').trimEnd()).join('\n'),
    `Host ${alias}`,
  );
  return report;
}

export interface PromptHostOptions {
  location: ConfigLocation;
  existingAliases: ReadonlySet<string>;
  keyringAvailable: boolean;
}

/** The full interactive flow for one new host. */
export async function promptNewHost(
  ctx: CliContext,
  options: PromptHostOptions,
): Promise<HostDraft> {
  const p = ctx.prompter;
  const alias = await promptAlias(p, options.existingAliases);
  let url = await promptUrl(p);
  let tls: TlsChoice;
  for (;;) {
    const result = await promptTls(ctx, url, alias, options.location);
    if (result !== 'url') {
      tls = result;
      break;
    }
    url = await promptUrl(p, url);
  }
  let tokenId = await promptTokenId(p);
  let secret = await promptSecret(ctx, alias, options.keyringAvailable);

  for (;;) {
    const host: HostSettings = {
      url,
      tokenId: tokenId.trim(),
      tokenSecret: secret.ref,
      tls: tls.tls,
      readOnly: false,
      timeoutSeconds: 30,
    };
    const report = await runChecks(ctx, alias, host, secret);
    if (report.failed) {
      const next = await p.select({
        message: 'What now?',
        options: [
          { value: 'token', label: 'Enter the token ID again' },
          { value: 'secret', label: 'Choose the secret source again' },
          { value: 'tls', label: 'Change URL or TLS settings' },
          { value: 'retest', label: 'Test again' },
          { value: 'save', label: 'Save anyway', hint: 'fix it later with host edit' },
        ],
      });
      if (next === 'token') tokenId = await promptTokenId(p, tokenId);
      if (next === 'secret') secret = await promptSecret(ctx, alias, options.keyringAvailable);
      if (next === 'tls') {
        url = await promptUrl(p, url);
        for (;;) {
          const result = await promptTls(ctx, url, alias, options.location);
          if (result !== 'url') {
            tls = result;
            break;
          }
          url = await promptUrl(p, url);
        }
      }
      if (next !== 'save') continue;
    }

    const privileges = report.connection?.permissions.privileges;
    const canWrite = privileges
      ? Boolean(privileges['VM.Allocate'] || privileges['VM.PowerMgmt'])
      : true;
    host.readOnly = await p.confirm({
      message: 'Make this host read-only? (every change is refused before it is sent)',
      initialValue: !canWrite,
    });
    const description = await p.text({
      message: 'Description (optional)',
      defaultValue: '',
    });
    if (description) host.description = description;
    return { alias, host, secret, ...(tls.caFile ? { caFile: tls.caFile } : {}) };
  }
}

function hostInput(host: HostSettings): HostSettingsInput {
  return JSON.parse(JSON.stringify(host)) as HostSettingsInput;
}

export interface SaveResult {
  path: string;
  created: boolean;
  keyringStored: string[];
}

/**
 * Stores pending keychain entries and the CA file, then writes the settings
 * file (new: complete commented document, existing: host added or replaced).
 * The final text is validated before anything is written to the settings file.
 */
export async function saveHost(
  ctx: CliContext,
  location: ConfigLocation,
  draft: HostDraft,
  options: { makeDefault?: boolean } = {},
): Promise<SaveResult> {
  const catalog = await ctx.catalog();
  const existing = await readConfigText(location.path);
  let text: string;
  if (existing === undefined) {
    const settings = validateSettings(
      { version: 1, defaultHost: draft.alias, hosts: { [draft.alias]: hostInput(draft.host) } },
      'the new settings',
    );
    text = renderSettingsDocument(settings, catalog);
  } else {
    validateText(existing, catalog, `Settings file ${location.path}`);
    text = upsertHostInDocument(existing, draft.alias, hostInput(draft.host));
    if (options.makeDefault) text = setDefaultHostInDocument(text, draft.alias);
  }
  // Validate before any side effect.
  validateText(text, catalog, 'the new settings');

  const stored: string[] = [];
  for (const entry of draft.secret.keyring) {
    try {
      await ctx.keyring.set(entry.service, entry.account, entry.value);
    } catch (err) {
      throw new CliError(`Cannot store the ${entry.label} in the OS keychain: ${messageOf(err)}`);
    }
    stored.push(`${entry.label} (${entry.service}/${entry.account})`);
  }
  if (draft.caFile) await writeSettingsFile(draft.caFile.path, draft.caFile.pem);
  await writeSettingsFile(location.path, text);
  return { path: location.path, created: existing === undefined, keyringStored: stored };
}
