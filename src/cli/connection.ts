import type { HostSettings } from '../config/types.js';
import { createProxmoxClient } from '../proxmox/client.js';
import { buildTlsPolicy, probeCertificate, type ProbedCertificate } from '../proxmox/tls.js';
import { resolveSecret } from '../secrets/resolve.js';
import { describeSecretRef, describeTls, tlsMode } from './describe.js';
import { messageOf } from './errors.js';

/** Privileges most tools need, shown in the permission summary. */
export const TYPICAL_PRIVILEGES = [
  'VM.Audit',
  'VM.Allocate',
  'VM.PowerMgmt',
  'Datastore.Audit',
  'Sys.Audit',
] as const;

export interface PermissionSummary {
  /** Number of ACL paths the token has any privilege on. */
  pathCount: number;
  /** For each typical privilege, whether it is granted on any path. */
  privileges: Record<string, boolean>;
  /** Total number of distinct privileges granted anywhere. */
  distinct: number;
}

/** Summarizes the response of GET /access/permissions. */
export function summarizePermissions(data: unknown): PermissionSummary {
  const granted = new Set<string>();
  let pathCount = 0;
  if (data && typeof data === 'object' && !Array.isArray(data)) {
    for (const privs of Object.values(data as Record<string, unknown>)) {
      if (!privs || typeof privs !== 'object') continue;
      const names = Object.entries(privs as Record<string, unknown>)
        .filter(([, v]) => v === 1 || v === true || v === '1')
        .map(([k]) => k);
      if (names.length === 0) continue;
      pathCount++;
      for (const name of names) granted.add(name);
    }
  }
  return {
    pathCount,
    privileges: Object.fromEntries(TYPICAL_PRIVILEGES.map((p) => [p, granted.has(p)])),
    distinct: granted.size,
  };
}

export function formatPermissionSummary(summary: PermissionSummary): string {
  const privs = Object.entries(summary.privileges)
    .map(([name, has]) => `${name} ${has ? 'yes' : 'no'}`)
    .join(', ');
  return `${summary.pathCount} path${summary.pathCount === 1 ? '' : 's'}, ${summary.distinct} privileges (${privs})`;
}

export const PRIVSEP_WARNING =
  'The token has no permissions at all. With privilege separation (privsep 1) a token only ' +
  'gets what is granted to the token itself, the permissions of its user do not count. ' +
  "Grant a role to the token, for example: pveum acl modify / --tokens 'user@pve!name' --roles PVEAuditor";

export interface ConnectionResult {
  version: string;
  release?: string;
  permissions: PermissionSummary;
}

/**
 * GET /version and GET /access/permissions with a read-only client. Only GET
 * requests are made, the client refuses anything else.
 */
export async function testConnection(
  alias: string,
  host: HostSettings,
  getSecret: () => Promise<string>,
): Promise<ConnectionResult> {
  const client = createProxmoxClient(alias, host, getSecret, { readOnly: true });
  try {
    const version = await client.get<{ version?: unknown; release?: unknown }>('/version');
    const permissions = await client.get<unknown>('/access/permissions');
    const result: ConnectionResult = {
      version: typeof version?.version === 'string' ? version.version : 'unknown',
      permissions: summarizePermissions(permissions),
    };
    if (typeof version?.release === 'string') result.release = version.release;
    return result;
  } finally {
    client.close();
  }
}

export type CheckStatus = 'ok' | 'warn' | 'fail' | 'skip';

export interface CheckLine {
  status: CheckStatus;
  label: string;
  detail: string;
}

export interface HostReport {
  alias: string;
  url: string;
  lines: CheckLine[];
  failed: boolean;
  connection?: ConnectionResult;
}

