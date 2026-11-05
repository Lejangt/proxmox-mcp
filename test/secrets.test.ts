import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { clearRegisteredSecrets, redactSecrets, SecretError } from '../src/proxmox/errors.js';
import { resolveSecret } from '../src/secrets/resolve.js';
import { runSecretCommand } from '../src/secrets/run-command.js';
import type { SecretRef } from '../src/secrets/types.js';

const posix = process.platform !== 'win32';
let dir: string;
let bin: string;

/*
 * Fake CLIs: they log argv (one per line) and their environment next to
 * themselves and print a canned answer. No real secret manager is called.
 */
function fake(name: string, body: string): string {
  const file = path.join(bin, name);
  const log = path.join(dir, name);
  writeFileSync(
    file,
    `#!/bin/sh\nfor a in "$@"; do printf '%s\\n' "$a"; done > '${log}.args'\nenv > '${log}.env'\n${body}\n`,
  );
  chmodSync(file, 0o755);
  return file;
}
const args = (name: string) =>
  readFileSync(path.join(dir, `${name}.args`), 'utf8')
    .split('\n')
    .slice(0, -1);
const childEnv = (name: string) => readFileSync(path.join(dir, `${name}.env`), 'utf8');

function ctx(env: NodeJS.ProcessEnv = {}) {
  return {
    host: 'lab',
    env: {
      PATH: `${bin}:/usr/bin:/bin`,
      HOME: dir,
      PARENT_ONLY_SECRET: 'parent-value-123',
      ...env,
    },
  };
}

beforeAll(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'pve-mcp-secrets-'));
  bin = path.join(dir, 'bin');
  mkdirSync(bin);
});
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
  clearRegisteredSecrets();
});

describe('env source', () => {
  it('reads and trims the variable', async () => {
    await expect(resolveSecret({ source: 'env', name: 'S' }, ctx({ S: ' abc \n' }))).resolves.toBe(
      'abc',
    );
  });
  it('fails with source and host but no value', async () => {
    const err = await resolveSecret({ source: 'env', name: 'S' }, ctx({ S: '' })).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(SecretError);
    expect(String(err)).toMatch(/host "lab".*source env/);
  });
});

