import type { HostSettings, Settings } from '../config/types.js';
import { resolveSecret } from '../secrets/resolve.js';
import {
  createProxmoxClient,
  type ProxmoxClientOptions,
  type ProxmoxHttpClient,
} from './client.js';
import { ConfigError } from './errors.js';
import type { HostInfo, HostRegistry, ProxmoxClient } from './types.js';

export interface HostRegistryOptions {
  /** Receives warnings, never secrets. Defaults to stderr. */
  log?: (msg: string) => void;
  /** Environment used for secret resolution. Defaults to process.env. */
  env?: NodeJS.ProcessEnv;
  /** Passed to every client (tests use it for limits and timeouts). */
  clientOptions?: Omit<ProxmoxClientOptions, 'readOnly'>;
}

/** HostRegistry plus lifecycle control of the created clients. */
export interface ClosableHostRegistry extends HostRegistry {
  close(): void;
}

function formatAliases(aliases: string[]): string {
  return aliases.length > 0 ? aliases.join(', ') : 'none configured';
}

export function createHostRegistry(
  settings: Settings,
  options: HostRegistryOptions = {},
): ClosableHostRegistry {
  const log = options.log ?? ((msg: string) => process.stderr.write(`${msg}\n`));
  const hosts = new Map<string, HostSettings>(Object.entries(settings.hosts));
  const aliases = [...hosts.keys()];
  const clients = new Map<string, ProxmoxHttpClient>();

  const defaultAlias = (): string | undefined => {
    if (settings.defaultHost !== undefined && hosts.has(settings.defaultHost))
      return settings.defaultHost;
    return aliases.length === 1 ? aliases[0] : undefined;
  };

  // Warned on every start, as promised in the docs.
  for (const [alias, host] of hosts) {
    if (!host.tls.verify) {
      log(
        `warning: host "${alias}" has TLS verification disabled, the API token can be intercepted. ` +
          'Use tls.fingerprint or tls.caFile.',
      );
    }
  }

  const effectiveReadOnly = (host: HostSettings) => settings.readOnly || host.readOnly;

  function makeClient(alias: string, host: HostSettings): ProxmoxHttpClient {
    /*
     * The secret is resolved on the first request that needs it and kept in
     * this closure only. A failed resolution is not cached, so fixing the
     * secret source does not need a restart, and it only affects this host.
     */
    let pending: Promise<string> | undefined;
    const getSecret = () => {
      pending ??= resolveSecret(host.tokenSecret, {
        host: alias,
        ...(options.env !== undefined ? { env: options.env } : {}),
      }).catch((err: unknown) => {
        pending = undefined;
        throw err;
      });
      return pending;
    };
    return createProxmoxClient(alias, host, getSecret, {
      ...options.clientOptions,
      readOnly: settings.readOnly,
    });
  }

  return {
    list(): HostInfo[] {
      const def = defaultAlias();
      return aliases.map((alias) => {
        const host = hosts.get(alias)!;
        const info: HostInfo = {
          alias,
          url: host.url,
          readOnly: effectiveReadOnly(host),
          isDefault: alias === def,
        };
        if (host.description !== undefined) info.description = host.description;
        return info;
      });
    },
    aliases: () => [...aliases],
    defaultAlias,
    async client(alias?: string): Promise<ProxmoxClient> {
      const name = alias ?? defaultAlias();
      if (name === undefined) {
        throw new ConfigError(
          aliases.length === 0
            ? 'No Proxmox hosts are configured. Run `proxmox-ve-mcp setup`.'
            : `No host given and no defaultHost configured. Known hosts: ${formatAliases(aliases)}`,
        );
      }
      const host = hosts.get(name);
      if (!host) {
        throw new ConfigError(
          `Unknown host ${JSON.stringify(name.slice(0, 64))}. Known hosts: ${formatAliases(aliases)}`,
        );
      }
      let client = clients.get(name);
      if (!client) {
        client = makeClient(name, host);
        clients.set(name, client);
      }
      return client;
    },
    close() {
      for (const client of clients.values()) client.close();
      clients.clear();
    },
  };
}
