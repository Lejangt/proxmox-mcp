import type { Settings } from '../../src/config/types.js';
import type { HostInfo, HostRegistry, ProxmoxClient } from '../../src/proxmox/types.js';
import type { ToolContext } from '../../src/server/registry.js';

export function fakeSettings(overrides: Partial<Settings> = {}): Settings {
  return {
    version: 1,
    readOnly: false,
    confirmDestructive: 'auto',
    hosts: {},
    limits: { maxOutputChars: 60000, taskWaitSeconds: 5 },
    categories: {},
    ...overrides,
  };
}

export function fakeHosts(
  clients: Record<string, ProxmoxClient>,
  opts: { defaultAlias?: string; readOnly?: Record<string, boolean> } = {},
): HostRegistry {
  const aliases = Object.keys(clients);
  const def = opts.defaultAlias ?? aliases[0];
  const list = (): HostInfo[] =>
    aliases.map((alias) => ({
      alias,
      url: `https://${alias}.example.test:8006`,
      readOnly: opts.readOnly?.[alias] ?? false,
      isDefault: alias === def,
    }));
  return {
    list,
    aliases: () => aliases,
    defaultAlias: () => def,
    client: async (alias) => {
      const key = alias ?? def;
      const c = key ? clients[key] : undefined;
      if (!c) throw new Error(`Unknown host "${String(key)}". Known hosts: ${aliases.join(', ')}`);
      return c;
    },
  };
}

export function fakeContext(
  client: ProxmoxClient,
  overrides: Partial<ToolContext> = {},
): ToolContext {
  return {
    client,
    hosts: fakeHosts({ [client.alias]: client }),
    settings: fakeSettings(),
    signal: new AbortController().signal,
    log: () => {},
    ...overrides,
  };
}
