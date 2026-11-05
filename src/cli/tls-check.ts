import { X509Certificate } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import tls from 'node:tls';
import { normalizeFingerprint } from '../config/schema.js';
import { serverName } from '../proxmox/tls.js';

/** Extracts and parses the PEM certificates of a CA bundle. Throws on garbage. */
export function parseCaPems(text: string): string[] {
  const blocks = text.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g);
  if (!blocks || blocks.length === 0) throw new Error('the file contains no PEM certificate');
  for (const block of blocks) {
    try {
      new X509Certificate(block);
    } catch {
      throw new Error('the file contains an invalid certificate');
    }
  }
  return blocks;
}

export async function readCaFile(filePath: string): Promise<string[]> {
  let text: string;
  try {
    text = await readFile(filePath, 'utf8');
  } catch (err) {
    throw new Error(`cannot read ${filePath} (${(err as NodeJS.ErrnoException).code ?? 'error'})`, {
      cause: err,
    });
  }
  return parseCaPems(text);
}

export interface CaCheck {
  ok: boolean;
  /** Why the CA does not validate the server, when it does not. */
  reason?: string;
  fingerprint256?: string;
}

/**
 * Connects to `url` and checks that the given CA certificates alone validate
 * the chain and the host name. Sends no request and no credentials.
 * `expectedFingerprint` binds the result to the certificate seen before.
 */
export function verifyWithCa(
  url: string,
  caPems: string[],
  options: { expectedFingerprint?: string; timeoutMs?: number } = {},
): Promise<CaCheck> {
  const parsed = new URL(url);
  const host = parsed.hostname.replace(/^\[|\]$/g, '');
  const port = parsed.port ? Number(parsed.port) : 443;
  const sni = serverName(parsed.hostname);
  return new Promise((resolve) => {
    const socket = tls.connect({
      host,
      port,
      ...(sni !== undefined ? { servername: sni } : {}),
      ca: caPems,
      rejectUnauthorized: false,
      ALPNProtocols: ['http/1.1'],
    });
    const timer = setTimeout(() => {
      socket.destroy();
      resolve({ ok: false, reason: 'no TLS handshake within the timeout' });
    }, options.timeoutMs ?? 10_000);
    socket.once('error', (err: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      resolve({ ok: false, reason: `connection failed (${err.code ?? err.message})` });
    });
    socket.once('secureConnect', () => {
      clearTimeout(timer);
      try {
        const peer = socket.getPeerCertificate();
        const fingerprint256 = normalizeFingerprint(peer?.fingerprint256 ?? '');
        if (!socket.authorized) {
          resolve({ ok: false, reason: String(socket.authorizationError) });
          return;
        }
        const identity = tls.checkServerIdentity(host, peer);
        if (identity) {
          resolve({ ok: false, reason: identity.message });
          return;
        }
        if (
          options.expectedFingerprint !== undefined &&
          fingerprint256 !== options.expectedFingerprint
        ) {
          resolve({ ok: false, reason: 'the server presented a different certificate this time' });
          return;
        }
        resolve({ ok: true, ...(fingerprint256 ? { fingerprint256 } : {}) });
      } finally {
        socket.destroy();
      }
    });
  });
}
