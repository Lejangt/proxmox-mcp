import { writeFileSync } from 'node:fs';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { run as runDoctor } from '../src/cli/doctor.js';
import { run as runHost } from '../src/cli/host.js';
import { summarizePermissions } from '../src/cli/connection.js';
import { validateSettings } from '../src/config/load.js';
import { renderSettingsDocument } from '../src/config/write.js';
import { clearRegisteredSecrets } from '../src/proxmox/errors.js';
import { createTestPki, type TestPki } from './helpers/certs.js';
import { json, startServer, type TestServer } from './helpers/server.js';
import { TEST_CATALOG, tempDir, testCli } from './helpers/cli.js';

const SECRET = 'fake-token-for-tests-only';

let pki: TestPki;
let server: TestServer;
let emptyPerms = false;

beforeAll(async () => {
  pki = createTestPki();
  server = await startServer(pki.selfSigned, (req, res) => {
    if (req.headers.authorization !== `PVEAPIToken=mcp@pve!agent=${SECRET}`) {
      json(res, 401, { data: null }, 'authentication failure');
    } else if (req.url === '/api2/json/version') {
      json(res, 200, { data: { version: '9.1.2', release: '9.1', repoid: 'abc' } });
    } else if (req.url === '/api2/json/access/permissions') {
      json(res, 200, {
        data: emptyPerms
          ? {}
          : {
              '/': { 'Sys.Audit': 1, 'VM.Audit': 1, 'Datastore.Audit': 1 },
              '/vms/100': { 'VM.PowerMgmt': 1 },
            },
      });
    } else {
      json(res, 404, { data: null });
    }
  });
});
afterAll(async () => {
  await server.close();
  pki.cleanup();
});

let tmp: ReturnType<typeof tempDir>;
let file: string;
beforeEach(() => {
  tmp = tempDir();
  file = tmp.file('config.yaml');
  emptyPerms = false;
});
afterEach(() => {
  tmp.cleanup();
  clearRegisteredSecrets();
});

function writeHost(tls: Record<string, unknown>, secretEnv = 'PVE_TEST_SECRET'): void {
  const settings = validateSettings({
    version: 1,
    hosts: {
      lab: {
        url: server.url,
        tokenId: 'mcp@pve!agent',
        tokenSecret: { source: 'env', name: secretEnv },
        tls,
        timeoutSeconds: 5,
      },
    },
  });
  writeFileSync(file, renderSettingsDocument(settings, TEST_CATALOG), { mode: 0o600 });
}

