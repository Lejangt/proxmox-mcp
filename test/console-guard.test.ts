import { Console } from 'node:console';
import { Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { redirectConsole, STDOUT_CONSOLE_METHODS } from '../src/server/console-guard.js';

function sink(): { stream: Writable; text: () => string } {
  const chunks: string[] = [];
  const stream = new Writable({
    write(chunk: Buffer, _encoding, done) {
      chunks.push(chunk.toString());
      done();
    },
  });
  return { stream, text: () => chunks.join('') };
}

describe('redirectConsole', () => {
  it('sends every stdout method to the given stream and nothing to stdout', () => {
    const out = sink();
    const err = sink();
    const target = new Console({ stdout: out.stream, stderr: out.stream });
    redirectConsole(target, err.stream);

    target.log('log-line');
    target.info('info-line');
    target.debug('debug-line');
    target.dir({ dir: 'dir-line' });
    target.dirxml('dirxml-line');
    target.table([{ table: 'table-line' }]);
    target.trace('trace-line');
    target.group('group-line');
    target.groupCollapsed('collapsed-line');
    target.groupEnd();
    target.groupEnd();
    target.count('count-line');
    target.countReset('count-line');
    target.time('time-line');
    target.timeLog('time-line');
    target.timeEnd('time-line');

    expect(out.text()).toBe('');
    for (const marker of [
      'log-line',
      'info-line',
      'debug-line',
      'dir-line',
      'dirxml-line',
      'table-line',
      'trace-line',
      'group-line',
      'collapsed-line',
      'count-line',
      'time-line',
    ]) {
      expect(err.text()).toContain(marker);
    }
  });

  it('covers every console method that writes to stdout', () => {
    expect([...STDOUT_CONSOLE_METHODS].sort()).toEqual(
      [
        'count',
        'countReset',
        'debug',
        'dir',
        'dirxml',
        'group',
        'groupCollapsed',
        'groupEnd',
        'info',
        'log',
        'table',
        'time',
        'timeEnd',
        'timeLog',
        'trace',
      ].sort(),
    );
  });
});
