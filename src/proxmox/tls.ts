import { X509Certificate } from 'node:crypto';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { isIP } from 'node:net';
import tls from 'node:tls';
import { untrustedFileProblem } from '../config/file-trust.js';
import { expandHome } from '../config/paths.js';
import { normalizeFingerprint } from '../config/schema.js';
import type { TlsSettings } from '../config/types.js';
import { TlsError } from './errors.js';

/*
 * TLS policy per host. Three modes:
 *
 * - ca: system CAs (plus an optional caFile), chain and hostname verified by
 *   Node during the handshake.
 * - pin: the SHA-256 fingerprint of the leaf certificate must match. Node
 *   skips checkServerIdentity for certificates it could not verify (the
 *   typical self-signed Proxmox certificate), so the handshake runs with
 *   rejectUnauthorized: false and the pin is checked on the finished
 *   connection before the socket is handed to the HTTP layer. No request
 *   byte, and therefore no auth header, is written before that check.
 *   With caFile and fingerprint both set, CA verification and the pin apply.
 * - insecure: verify: false, explicit opt-in only, warned about on start.
 */

export type TlsMode = 'ca' | 'pin' | 'insecure';

export interface TlsPolicy {
  mode: TlsMode;
  /** Options merged into tls.connect. */
  connectOptions: tls.ConnectionOptions;
  /** Upper case colon separated SHA-256 of the expected leaf certificate. */
  fingerprint?: string;
  /** Throws TlsError when the finished handshake does not satisfy the policy. */
  verify(socket: tls.TLSSocket): void;
  /** Human readable warning for the insecure mode. */
  warning?: string;
}

function systemCertificates(): string[] {
  // getCACertificates honours NODE_EXTRA_CA_CERTS and --use-system-ca where
  // available (Node 22.15 and newer). rootCertificates is the bundled store.
  const getter = (tls as { getCACertificates?: (type?: string) => string[] }).getCACertificates;
  return typeof getter === 'function' ? getter('default') : [...tls.rootCertificates];
}

const MAX_CA_FILE_BYTES = 4 * 1024 * 1024;

/**
 * Reads tls.caFile through one handle. On POSIX the file must belong to the
 * server user or root and must not be writable by group or others, because
 * whoever can change it decides which servers receive the API token.
 */
async function readCaFile(alias: string, caFile: string): Promise<string> {
  const file = expandHome(caFile);
  const shown = JSON.stringify(file);
  const cannotRead = (err: unknown) =>
    new TlsError(
      `Host "${alias}": cannot read tls.caFile ${shown} (${(err as NodeJS.ErrnoException).code ?? 'error'})`,
    );
  let handle;
  try {
    handle = await open(file, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));
  } catch (err) {
    throw cannotRead(err);
  }
  let pem: string;
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new TlsError(`Host "${alias}": tls.caFile ${shown} is not a file`);
    if (info.size > MAX_CA_FILE_BYTES) {
      throw new TlsError(`Host "${alias}": tls.caFile ${shown} is larger than 4 MiB`);
    }
    if (process.platform !== 'win32') {
      const problem = untrustedFileProblem('tls.caFile', {
        path: file,
        mode: info.mode,
        uid: info.uid,
      });
      if (problem) throw new TlsError(`Host "${alias}": ${problem}`);
    }
    pem = await handle.readFile('utf8');
  } catch (err) {
    if (err instanceof TlsError) throw err;
    throw cannotRead(err);
  } finally {
    await handle.close();
  }
  const blocks = pem.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g);
  if (!blocks || blocks.length === 0) {
    throw new TlsError(
      `Host "${alias}": tls.caFile ${JSON.stringify(file)} contains no PEM certificate`,
    );
  }
  for (const block of blocks) {
    try {
      new X509Certificate(block);
    } catch {
      throw new TlsError(
        `Host "${alias}": tls.caFile ${JSON.stringify(file)} contains an invalid certificate`,
      );
    }
  }
  return blocks.join('\n');
}