describe('doctor', () => {
  it('passes against a pinned server and shows version and permissions without the secret', async () => {
    writeHost({ fingerprint: pki.selfSigned.fingerprint256 });
    const cli = testCli({ configPath: file, env: { PVE_TEST_SECRET: SECRET } });
    expect(await runDoctor([], cli.ctx)).toBe(0);
    const out = cli.out();
    expect(out).toMatch(/ok\s+Secret\s+resolved \(env PVE_TEST_SECRET\)/);
    expect(out).toMatch(/ok\s+Certificate\s+matches the pinned fingerprint/);
    expect(out).toMatch(/ok\s+Connection\s+Proxmox VE 9\.1\.2 \(release 9\.1\)/);
    expect(out).toMatch(
      /2 paths, 4 privileges \(VM\.Audit yes, VM\.Allocate no, VM\.PowerMgmt yes/,
    );
    expect(out).toContain('All checks passed');
    expect(out + cli.err()).not.toContain(SECRET);
    // Only GET requests were made.
    expect(server.requests.every((r) => r.method === 'GET')).toBe(true);
  });

  it('fails on a fingerprint mismatch and does not send the token', async () => {
    writeHost({ fingerprint: pki.leaf.fingerprint256 });
    const before = server.requests.length;
    const cli = testCli({ configPath: file, env: { PVE_TEST_SECRET: SECRET } });
    expect(await runDoctor([], cli.ctx)).toBe(1);
    expect(cli.out()).toMatch(/FAIL\s+Certificate\s+fingerprint .* does not match/);
    expect(cli.out()).toMatch(/skip\s+Connection/);
    expect(server.requests.length).toBe(before);
  });

  it('fails when the secret cannot be resolved', async () => {
    writeHost({ fingerprint: pki.selfSigned.fingerprint256 });
    const cli = testCli({ configPath: file, env: {} });
    expect(await runDoctor([], cli.ctx)).toBe(1);
    expect(cli.out()).toMatch(/FAIL\s+Secret\s+.*PVE_TEST_SECRET is not set/);
  });

  it('fails for an untrusted certificate in system CA mode', async () => {
    writeHost({});
    const cli = testCli({ configPath: file, env: { PVE_TEST_SECRET: SECRET } });
    expect(await runDoctor([], cli.ctx)).toBe(1);
    expect(cli.out()).toMatch(/FAIL\s+Certificate\s+not trusted by the system CAs/);
  });

  it('warns about disabled verification, empty permissions and plain env secrets', async () => {
    writeHost({ verify: false });
    emptyPerms = true;
    const cli = testCli({ configPath: file, env: { PVE_TEST_SECRET: SECRET } });
    expect(await runDoctor([], cli.ctx)).toBe(0);
    expect(cli.out()).toMatch(/warn\s+TLS\s+verification is disabled/);
    expect(cli.out()).toMatch(/warn\s+Permissions\s+The token has no permissions at all/);
    // The short lived test certificate adds an expiry warning.
    expect(cli.out()).toMatch(/All checks passed, \d+ warnings/);

    const envMode = testCli({
      configPath: tmp.file('missing.yaml'),
      env: {
        PROXMOX_URL: server.url,
        PROXMOX_TOKEN_ID: 'mcp@pve!agent',
        PROXMOX_TOKEN_SECRET: SECRET,
        PROXMOX_TLS_FINGERPRINT: pki.selfSigned.fingerprint256,
      },
    });
    // An explicit --config that does not exist is an error, env mode needs the default path.
    envMode.ctx.configPath = undefined;
    envMode.ctx.env.XDG_CONFIG_HOME = tmp.dir;
    expect(await runDoctor([], envMode.ctx)).toBe(0);
    expect(envMode.out()).toMatch(
      /warn\s+Secret\s+PROXMOX_TOKEN_SECRET holds the token secret in plain text/,
    );
    expect(envMode.out()).not.toContain(SECRET);
  });

  it('warns about a settings file readable by others', async () => {
    writeHost({ fingerprint: pki.selfSigned.fingerprint256 });
    const { chmodSync } = await import('node:fs');
    chmodSync(file, 0o644);
    const cli = testCli({ configPath: file, env: { PVE_TEST_SECRET: SECRET } });
    expect(await runDoctor([], cli.ctx)).toBe(0);
    expect(cli.out()).toMatch(/warn\s+Settings\s+.*chmod 600/);
  });

  it('host test checks a single host with the same logic', async () => {
    writeHost({ fingerprint: pki.selfSigned.fingerprint256 });
    const cli = testCli({ configPath: file, env: { PVE_TEST_SECRET: SECRET } });
    expect(await runHost(['test', 'lab'], cli.ctx)).toBe(0);
    expect(cli.out()).toMatch(/Proxmox VE 9\.1\.2/);
    const unknown = testCli({ configPath: file, env: { PVE_TEST_SECRET: SECRET } });
    expect(await runHost(['test', 'nope'], unknown.ctx)).toBe(1);
  });
});

describe('summarizePermissions', () => {
  it('counts paths with at least one privilege', () => {
    const s = summarizePermissions({ '/': { 'VM.Audit': 1, 'VM.Allocate': 0 }, '/x': {} });
    expect(s.pathCount).toBe(1);
    expect(s.distinct).toBe(1);
    expect(s.privileges).toMatchObject({ 'VM.Audit': true, 'VM.Allocate': false });
    expect(summarizePermissions(null).pathCount).toBe(0);
    expect(summarizePermissions([]).pathCount).toBe(0);
  });
});

describe('setup with scripted answers', () => {
  it('pins the certificate, stores the secret in the keychain only at the end and writes the file', async () => {
    const { run: runSetup } = await import('../src/cli/setup.js');
    const { readFileSync, statSync } = await import('node:fs');
    const cli = testCli({
      configPath: file,
      interactive: true,
      answers: [
        'lab', // alias
        server.url, // url
        'pin', // how to trust
        true, // pin this fingerprint
        'mcp@pve!agent', // token id
        'keyring', // secret source
        SECRET, // hidden secret
        false, // read-only
        '', // description
        'skip', // client snippet
      ],
    });
    expect(await runSetup([], cli.ctx)).toBe(0);
    expect(cli.keyring.entries.get('proxmox-ve-mcp/lab')).toBe(SECRET);
    const text = readFileSync(file, 'utf8');
    expect(text).not.toContain(SECRET);
    expect(text).toContain('source: keyring');
    expect(text).toContain(`fingerprint: ${pki.selfSigned.fingerprint256}`);
    expect(text).toContain('defaultHost: lab');
    expect(text).toContain('pve_guest_delete: true # [D] Delete a guest');
    expect(statSync(file).mode & 0o777).toBe(0o600);
    const all = cli.prompter.messages.join('\n');
    expect(all).not.toContain(SECRET);
    expect(all).toMatch(/Proxmox VE 9\.1\.2/);
    expect(all).toMatch(/token add mcp@pve agent --privsep 1/);
  });

  it('writes nothing when the user cancels half way', async () => {
    const { run: runSetup } = await import('../src/cli/setup.js');
    const { existsSync } = await import('node:fs');
    const { CancelledError } = await import('../src/cli/errors.js');
    const cli = testCli({ configPath: file, interactive: true, answers: ['lab', server.url] });
    cli.ctx.prompter.select = async () => {
      throw new CancelledError();
    };
    expect(await runSetup([], cli.ctx)).toBe(130);
    expect(existsSync(file)).toBe(false);
    expect(cli.keyring.entries.size).toBe(0);
  });
});
