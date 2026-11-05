#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { extractConfigPath } from './cli/args.js';

type CliModule = { run(args: string[]): Promise<number> };

// Loaded lazily so `serve` does not pull in the CLI dependencies (clack and others).
const COMMANDS: Record<string, () => Promise<CliModule>> = {
  setup: () => import('./cli/setup.js'),
  host: () => import('./cli/host.js'),
  secret: () => import('./cli/secret.js'),
  tools: () => import('./cli/tools.js'),
  config: () => import('./cli/config.js'),
  doctor: () => import('./cli/doctor.js'),
  'client-config': () => import('./cli/client-config.js'),
};

function version(): string {
  const url = new URL('../package.json', import.meta.url);
  return (JSON.parse(readFileSync(url, 'utf8')) as { version: string }).version;
}

function log(message: string): void {
  process.stderr.write(`[proxmox-ve-mcp] ${message}\n`);
}

async function printHelp(stream: NodeJS.WriteStream): Promise<void> {
  const [{ renderHelp, plainColors }, { createContext }] = await Promise.all([
    import('./cli/help.js'),
    import('./cli/context.js'),
  ]);
  const color = stream === process.stdout ? createContext().color : plainColors();
  stream.write(renderHelp(version(), color));
}

async function serve(args: string[]): Promise<number> {
  const { configPath, rest } = extractConfigPath(args);
  if (rest.length > 0) {
    process.stderr.write(`unexpected argument: ${rest[0]}\n`);
    await printHelp(process.stderr);
    return 2;
  }

  // Started by hand in a terminal: say what is going on (stderr only, stdout is the protocol).
  if (process.stdin.isTTY && process.stderr.isTTY) {
    log(
      'starting the MCP server on stdio, MCP clients run it this way. ' +
        'For the commands run `proxmox-ve-mcp help`, to get started `proxmox-ve-mcp setup`. Ctrl+C stops it.',
    );
  }

  // stdout carries the MCP protocol only, so stray console output goes to stderr.
  const { redirectConsole } = await import('./server/console-guard.js');
  redirectConsole();

  const [{ loadSettings }, { createHostRegistry }, { createServer }, { ALL_TOOLS }, stdio] =
    await Promise.all([
      import('./config/load.js'),
      import('./proxmox/hosts.js'),
      import('./server/server.js'),
      import('./tools/catalog.js'),
      import('@modelcontextprotocol/server/stdio'),
    ]);

  const loaded = await loadSettings(configPath === undefined ? {} : { configPath });
  for (const warning of loaded.warnings) log(`warning: ${warning}`);
  log(`settings: ${loaded.path ?? loaded.source}`);

  const hosts = await createHostRegistry(loaded.settings, { log });
  const server = createServer({ settings: loaded.settings, hosts, tools: ALL_TOOLS, log });

  const closed = new Promise<void>((resolve) => {
    server.server.onclose = () => resolve();
    const shutdown = (): void => {
      void server.close().finally(resolve);
    };
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
  });

  await server.connect(new stdio.StdioServerTransport());
  log('ready on stdio');
  await closed;
  return 0;
}

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  if (command === '--version' || command === '-v') {
    process.stdout.write(`${version()}\n`);
    return 0;
  }
  if (command === '--help' || command === '-h') {
    await printHelp(process.stdout);
    return 0;
  }
  if (command === 'help') {
    const topic = rest[0];
    const load = topic !== undefined ? COMMANDS[topic] : undefined;
    if (topic !== undefined && topic !== 'serve' && !load) {
      process.stderr.write(`unknown command: ${topic}\n`);
      return 2;
    }
    if (load) return (await load()).run(['--help']);
    await printHelp(process.stdout);
    return 0;
  }
  // Without a command the MCP server starts, because clients run the package without arguments.
  if (command === undefined || command.startsWith('--config')) return serve(argv);
  if (command === 'serve') return serve(rest);
  const load = COMMANDS[command];
  if (load) return (await load()).run(rest);
  process.stderr.write(`unknown command: ${command}\n\n`);
  await printHelp(process.stderr);
  return 2;
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (err: unknown) => {
    log(`fatal: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  },
);