function peerFingerprint(socket: tls.TLSSocket): string | undefined {
  const cert = socket.getPeerCertificate();
  if (!cert || !cert.raw) return undefined;
  return normalizeFingerprint(cert.fingerprint256 ?? '');
}

/** Builds the TLS policy for a host. Reads caFile when configured. */
export async function buildTlsPolicy(alias: string, settings: TlsSettings): Promise<TlsPolicy> {
  if (!settings.verify) {
    if (settings.caFile !== undefined || settings.fingerprint !== undefined) {
      throw new TlsError(
        `Host "${alias}": verify: false cannot be combined with caFile or fingerprint`,
      );
    }
    return {
      mode: 'insecure',
      connectOptions: { rejectUnauthorized: false, checkServerIdentity: () => undefined },
      verify: () => undefined,
      warning:
        `Host "${alias}": TLS verification is disabled (tls.verify: false). The API token can be ` +
        'intercepted by anyone on the network path. Use tls.fingerprint or tls.caFile.',
    };
  }

  let fingerprint: string | undefined;
  if (settings.fingerprint !== undefined) {
    fingerprint = normalizeFingerprint(settings.fingerprint);
    if (!fingerprint)
      throw new TlsError(`Host "${alias}": tls.fingerprint is not a SHA-256 fingerprint`);
  }
  const ca =
    settings.caFile !== undefined
      ? [...systemCertificates(), await readCaFile(alias, settings.caFile)]
      : undefined;

  if (fingerprint !== undefined) {
    const expected = fingerprint;
    const withCa = ca !== undefined;
    return {
      mode: 'pin',
      fingerprint: expected,
      connectOptions: withCa ? { ca, rejectUnauthorized: true } : { rejectUnauthorized: false },
      verify(socket) {
        if (withCa && !socket.authorized) {
          throw new TlsError(
            `Host "${alias}": certificate is not trusted (${String(socket.authorizationError)})`,
          );
        }
        const actual = peerFingerprint(socket);
        if (actual !== expected) {
          throw new TlsError(
            `Host "${alias}": certificate fingerprint mismatch. Expected ${expected}, got ${actual ?? 'no certificate'}. ` +
              'If the certificate was renewed on purpose, update tls.fingerprint (proxmox-ve-mcp host edit).',
          );
        }
      },
    };
  }

  return {
    mode: 'ca',
    connectOptions:
      ca !== undefined ? { ca, rejectUnauthorized: true } : { rejectUnauthorized: true },
    verify(socket) {
      if (!socket.authorized) {
        throw new TlsError(
          `Host "${alias}": certificate is not trusted (${String(socket.authorizationError)})`,
        );
      }
    },
  };
}

const CERT_ERROR_CODES = new Set([
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'UNABLE_TO_GET_ISSUER_CERT',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'CERT_HAS_EXPIRED',
  'CERT_NOT_YET_VALID',
  'CERT_UNTRUSTED',
  'CERT_SIGNATURE_FAILURE',
  'ERR_TLS_CERT_ALTNAME_INVALID',
  'HOSTNAME_MISMATCH',
]);

/** Maps a handshake error to a TlsError with a hint, or returns undefined. */
export function tlsErrorFromHandshake(alias: string, err: unknown): TlsError | undefined {
  if (err instanceof TlsError) return err;
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  if (!code) return undefined;
  if (CERT_ERROR_CODES.has(code)) {
    return new TlsError(
      `Host "${alias}": the server certificate was rejected (${code}). For a self-signed Proxmox ` +
        'certificate set tls.fingerprint or tls.caFile, `proxmox-ve-mcp setup` shows both.',
    );
  }
  if (code.startsWith('ERR_SSL') || code.startsWith('ERR_TLS')) {
    return new TlsError(`Host "${alias}": TLS handshake failed (${code})`);
  }
  return undefined;
}

/** SNI must not be an IP address. */
export function serverName(hostname: string): string | undefined {
  const bare = hostname.replace(/^\[|\]$/g, '');
  return isIP(bare) === 0 ? bare : undefined;
}

