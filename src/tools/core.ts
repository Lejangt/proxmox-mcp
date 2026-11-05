import { defineTool, type AnyToolDef } from '../server/registry.js';

export const coreTools: AnyToolDef[] = [
  defineTool({
    name: 'pve_hosts_list',
    category: 'core',
    title: 'List Proxmox hosts',
    description:
      'List the configured Proxmox targets with alias, URL, description, read-only flag and which one is the default. ' +
      'Call this first when several hosts exist. Every other tool takes an optional "host" alias from this list. No network access.',
    access: 'read',
    local: true,
    input: {},
    handler: async (_args, ctx) => ({
      defaultHost: ctx.hosts.defaultAlias() ?? null,
      globalReadOnly: ctx.settings.readOnly,
      hosts: ctx.hosts.list(),
    }),
  }),

  defineTool({
    name: 'pve_version',
    category: 'core',
    title: 'Proxmox version',
    description:
      'Get the Proxmox VE version of a host (version, release, repository id). Also a quick check that the host is reachable and the token works.',
    access: 'read',
    input: {},
    handler: (_args, ctx) => ctx.client.get('/version'),
  }),
];
