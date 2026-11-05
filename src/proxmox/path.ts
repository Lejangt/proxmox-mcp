/**
 * Proxmox API path construction and validation.
 *
 * Paths are relative to /api2/json. They are built by tools (pvePath) and by
 * the agent through the raw API tools, so the client treats every path as
 * untrusted and validates it again before each request.
 */

export class InvalidApiPathError extends TypeError {
  override name = 'InvalidApiPathError';
}

const MAX_PATH_LENGTH = 2048;
/** Unreserved characters, percent signs, the sub-delims and ':' '@' of RFC 3986. */
const ALLOWED_PATH = /^[A-Za-z0-9\-._~%!$&'()*+,;=:@/]+$/;
const PERCENT_SEQUENCE = /%(?![0-9A-Fa-f]{2})/;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;
/*
 * How often a segment is decoded while looking for traversal. A server or
 * proxy in front of Proxmox could decode more than once, so encoded dots like
 * %252e%252e are treated as traversal as well.
 */
const DECODE_ROUNDS = 3;

function fail(path: unknown, reason: string): never {
  const shown = typeof path === 'string' ? JSON.stringify(path.slice(0, 200)) : typeof path;
  throw new InvalidApiPathError(`Invalid API path ${shown}: ${reason}`);
}

function checkDecodedSegment(path: string, segment: string): void {
  let current = segment;
  for (let round = 0; round < DECODE_ROUNDS; round++) {
    let decoded: string;
    try {
      decoded = decodeURIComponent(current);
    } catch {
      fail(path, 'invalid percent-encoding');
    }
    if (CONTROL.test(decoded)) fail(path, 'control characters are not allowed');
    if (decoded.includes('\\')) fail(path, 'backslashes are not allowed');
    // A decoded slash splits the value into parts that a decoding server or
    // proxy would see as segments, so dot parts inside it count as well.
    for (const part of decoded.split('/')) {
      if (part === '.' || part === '..') fail(path, 'dot segments are not allowed');
    }
    if (decoded === current) break;
    current = decoded;
  }
}

/**
 * Throws InvalidApiPathError unless `path` is a relative Proxmox API path:
 * leading '/', no empty, '.' or '..' segments (also when percent-encoded), no
 * query, fragment, backslash or control characters, and only characters from
 * the allowed set. Returns the path unchanged for convenience.
 */
export function validateApiPath(path: string): string {
  if (typeof path !== 'string') fail(path, 'must be a string');
  if (path.length === 0) fail(path, 'must not be empty');
  if (path.length > MAX_PATH_LENGTH) fail(path, `longer than ${MAX_PATH_LENGTH} characters`);
  if (!path.startsWith('/')) fail(path, 'must start with "/" and be relative to /api2/json');
  if (path.includes('?') || path.includes('#')) {
    fail(path, 'query strings and fragments are not allowed, pass parameters separately');
  }
  if (path.includes('\\')) fail(path, 'backslashes are not allowed');
  if (CONTROL.test(path)) fail(path, 'control characters are not allowed');
  if (!ALLOWED_PATH.test(path)) fail(path, 'contains characters outside the allowed set');
  if (PERCENT_SEQUENCE.test(path)) fail(path, 'invalid percent-encoding');
  if (path === '/') return path;
  const segments = path.slice(1).split('/');
  for (const segment of segments) {
    if (segment.length === 0) fail(path, 'empty segments ("//" or a trailing "/") are not allowed');
    checkDecodedSegment(path, segment);
  }
  return path;
}

const VOLID_BRAND: unique symbol = Symbol('pvePath.volid');

/**
 * A Proxmox volume id marked for use as one path segment. Volume ids are the
 * only values that legitimately contain "/" (for example
 * "local:iso/debian.iso"), see volid().
 */
export interface VolumeIdSegment {
  readonly [VOLID_BRAND]: string;
}

/** storage:rest, the storage part follows the pve-storage-id format. */
const VOLID_PATTERN = /^[A-Za-z][A-Za-z0-9_.-]*:[^\s]+$/;

/**
 * Marks a volume id so pvePath accepts the "/" in it. pveproxy decodes the
 * path before routing, so the encoded slash (%2F) arrives as a real "/".
 * Proxmox still resolves the volume routes correctly
 * (/nodes/{node}/storage/{storage}/content/{volume}, checked against
 * Proxmox VE 9.2), so use it only as the last value of such a route. The
 * value must look like storage:name, without whitespace, control
 * characters, backslashes and empty, "." or ".." parts.
 */
export function volid(value: string): VolumeIdSegment {
  if (typeof value !== 'string' || !VOLID_PATTERN.test(value) || value.length > 512) {
    throw new TypeError(
      `pvePath: ${JSON.stringify(String(value).slice(0, 100))} is not a volume id`,
    );
  }
  if (CONTROL.test(value) || value.includes('\\')) {
    throw new TypeError('pvePath: volume id contains control characters or backslashes');
  }
  const rest = value.slice(value.indexOf(':') + 1);
  for (const part of rest.split('/')) {
    if (part === '' || part === '.' || part === '..') {
      throw new TypeError('pvePath: volume id contains an empty, "." or ".." part');
    }
  }
  return { [VOLID_BRAND]: value };
}

function isVolumeId(value: unknown): value is VolumeIdSegment {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as Partial<VolumeIdSegment>)[VOLID_BRAND] === 'string'
  );
}

export type PathValue = string | number | VolumeIdSegment;

/**
 * Tagged template for Proxmox API paths. Every interpolated value is
 * percent-encoded as one path segment, so user input cannot add segments,
 * query strings or traversal sequences. Values that would still be a dot
 * segment after encoding ('.' and '..') and empty values are rejected, and
 * the finished path is validated with validateApiPath.
 *
 * pveproxy decodes the whole path before it routes the request, so an
 * encoded "/" (%2F) in a value would become a segment separator there.
 * Plain values with "/" are therefore rejected. Volume ids, which contain
 * "/" by design, must be passed through volid().
 */
export function pvePath(strings: TemplateStringsArray, ...values: PathValue[]): string {
  let out = strings[0] ?? '';
  values.forEach((value, i) => {
    if (value === undefined || value === null) {
      throw new TypeError(`pvePath: value at position ${i} is ${String(value)}`);
    }
    let text: string;
    if (isVolumeId(value)) {
      text = value[VOLID_BRAND];
    } else if (typeof value === 'number') {
      if (!Number.isFinite(value)) {
        throw new TypeError(`pvePath: value at position ${i} is not a finite number`);
      }
      text = String(value);
    } else if (typeof value === 'string') {
      if (value.includes('/')) {
        throw new TypeError(
          `pvePath: value at position ${i} contains "/", which Proxmox would read as a path separator`,
        );
      }
      text = value;
    } else {
      throw new TypeError(`pvePath: value at position ${i} must be a string or number`);
    }
    if (text === '' || text === '.' || text === '..') {
      throw new TypeError(`pvePath: value at position ${i} is empty or a dot segment`);
    }
    let encoded: string;
    try {
      encoded = encodeURIComponent(text);
    } catch {
      throw new TypeError(`pvePath: value at position ${i} is not valid Unicode`);
    }
    out += encoded + (strings[i + 1] ?? '');
  });
  return validateApiPath(out);
}
