import { afterEach, describe, expect, it } from 'vitest';
import { clearRegisteredSecrets, registerSecret } from '../src/proxmox/errors.js';
import { errorMessage, errorResult, formatError, formatResult } from '../src/server/format.js';

const SECRET = 'deadbeef-1111-2222-3333-444455556666';

function text(result: { content: unknown[] }): string {
  return (result.content[0] as { text: string }).text;
}

afterEach(() => clearRegisteredSecrets());

describe('redaction in tool output', () => {
  it('removes registered secrets from results', () => {
    registerSecret(SECRET);
    const out = text(formatResult({ note: `token is ${SECRET}` }, 10000));
    expect(out).not.toContain(SECRET);
    expect(out).toContain('[REDACTED]');
    expect(text(formatResult(`plain ${SECRET}`, 10000))).toBe('plain [REDACTED]');
  });

  it('redacts before truncating, so a cut secret cannot leak', () => {
    registerSecret(SECRET);
    const prefix = 'x'.repeat(90);
    // The cut at 100 characters would keep the first 10 characters of the secret.
    const out = text(formatResult(`${prefix}${SECRET}${'z'.repeat(50)}`, 100));
    expect(out).not.toContain(SECRET.slice(0, 10));
    expect(out).toContain('Output truncated');
  });

  it('removes registered secrets from every error path', () => {
    registerSecret(SECRET);
    expect(errorMessage(new Error(`failed with ${SECRET}`))).toBe('failed with [REDACTED]');
    expect(errorMessage(`raw ${SECRET}`)).toBe('raw [REDACTED]');
    const api = Object.assign(new Error(`denied ${SECRET}`), {
      status: 403,
      errors: { token: SECRET },
    });
    const apiText = text(formatError(api));
    expect(apiText).not.toContain(SECRET);
    expect(text(errorResult(`refused ${SECRET}`))).toBe('refused [REDACTED]');
  });

  it('redacts before clipping long error messages', () => {
    registerSecret(SECRET);
    const msg = errorMessage(new Error(`${'y'.repeat(1990)}${SECRET}`));
    expect(msg).not.toContain(SECRET.slice(0, 10));
  });
});
