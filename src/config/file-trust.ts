/*
 * Trust checks for files that steer the server without being secrets: the
 * settings file (which tools exist, which hosts, which TLS trust) and
 * tls.caFile (which certificates are trusted). Whoever can change such a
 * file can disable safety switches or redirect the token to another server,
 * so on POSIX it must belong to the server user or root and must not be
 * writable by group or others. The directory holding the settings file must
 * not be writable by group or others either, unless it has the sticky bit
 * (like /tmp), because then the file could be replaced. Windows has no
 * comparable mode bits and is skipped by the callers.
 */

export interface TrustInfo {
  path: string;
  mode: number;
  uid: number;
}

const STICKY = 0o1000;

function modeText(mode: number): string {
  return (mode & 0o7777).toString(8);
}

/** The reason a file must not be trusted, or undefined when it is fine. */
export function untrustedFileProblem(
  what: string,
  info: TrustInfo,
  selfUid: number | undefined = process.getuid?.(),
): string | undefined {
  const shown = JSON.stringify(info.path);
  if ((info.mode & 0o022) !== 0) {
    return (
      `${what} ${shown} is writable by group or others (mode ${modeText(info.mode)}), so another ` +
      `user could change it. Run: chmod go-w ${shown}`
    );
  }
  if (selfUid !== undefined && info.uid !== selfUid && info.uid !== 0) {
    return (
      `${what} ${shown} is owned by another user (uid ${info.uid}). It must belong to the user ` +
      `running the server (uid ${selfUid}) or to root. Copy it to a file you own, or run as root: ` +
      `chown ${selfUid} ${shown}`
    );
  }
  return undefined;
}

/** The reason a directory must not hold a trusted file, or undefined when it is fine. */
export function untrustedDirProblem(what: string, info: TrustInfo): string | undefined {
  if ((info.mode & 0o022) !== 0 && (info.mode & STICKY) === 0) {
    const shown = JSON.stringify(info.path);
    return (
      `The directory ${shown} of the ${what} is writable by group or others (mode ` +
      `${modeText(info.mode)}) without the sticky bit, so another user could replace the file. ` +
      `Run: chmod go-w ${shown}, or move the file to a private directory.`
    );
  }
  return undefined;
}
