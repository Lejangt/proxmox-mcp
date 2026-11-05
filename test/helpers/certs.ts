import { execFileSync } from 'node:child_process';
import { X509Certificate } from 'node:crypto';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

/*
 * Test certificates are generated at run time with the openssl CLI so that no
 * private key is ever committed (secret scanners stay clean).
 */

export interface KeyPair {
  key: string;
  cert: string;
  fingerprint256: string;
}

export interface TestPki {
  dir: string;
  caPem: string;
  caFile: string;
  /** Signed by the CA, SAN IP:127.0.0.1 and DNS:localhost. */
  leaf: KeyPair;
  /** Signed by the CA, SAN DNS:other.example only. */
  wrongName: KeyPair;
  /** Self-signed, like a default Proxmox installation. */
  selfSigned: KeyPair;
  cleanup(): void;
}

function openssl(args: string[], cwd: string): void {
  execFileSync('openssl', args, { cwd, stdio: 'pipe' });
}

function pair(dir: string, name: string): KeyPair {
  const cert = readFileSync(path.join(dir, `${name}.pem`), 'utf8');
  return {
    key: readFileSync(path.join(dir, `${name}.key`), 'utf8'),
    cert,
    fingerprint256: new X509Certificate(cert).fingerprint256,
  };
}

const EC = ['-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes'];

function signed(dir: string, name: string, san: string): void {
  openssl(
    ['req', ...EC, '-keyout', `${name}.key`, '-out', `${name}.csr`, '-subj', `/CN=${name}`],
    dir,
  );
  writeFileSync(
    path.join(dir, `${name}.ext`),
    `subjectAltName=${san}\nbasicConstraints=CA:FALSE\nextendedKeyUsage=serverAuth\n`,
  );
  openssl(
    [
      'x509',
      '-req',
      '-in',
      `${name}.csr`,
      '-CA',
      'ca.pem',
      '-CAkey',
      'ca.key',
      '-CAcreateserial',
      '-out',
      `${name}.pem`,
      '-days',
      '2',
      '-extfile',
      `${name}.ext`,
    ],
    dir,
  );
}

export function createTestPki(): TestPki {
  const dir = mkdtempSync(path.join(tmpdir(), 'pve-mcp-pki-'));
  openssl(
    [
      'req',
      '-x509',
      ...EC,
      '-keyout',
      'ca.key',
      '-out',
      'ca.pem',
      '-days',
      '2',
      '-subj',
      '/CN=Test CA',
      '-addext',
      'basicConstraints=critical,CA:TRUE',
      '-addext',
      'keyUsage=critical,keyCertSign,cRLSign',
    ],
    dir,
  );
  signed(dir, 'leaf', 'IP:127.0.0.1,DNS:localhost');
  signed(dir, 'wrongname', 'DNS:other.example');
  openssl(
    [
      'req',
      '-x509',
      ...EC,
      '-keyout',
      'self.key',
      '-out',
      'self.pem',
      '-days',
      '2',
      '-subj',
      '/CN=pve.example',
      '-addext',
      'subjectAltName=DNS:pve.example',
    ],
    dir,
  );
  // openssl follows the umask, the server refuses a CA file writable by group or others.
  chmodSync(path.join(dir, 'ca.pem'), 0o644);
  return {
    dir,
    caPem: readFileSync(path.join(dir, 'ca.pem'), 'utf8'),
    caFile: path.join(dir, 'ca.pem'),
    leaf: pair(dir, 'leaf'),
    wrongName: pair(dir, 'wrongname'),
    selfSigned: pair(dir, 'self'),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}
