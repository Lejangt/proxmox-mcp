export const PROXMOX_DEFAULT_PORT = 8006;

/**
 * Turns user input into the origin of a Proxmox API endpoint.
 *
 * - `pve.example.com` becomes `https://pve.example.com:8006`
 * - `pve.example.com:443` keeps the port
 * - a bare IPv6 address gets brackets, `[2001:db8::1]:8443` keeps its port
 * - a pasted browser URL loses its `#v1:...` fragment, a trailing `/` or
 *   `/api2/json` path is accepted
 * - only https is accepted, credentials, other paths and queries are errors
 *
 * Throws an Error with a message meant for the user.
 */
export function normalizeHostUrl(input: string): string {
  const raw = input.trim();
  if (raw === '') throw new Error('Enter a host name, IP address or URL.');
  // eslint-disable-next-line no-control-regex
  if (/[\s\u0000-\u001f\u007f]/.test(raw)) throw new Error('The URL must not contain spaces.');

  let withScheme = raw;
  const scheme = /^([a-zA-Z][a-zA-Z0-9+.-]*):\/\//.exec(raw);
  if (scheme) {
    if (scheme[1]!.toLowerCase() !== 'https') {
      throw new Error(
        'Only https is supported. The Proxmox API listens on https://<host>:8006 by default.',
      );
    }
  } else {
    let authority = raw;
    // A bare IPv6 address has more than one colon and no brackets.
    const end = authority.search(/[/?#]/);
    const host = end === -1 ? authority : authority.slice(0, end);
    if (!host.startsWith('[') && (host.match(/:/g)?.length ?? 0) > 1) {
      authority = `[${host}]${end === -1 ? '' : authority.slice(end)}`;
    }
    withScheme = `https://${authority}`;
  }

  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    throw new Error('This is not a valid host name or URL.');
  }
  if (url.username || url.password) {
    throw new Error('The URL must not contain a user name or password.');
  }
  if (url.hostname === '') throw new Error('The URL has no host name.');
  if (url.search) throw new Error('The URL must not contain a query (?...).');
  const pathname = url.pathname.replace(/\/+$/, '');
  if (pathname !== '' && pathname !== '/api2/json') {
    throw new Error('The URL must not contain a path. Example: https://pve.example.com:8006');
  }

  // URL drops an explicit :443, so look at the authority of the input itself.
  const authority = withScheme.slice(withScheme.indexOf('//') + 2).split(/[/?#]/)[0] ?? '';
  const explicitPort = /(?:^|[\]a-zA-Z0-9.-]):(\d+)$/.test(authority);
  if (!explicitPort) url.port = String(PROXMOX_DEFAULT_PORT);
  return url.origin;
}
