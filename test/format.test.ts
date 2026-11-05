import { describe, expect, it } from 'vitest';
import { errorMessage, formatError, formatResult, truncate } from '../src/server/format.js';

describe('formatResult', () => {
  it('serializes JSON with two space indentation', () => {
    const r = formatResult({ a: 1, b: [2] }, 1000);
    expect(r.isError).toBeUndefined();
    expect(r.content[0]).toEqual({ type: 'text', text: '{\n  "a": 1,\n  "b": [\n    2\n  ]\n}' });
  });

  it('passes strings through and renders undefined as null', () => {
    expect(formatResult('plain', 100).content[0]).toEqual({ type: 'text', text: 'plain' });
    expect(formatResult(undefined, 100).content[0]).toEqual({ type: 'text', text: 'null' });
  });

  it('truncates with a hint how to narrow the query', () => {
    const r = formatResult({ text: 'x'.repeat(500) }, 100);
    const text = (r.content[0] as { text: string }).text;
    expect(text.startsWith('{\n  "text": "xxx')).toBe(true);
    expect(text).toContain('Output truncated: showing 100 of');
    expect(text).toContain('Narrow the query');
  });

  it('keeps short output untouched', () => {
    expect(truncate('abc', 3)).toBe('abc');
  });
});

describe('errors', () => {
  it('shows Proxmox parameter errors without a stack', () => {
    const err = Object.assign(new Error('Parameter verification failed.'), {
      status: 400,
      errors: { vmid: 'value must be at least 100', memory: 'invalid' },
    });
    const r = formatError(err);
    expect(r.isError).toBe(true);
    const text = (r.content[0] as { text: string }).text;
    expect(text).toContain('HTTP 400');
    expect(text).toContain('vmid: value must be at least 100');
    expect(text).not.toMatch(/\n\s+at /);
  });

  it('handles plain errors, aborts and non errors', () => {
    expect(errorMessage(new Error('boom'))).toBe('boom');
    const abort = new Error('x');
    abort.name = 'AbortError';
    expect(errorMessage(abort)).toBe('The request was cancelled.');
    expect(errorMessage(42)).toBe('Unknown error');
    expect(errorMessage('text')).toBe('text');
  });

  it('clips very long messages', () => {
    expect(errorMessage(new Error('y'.repeat(5000))).length).toBeLessThan(2100);
  });

  it('does not treat an object with a non numeric status as an API error', () => {
    expect(errorMessage(Object.assign(new Error('m'), { status: 'bad' }))).toBe('m');
  });
});