export interface ProbedCertificate {
  subject: string;
  issuer: string;
  subjectAltNames: string[];
  validFrom: string;
  validTo: string;
  /** Upper case colon separated SHA-256 of the leaf certificate. */
  fingerprint256: string;
  selfSigned: boolean;
  /** Chain and hostname verified against the system CAs. */
  trustedBySystem: boolean;
  /** Why the system CAs did not accept it, when they did not. */
  trustError?: string;
  /** CA certificates the server sent along with the leaf, as PEM. */
  chainCaPems: string[];
}

function formatName(name: unknown): string {
  if (typeof name === 'string') return name;
  if (!name || typeof name !== 'object') return '';
  return Object.entries(name as Record<string, string | string[]>)
    .map(([k, v]) => `${k}=${Array.isArray(v) ? v.join('+') : v}`)
    .join(', ');
}

/**
 * Connects to `url` without sending any request or credentials and reports
 * the server certificate for the setup wizard. Never use the result to
 * decide trust on its own, the user has to confirm the fingerprint.
 */
export function probeCertificate(
  url: string,
  options: { timeoutMs?: number } = {},
): Promise<ProbedCertificate> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return Promise.reject(new TlsError('probeCertificate: invalid URL'));
  }
  if (parsed.protocol !== 'https:')
    return Promise.reject(new TlsError('probeCertificate: URL must use https'));
  const host = parsed.hostname.replace(/^\[|\]$/g, '');
  const port = parsed.port ? Number(parsed.port) : 443;
  const timeoutMs = options.timeoutMs ?? 10_000;
  const sni = serverName(parsed.hostname);

  return new Promise((resolve, reject) => {
    const socket = tls.connect({
      host,
      port,
      ...(sni !== undefined ? { servername: sni } : {}),
      rejectUnauthorized: false,
      ca: systemCertificates(),
      ALPNProtocols: ['http/1.1'],
    });
    const timer = setTimeout(() => {
      socket.destroy();
      reject(
        new TlsError(`probeCertificate: no TLS handshake within ${Math.round(timeoutMs / 1000)}s`),
      );
    }, timeoutMs);
    socket.once('error', (err: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      reject(new TlsError(`probeCertificate: connection failed (${err.code ?? err.message})`));
    });
    socket.once('secureConnect', () => {
      clearTimeout(timer);
      try {
        const leaf = socket.getPeerCertificate(true);
        if (!leaf || !leaf.raw)
          throw new TlsError('probeCertificate: the server sent no certificate');
        const leafX509 = new X509Certificate(leaf.raw);
        let trustError: string | undefined;
        let trusted = socket.authorized;
        if (!trusted) trustError = String(socket.authorizationError);
        else {
          const identityError = tls.checkServerIdentity(host, leaf);
          if (identityError) {
            trusted = false;
            trustError = identityError.message;
          }
        }
        const chainCaPems: string[] = [];
        const seen = new Set<string>([leaf.fingerprint256]);
        let current = leaf.issuerCertificate as tls.DetailedPeerCertificate | undefined;
        while (current && current.raw && !seen.has(current.fingerprint256)) {
          seen.add(current.fingerprint256);
          const x509 = new X509Certificate(current.raw);
          if (x509.ca) chainCaPems.push(x509.toString());
          current = current.issuerCertificate as tls.DetailedPeerCertificate | undefined;
        }
        const result: ProbedCertificate = {
          subject: formatName(leaf.subject),
          issuer: formatName(leaf.issuer),
          subjectAltNames: (leaf.subjectaltname ?? '')
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean),
          validFrom: leafX509.validFrom,
          validTo: leafX509.validTo,
          fingerprint256: normalizeFingerprint(leaf.fingerprint256) ?? leaf.fingerprint256,
          selfSigned: leafX509.checkIssued(leafX509),
          trustedBySystem: trusted,
          chainCaPems,
        };
        if (trustError !== undefined) result.trustError = trustError;
        resolve(result);
      } catch (err) {
        reject(
          err instanceof TlsError
            ? err
            : new TlsError(`probeCertificate: ${(err as Error).message}`),
        );
      } finally {
        socket.destroy();
      }
    });
  });
}
