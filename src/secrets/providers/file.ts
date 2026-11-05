import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import path from 'node:path';
import { expandHome } from '../../config/paths.js';
import { secretError, type SecretContext } from './shared.js';

const MAX_SECRET_FILE_BYTES = 64 * 1024;

/*
 * Docker and Kubernetes mount secrets under /run/secrets, owned by root and
 * often with mode 0444 or 0644 so that a non-root process in the container
 * can read them. Such files are accepted when they are owned by root and
 * nobody but root can write them, both for the path and its real target.
 */
export const CONTAINER_SECRETS_DIR = '/run/secrets/';

export interface SecretFileInfo {
  /** Absolute path as configured (after ~ expansion). */
  path: string;
  /** Real path after resolving symlinks, when known. */
  realPath?: string;
  mode: number;
  uid: number;
}

/**
 * Permission policy for secret files on POSIX. Returns the reason the file is
 * refused, or undefined when it is acceptable. Pure, so it can be tested
 * without touching the file system.
 */
export function secretFileProblem(
  info: SecretFileInfo,
  selfUid: number | undefined = process.getuid?.(),
): string | undefined {
  const shown = JSON.stringify(info.path);
  const inContainerDir = (p: string | undefined) =>
    p !== undefined && p.startsWith(CONTAINER_SECRETS_DIR);
  if (
    inContainerDir(info.path) &&
    inContainerDir(info.realPath ?? info.path) &&
    info.uid === 0 &&
    (info.mode & 0o022) === 0
  ) {
    return undefined;
  }
  if ((info.mode & 0o077) !== 0) {
    return `${shown} is accessible by group or others (mode ${(info.mode & 0o777).toString(8)}). Run: chmod 600 ${info.path}`;
  }
  const trusted = selfUid === undefined || info.uid === selfUid || info.uid === 0;
  if (!trusted) return `${shown} is owned by another user (uid ${info.uid})`;
  return undefined;
}

function trustedOwner(uid: number): boolean {
  const self = process.getuid?.();
  // root owned files are accepted: root can read everything anyway, and
  // container runtimes mount secrets as root.
  return self === undefined || uid === self || uid === 0;
}

/**
 * Reads a secret from a file. On POSIX the file must be a regular file owned
 * by the current user or root and must not be accessible by group or others,
 * except for root owned container secrets under /run/secrets (see
 * secretFileProblem). A symlink is followed only when the link itself has a
 * trusted owner.
 */
export async function resolveFileSecret(
  ref: { path: string },
  ctx: SecretContext,
): Promise<string> {
  const filePath = path.resolve(expandHome(ref.path));
  const shown = JSON.stringify(filePath);
  const posix = process.platform !== 'win32';

  let realPath: string | undefined;
  if (posix) {
    let linkStat;
    try {
      linkStat = await lstat(filePath);
    } catch (err) {
      throw secretError(
        ctx,
        'file',
        `cannot access ${shown} (${(err as NodeJS.ErrnoException).code ?? 'error'})`,
      );
    }
    if (linkStat.isSymbolicLink()) {
      if (!trustedOwner(linkStat.uid)) {
        throw secretError(ctx, 'file', `${shown} is a symlink owned by another user`);
      }
    }
    // The opened file is checked below. The real path (with every symlink in
    // the path resolved) only decides whether the /run/secrets rule applies.
    realPath = await realpath(filePath).catch(() => {
      throw secretError(ctx, 'file', `${shown} is a dangling symlink`);
    });
  }

  let handle;
  try {
    handle = await open(filePath, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));
  } catch (err) {
    throw secretError(
      ctx,
      'file',
      `cannot open ${shown} (${(err as NodeJS.ErrnoException).code ?? 'error'})`,
    );
  }
  try {
    // Checks run on the opened handle so the file cannot be swapped in between.
    const info = await handle.stat();
    if (!info.isFile()) throw secretError(ctx, 'file', `${shown} is not a regular file`);
    if (posix) {
      const problem = secretFileProblem({
        path: filePath,
        ...(realPath !== undefined ? { realPath } : {}),
        mode: info.mode,
        uid: info.uid,
      });
      if (problem) throw secretError(ctx, 'file', problem);
    }
    if (info.size > MAX_SECRET_FILE_BYTES) {
      throw secretError(ctx, 'file', `${shown} is larger than ${MAX_SECRET_FILE_BYTES} bytes`);
    }
    const buffer = Buffer.alloc(MAX_SECRET_FILE_BYTES + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > MAX_SECRET_FILE_BYTES) {
      buffer.fill(0);
      throw secretError(ctx, 'file', `${shown} is larger than ${MAX_SECRET_FILE_BYTES} bytes`);
    }
    const value = buffer.subarray(0, bytesRead).toString('utf8').trim();
    buffer.fill(0);
    if (!value) throw secretError(ctx, 'file', `${shown} is empty`);
    return value;
  } finally {
    await handle.close();
  }
}
