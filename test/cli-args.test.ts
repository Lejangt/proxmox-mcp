import { describe, expect, it } from 'vitest';
import { extractConfigPath } from '../src/cli/args.js';

describe('extractConfigPath', () => {
  it('reads --config with a separate value or an equals sign', () => {
    expect(extractConfigPath(['--config', '/a.yaml'])).toEqual({ configPath: '/a.yaml', rest: [] });
    expect(extractConfigPath(['--config=/b.yaml', 'x'])).toEqual({
      configPath: '/b.yaml',
      rest: ['x'],
    });
  });

  it('leaves other arguments alone and fails on a missing value', () => {
    expect(extractConfigPath(['a', 'b'])).toEqual({ rest: ['a', 'b'] });
    expect(() => extractConfigPath(['--config'])).toThrow('--config needs a path');
  });
});