export interface CheckHostOptions {
  env?: NodeJS.ProcessEnv;
  probe?: (url: string, options: { timeoutMs?: number }) => Promise<ProbedCertificate>;
  /** Supplies the secret instead of resolving the reference (setup, before storing it). */
  getSecret?: () => Promise<string>;
  now?: Date;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Checks one host: secret, TLS settings, certificate, connection and token
 * permissions. Never includes a secret value in the report.
 */
export async function checkHost(
  alias: string,
  host: HostSettings,
  options: CheckHostOptions = {},
): Promise<HostReport> {
  const lines: CheckLine[] = [];
  const add = (status: CheckStatus, label: string, detail: string) =>
    lines.push({ status, label, detail });

  // 1. Secret
  let secretOk = false;
  let secretPromise: Promise<string> | undefined;
  const getSecret =
    options.getSecret ??
    (() => {
      secretPromise ??= resolveSecret(host.tokenSecret, {
        host: alias,
        ...(options.env !== undefined ? { env: options.env } : {}),
      });
      return secretPromise;
    });
  try {
    await getSecret();
    secretOk = true;
    add('ok', 'Secret', `resolved (${describeSecretRef(host.tokenSecret, alias)})`);
  } catch (err) {
    add('fail', 'Secret', messageOf(err));
  }

  // 2. TLS settings
  const mode = tlsMode(host.tls);
  let tlsOk = true;
  if (mode === 'off') {
    add(
      'warn',
      'TLS',
      'verification is disabled, anyone on the network path can read the API token. Pin the fingerprint instead (proxmox-ve-mcp host edit).',
    );
  } else {
    try {
      await buildTlsPolicy(alias, host.tls);
      add('ok', 'TLS', describeTls(host.tls));
    } catch (err) {
      tlsOk = false;
      add('fail', 'TLS', messageOf(err));
    }
  }

  // 3. Certificate probe (no credentials are sent)
  let reachable = true;
  try {
    const probe = options.probe ?? probeCertificate;
    const timeoutMs = Math.min(host.timeoutSeconds, 15) * 1000;
    const cert = await probe(host.url, { timeoutMs });
    if (mode === 'pinned' || mode === 'pinned+ca') {
      if (cert.fingerprint256 === host.tls.fingerprint) {
        add('ok', 'Certificate', 'matches the pinned fingerprint');
      } else {
        tlsOk = false;
        add(
          'fail',
          'Certificate',
          `fingerprint ${cert.fingerprint256} does not match the pinned one. If the certificate was renewed on purpose, pin the new one with: proxmox-ve-mcp host edit ${alias}`,
        );
      }
    } else if (mode === 'system') {
      if (cert.trustedBySystem) add('ok', 'Certificate', 'trusted by the system CAs');
      else {
        tlsOk = false;
        add(
          'fail',
          'Certificate',
          `not trusted by the system CAs (${cert.trustError ?? 'unknown reason'}). Pin the fingerprint or add a CA file: proxmox-ve-mcp host edit ${alias}`,
        );
      }
    } else {
      add('ok', 'Certificate', `served by ${host.url}, subject ${cert.subject || 'none'}`);
    }
    const validTo = Date.parse(cert.validTo);
    const now = (options.now ?? new Date()).getTime();
    if (Number.isFinite(validTo)) {
      if (validTo < now) add('warn', 'Certificate', `expired on ${cert.validTo}`);
      else if (validTo - now < 14 * DAY_MS)
        add('warn', 'Certificate', `expires on ${cert.validTo}`);
    }
  } catch (err) {
    reachable = false;
    add('fail', 'Certificate', `cannot reach ${host.url}: ${messageOf(err)}`);
  }

  // 4. Connection and permissions
  let connection: ConnectionResult | undefined;
  if (!secretOk || !reachable || !tlsOk) {
    add('skip', 'Connection', 'skipped because of the errors above');
  } else {
    try {
      connection = await testConnection(alias, host, getSecret);
      add(
        'ok',
        'Connection',
        `Proxmox VE ${connection.version}${connection.release ? ` (release ${connection.release})` : ''}`,
      );
      const summary = connection.permissions;
      if (summary.pathCount === 0) add('warn', 'Permissions', PRIVSEP_WARNING);
      else add('ok', 'Permissions', formatPermissionSummary(summary));
    } catch (err) {
      add('fail', 'Connection', messageOf(err));
    }
  }

  return {
    alias,
    url: host.url,
    lines,
    failed: lines.some((l) => l.status === 'fail'),
    ...(connection ? { connection } : {}),
  };
}
