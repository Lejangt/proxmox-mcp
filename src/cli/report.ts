import type { Colors } from './context.js';
import type { CheckLine, CheckStatus, HostReport } from './connection.js';
import { pad } from './common.js';

const LABEL_WIDTH = 12;

export function statusTag(status: CheckStatus, c: Colors): string {
  switch (status) {
    case 'ok':
      return c.green(pad('ok', 5));
    case 'warn':
      return c.yellow(pad('warn', 5));
    case 'fail':
      return c.red(pad('FAIL', 5));
    default:
      return c.dim(pad('skip', 5));
  }
}

export function renderLine(line: CheckLine, c: Colors): string {
  return `  ${statusTag(line.status, c)} ${pad(line.label, LABEL_WIDTH)} ${line.detail}\n`;
}

export function renderHostReport(report: HostReport, c: Colors): string {
  let out = `${c.bold(report.alias)}  ${c.dim(report.url)}\n`;
  for (const line of report.lines) out += renderLine(line, c);
  return out;
}