describe.skipIf(!posix)('file source', () => {
  const write = (name: string, content: string, mode: number) => {
    const file = path.join(dir, name);
    writeFileSync(file, content);
    chmodSync(file, mode);
    return file;
  };

  it('reads a 0600 file and trims it', async () => {
    const file = write('ok.secret', 'file-secret-value\n', 0o600);
    await expect(resolveSecret({ source: 'file', path: file }, ctx())).resolves.toBe(
      'file-secret-value',
    );
  });

  it('rejects files readable by group or others without leaking the content', async () => {
    for (const mode of [0o640, 0o604, 0o660]) {
      const file = write(`open-${mode.toString(8)}.secret`, 'leaky-value', mode);
      const err = await resolveSecret({ source: 'file', path: file }, ctx()).catch(
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(SecretError);
      expect(String(err)).toMatch(/group or others/);
      expect(String(err)).not.toContain('leaky-value');
    }
  });

  it('follows a symlink owned by the user to a private file', async () => {
    const target = write('target.secret', 'linked-value', 0o600);
    const link = path.join(dir, 'link.secret');
    symlinkSync(target, link);
    await expect(resolveSecret({ source: 'file', path: link }, ctx())).resolves.toBe(
      'linked-value',
    );
  });

  it('rejects empty files, directories and missing files', async () => {
    const empty = write('empty.secret', ' \n', 0o600);
    await expect(resolveSecret({ source: 'file', path: empty }, ctx())).rejects.toThrow(/empty/);
    const sub = path.join(dir, 'subdir');
    mkdirSync(sub, { mode: 0o700 });
    await expect(resolveSecret({ source: 'file', path: sub }, ctx())).rejects.toThrow(
      /regular file/,
    );
    await expect(
      resolveSecret({ source: 'file', path: path.join(dir, 'nope') }, ctx()),
    ).rejects.toThrow(/cannot access/);
  });
});

describe('keyring source', () => {
  it('reads service proxmox-ve-mcp and the host alias by default', async () => {
    const seen: string[][] = [];
    vi.doMock('@napi-rs/keyring', () => ({
      AsyncEntry: class {
        constructor(
          private service: string,
          private account: string,
        ) {
          seen.push([service, account]);
        }
        getPassword() {
          return Promise.resolve(this.account === 'lab' ? 'kr-secret-1' : null);
        }
      },
    }));
    const { resolveKeyringSecret } = await import('../src/secrets/providers/keyring.js');
    await expect(resolveKeyringSecret({}, { host: 'lab' })).resolves.toBe('kr-secret-1');
    expect(seen[0]).toEqual(['proxmox-ve-mcp', 'lab']);
    await expect(resolveKeyringSecret({ account: 'other' }, { host: 'lab' })).rejects.toThrow(
      /no entry.*secret set lab/,
    );
    vi.doUnmock('@napi-rs/keyring');
  });
});

describe.skipIf(!posix)('bws source', () => {
  const id = '00000000-0000-0000-0000-000000000001';

  it('passes the access token only through the environment', async () => {
    const binary = fake('bws', `printf '{"id":"${id}","key":"k","value":"  bws-secret-value  "}'`);
    const ref: SecretRef = {
      source: 'bws',
      secretId: id,
      binary,
      serverUrl: 'https://vault.bitwarden.eu',
    };
    await expect(resolveSecret(ref, ctx({ BWS_ACCESS_TOKEN: 'access-token-abc' }))).resolves.toBe(
      'bws-secret-value',
    );
    expect(args('bws')).toEqual(['secret', 'get', id, '--output', 'json', '--color', 'no']);
    expect(args('bws').join(' ')).not.toContain('access-token-abc');
    const env = childEnv('bws');
    expect(env).toContain('BWS_ACCESS_TOKEN=access-token-abc');
    expect(env).toContain('BWS_SERVER_URL=https://vault.bitwarden.eu');
    expect(env).not.toContain('PARENT_ONLY_SECRET');
  });

  it('resolves a nested access token', async () => {
    const binary = fake('bws', `printf '{"value":"v2"}'`);
    const ref: SecretRef = {
      source: 'bws',
      secretId: id,
      binary,
      accessToken: { source: 'env', name: 'MY_BWS' },
    };
    await expect(resolveSecret(ref, ctx({ MY_BWS: 'nested-token-1' }))).resolves.toBe('v2');
    expect(childEnv('bws')).toContain('BWS_ACCESS_TOKEN=nested-token-1');
  });

  it('refuses nested bws and missing tokens', async () => {
    const binary = fake('bws', `printf '{"value":"v"}'`);
    const nested = {
      source: 'bws',
      secretId: id,
      binary,
      accessToken: { source: 'bws', secretId: id },
    } as SecretRef;
    await expect(resolveSecret(nested, ctx({ BWS_ACCESS_TOKEN: 'x' }))).rejects.toThrow(/bws/);
    await expect(resolveSecret({ source: 'bws', secretId: id, binary }, ctx())).rejects.toThrow(
      /BWS_ACCESS_TOKEN/,
    );
  });

  it('keeps the token out of error messages', async () => {
    const binary = fake('bws', `echo "invalid token access-token-zzz" >&2; exit 3`);
    const err = await resolveSecret(
      { source: 'bws', secretId: id, binary },
      ctx({ BWS_ACCESS_TOKEN: 'access-token-zzz' }),
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SecretError);
    expect(String(err)).toMatch(/exited with code 3/);
    expect(String(err)).not.toContain('access-token-zzz');
  });
});

describe.skipIf(!posix)('1password source', () => {
  it('runs op read with --no-newline and the account', async () => {
    const binary = fake('op', `printf 'op-secret'`);
    await expect(
      resolveSecret(
        { source: '1password', ref: 'op://vault/item/field', account: 'team', binary },
        ctx({ OP_SERVICE_ACCOUNT_TOKEN: 'ops', OP_SESSION_abc: 's' }),
      ),
    ).resolves.toBe('op-secret');
    expect(args('op')).toEqual([
      '--account',
      'team',
      'read',
      '--no-newline',
      'op://vault/item/field',
    ]);
    expect(childEnv('op')).toContain('OP_SERVICE_ACCOUNT_TOKEN=ops');
    expect(childEnv('op')).toContain('OP_SESSION_abc=s');
  });
});

describe.skipIf(!posix)('vault source', () => {
  it('runs kv get with mount and field and passes the token by env', async () => {
    const binary = fake('vault', `printf 'vault-secret'`);
    const ref: SecretRef = {
      source: 'vault',
      path: 'pve/lab',
      field: 'secret',
      mount: 'kv',
      address: 'https://vault.example.com:8200',
      namespace: 'team',
      token: { source: 'env', name: 'MY_VAULT_TOKEN' },
      binary,
    };
    await expect(
      resolveSecret(ref, ctx({ MY_VAULT_TOKEN: 'vault-token-1', VAULT_SKIP_VERIFY: '1' })),
    ).resolves.toBe('vault-secret');
    expect(args('vault')).toEqual(['kv', 'get', '-mount=kv', '-field=secret', 'pve/lab']);
    const env = childEnv('vault');
    expect(env).toContain('VAULT_TOKEN=vault-token-1');
    expect(env).toContain('BAO_TOKEN=vault-token-1');
    expect(env).toContain('VAULT_ADDR=https://vault.example.com:8200');
    expect(env).toContain('VAULT_NAMESPACE=team');
    expect(env).not.toContain('VAULT_SKIP_VERIFY');
    expect(args('vault').join(' ')).not.toContain('vault-token-1');
  });
});

describe.skipIf(!posix)('pass source', () => {
  it('uses the first line of pass show', async () => {
    const binary = fake('pass', `printf 'pass-secret\\nuser: x\\nurl: y\\n'`);
    await expect(resolveSecret({ source: 'pass', name: 'pve/lab', binary }, ctx())).resolves.toBe(
      'pass-secret',
    );
    expect(args('pass')).toEqual(['show', 'pve/lab']);
  });
});

describe.skipIf(!posix)('command source and runSecretCommand', () => {
  it('runs argv without a shell', async () => {
    const marker = path.join(dir, 'pwned');
    const binary = fake('cmd', `printf '%s' "$1"`);
    await expect(
      resolveSecret({ source: 'command', command: [binary, `$(touch ${marker})`] }, ctx()),
    ).resolves.toBe(`$(touch ${marker})`);
    expect(existsSync(marker)).toBe(false);
  });

  it('passes only a minimal environment', async () => {
    const binary = fake('envcheck', `printf ok`);
    await resolveSecret({ source: 'command', command: [binary] }, ctx());
    const env = childEnv('envcheck');
    expect(env).toContain(`HOME=${dir}`);
    expect(env).not.toContain('PARENT_ONLY_SECRET');
  });

  it('times out', async () => {
    const binary = fake('slow', 'sleep 5; printf late');
    const started = Date.now();
    await expect(
      runSecretCommand({ argv: [binary], label: 'test', timeoutMs: 200, parentEnv: ctx().env }),
    ).rejects.toThrow(/timed out/);
    expect(Date.now() - started).toBeLessThan(3000);
  });

  it('limits the output size', async () => {
    const binary = fake('big', `head -c 200000 /dev/zero | tr '\\0' 'a'`);
    await expect(
      runSecretCommand({
        argv: [binary],
        label: 'test',
        maxOutputBytes: 1000,
        parentEnv: ctx().env,
      }),
    ).rejects.toThrow(/larger than/);
  });

  it('treats empty output, missing binaries and failures as errors without stdout', async () => {
    const empty = fake('empty', `printf '  \\n'`);
    await expect(resolveSecret({ source: 'command', command: [empty] }, ctx())).rejects.toThrow(
      /printed nothing/,
    );
    await expect(
      resolveSecret({ source: 'command', command: [path.join(bin, 'nope')] }, ctx()),
    ).rejects.toThrow(/not found/);
    const failing = fake(
      'failing',
      `printf 'half-secret-value'; echo "error: half-secret-value" >&2; exit 1`,
    );
    const err = await resolveSecret({ source: 'command', command: [failing] }, ctx()).catch(
      (e: unknown) => e,
    );
    expect(String(err)).toMatch(/exited with code 1/);
    expect(String(err)).not.toContain('half-secret-value');
  });

  it('registers resolved secrets for redaction', async () => {
    const binary = fake('reg', `printf 'registered-secret-42'`);
    await resolveSecret({ source: 'command', command: [binary] }, ctx());
    expect(redactSecrets('x registered-secret-42 y')).toBe('x [REDACTED] y');
  });
});
