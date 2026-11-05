import { describe, expect, it } from 'vitest';
import { secretFileProblem } from '../src/secrets/providers/file.js';

const ME = 1000;

describe('secretFileProblem', () => {
  it('accepts private files of the current user or root', () => {
    expect(secretFileProblem({ path: '/home/u/s', mode: 0o100600, uid: ME }, ME)).toBeUndefined();
    expect(secretFileProblem({ path: '/home/u/s', mode: 0o100400, uid: 0 }, ME)).toBeUndefined();
  });

  it('refuses files readable by group or others outside /run/secrets', () => {
    expect(secretFileProblem({ path: '/home/u/s', mode: 0o100644, uid: ME }, ME)).toMatch(
      /accessible by group or others \(mode 644\)/,
    );
    expect(secretFileProblem({ path: '/etc/s', mode: 0o100444, uid: 0 }, ME)).toMatch(/mode 444/);
  });

  it('refuses files of other users', () => {
    expect(secretFileProblem({ path: '/home/u/s', mode: 0o100600, uid: 1234 }, ME)).toMatch(
      /owned by another user/,
    );
  });

  it('accepts root owned container secrets with 0444 or 0644 under /run/secrets', () => {
    for (const mode of [0o100444, 0o100644, 0o100440, 0o100400]) {
      expect(
        secretFileProblem(
          { path: '/run/secrets/pve', realPath: '/run/secrets/pve', mode, uid: 0 },
          ME,
        ),
      ).toBeUndefined();
    }
    // Kubernetes projects secrets through ..data symlinks inside the same directory.
    expect(
      secretFileProblem(
        {
          path: '/run/secrets/pve/token',
          realPath: '/run/secrets/pve/..2026_11_05/token',
          mode: 0o100644,
          uid: 0,
        },
        ME,
      ),
    ).toBeUndefined();
  });

  it('stays strict under /run/secrets when the file is not owned by root', () => {
    expect(secretFileProblem({ path: '/run/secrets/pve', mode: 0o100644, uid: ME }, ME)).toMatch(
      /accessible by group or others/,
    );
  });

  it('stays strict under /run/secrets when group or others can write', () => {
    expect(secretFileProblem({ path: '/run/secrets/pve', mode: 0o100666, uid: 0 }, ME)).toMatch(
      /mode 666/,
    );
    expect(secretFileProblem({ path: '/run/secrets/pve', mode: 0o100664, uid: 0 }, ME)).toMatch(
      /mode 664/,
    );
  });

  it('stays strict when the real path leaves /run/secrets', () => {
    expect(
      secretFileProblem(
        { path: '/run/secrets/pve', realPath: '/etc/ssl/private.pem', mode: 0o100644, uid: 0 },
        ME,
      ),
    ).toMatch(/accessible by group or others/);
    expect(secretFileProblem({ path: '/run/secretsX/pve', mode: 0o100644, uid: 0 }, ME)).toMatch(
      /accessible by group or others/,
    );
    expect(
      secretFileProblem({ path: '/var/run/secrets-other', mode: 0o100644, uid: 0 }, ME),
    ).toMatch(/accessible by group or others/);
  });
});
