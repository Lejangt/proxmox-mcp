# Architecture

This document is the contract between the modules of `proxmox-ve-mcp`. Read it
before changing module boundaries.

## Goals

- An MCP server that lets an agent manage one or more Proxmox VE hosts or
  clusters through the Proxmox HTTP API with API tokens: read everything,
  create, change and delete VMs (QEMU) and containers (LXC), storage, backups,
  snapshots, tasks, firewall, pools, HA, node network and more.
- Several independent Proxmox targets at once (standalone nodes or clusters,
  different networks, different TLS setups, different tokens).
- Security first: secrets never stored in plaintext config, TLS verified by
  default, read-only mode, per category and per tool switches, destructive
  operations clearly marked and optionally confirmed by the user.
- A clean install: `npx`, an interactive `setup` wizard, a single settings
  file that lists every category and tool, ready-made client snippets.

## Runtime and dependencies

- Node.js >= 22, ESM, TypeScript, strict mode.
- `@modelcontextprotocol/server` (v2 line, stdio transport from
  `@modelcontextprotocol/server/stdio`) and `zod` 4.
- `yaml` for the settings file (comment preserving Document API).
- `@clack/prompts` and `picocolors` for the CLI.
- `@napi-rs/keyring` as optional dependency for the OS keychain, loaded with a
  dynamic import so the server works where it is missing.
- No other runtime dependencies without a good reason. HTTP goes through
  `node:https` so TLS can be controlled exactly.

## Layout

```
src/
  index.ts              CLI entry (bin), dispatches to serve or a subcommand
  cli/                  setup wizard, host, secret, tools, config, doctor, client-config
  config/
    schema.ts           zod schema of the settings file, defaults, JSON schema export
    paths.ts            config path resolution (XDG, APPDATA, overrides)
    load.ts             load + validate settings, env-only mode, env tightening
    write.ts            write the settings file (0600, dir 0700), comment preserving updates
    file-trust.ts       owner and mode checks for the settings file and tls.caFile
  secrets/
    types.ts            SecretRef union
    resolve.ts          resolveSecret(ref): Promise<string>
    run-command.ts      the only place that spawns external secret CLIs
    providers/*.ts      env, file, keyring, bws, 1password, vault, pass, command
  proxmox/
    client.ts           ProxmoxClient (HTTPS, auth header, TLS, errors, limits)
    tls.ts              CA file, fingerprint pinning, certificate probing for setup
    path.ts             pvePath tagged template, path validation
    hosts.ts            HostRegistry: aliases, default host, lazy clients
    errors.ts           ProxmoxApiError and friends, redaction
    tasks.ts            UPID parsing, waitForTask, task result formatting
    guests.ts           resolveGuest(vmid) via /cluster/resources
  server/
    server.ts           builds the McpServer, registers enabled tools
    registry.ts         defineTool, ToolDef, ToolContext, categories
    confirm.ts          elicitation based confirmation, bound to the arguments by requestState
    console-guard.ts    sends every stdout console method to stderr in serve mode
    format.ts           result formatting and output truncation
  tools/
    catalog.ts          array of all ToolDefs, the single source of truth
    targets.ts          helpers for confirmTarget (guest, node and storage labels, quoting)
    <category>.ts       one file per category
test/                   vitest, no network, Proxmox mocked with a local HTTPS server
```

## Settings file

Format YAML, default path:

- Linux and macOS: `$XDG_CONFIG_HOME/proxmox-ve-mcp/config.yaml`, fallback
  `~/.config/proxmox-ve-mcp/config.yaml`
- Windows: `%APPDATA%\proxmox-ve-mcp\config.yaml`
- Override: `--config <path>` or `PROXMOX_MCP_CONFIG`

The file never contains a token secret, only a reference to where the secret
lives. `proxmox-ve-mcp setup` writes a complete file in which every category and
every tool is listed with a one line comment. `proxmox-ve-mcp config sync` adds
tools from newer versions without touching existing values or comments.

```yaml
# yaml-language-server: $schema=https://raw.githubusercontent.com/Lejangt/proxmox-mcp/main/config.schema.json
version: 1

# Global safety switches.
readOnly: false # true: only read tools exist, every non-GET request is refused
confirmDestructive: auto # auto | always | never (see "Destructive operations")

defaultHost: homelab

hosts:
  homelab:
    description: Homelab cluster
    url: https://pve1.example.com:8006
    tokenId: mcp@pve!agent
    tokenSecret:
      source: keyring
    tls:
      verify: true
      caFile: ~/.config/proxmox-ve-mcp/ca/homelab.pem
      # fingerprint: "AB:CD:...:EF"    # SHA-256 pin, alternative to caFile
    readOnly: false
    timeoutSeconds: 30
  office:
    url: https://10.0.0.5:8006
    tokenId: automation@pve!mcp
    tokenSecret:
      source: bws
      secretId: 00000000-0000-0000-0000-000000000000
      serverUrl: https://vault.bitwarden.eu
    tls:
      fingerprint: 'AB:CD:...:EF'
    readOnly: true

limits:
  maxOutputChars: 60000 # longer tool output is truncated with a note
  taskWaitSeconds: 600 # upper bound for waiting on a Proxmox task

categories:
  guests:
    enabled: true
    tools:
      pve_guest_list: true # List VMs and containers with status
      pve_guest_delete: false # Delete a VM or container
  # ...every category, every tool
```

Rules:

- Unknown keys are an error (typos must not silently weaken a switch).
- A tool is active when its category is enabled and the tool entry is not
  `false`. Tools missing from the file follow their category. The `core`
  category cannot be switched off as a whole (`enabled: false` is ignored
  for it), its tools can still be switched off one by one.
- On POSIX the settings file is refused when it is writable by group or
  others or owned by another user than the server user or root, and when
  its directory (or the directory of the real file behind a symlink) is
  writable by group or others without the sticky bit. A file that is only
  readable by group or others gives a warning. Windows is not checked.
- Global `readOnly: true` removes all non-read tools and makes every client
  refuse non-GET requests. Host `readOnly: true` makes that host's client
  refuse non-GET requests. Write tools stay registered as long as at least one
  host is writable and fail with a clear message for read-only hosts.
- `~` at the start of a path expands to the home directory.

Environment variables can only tighten, never loosen:

- `PROXMOX_MCP_READ_ONLY=1` forces global read-only.
- `PROXMOX_MCP_DISABLE=cat1,cat2,tool_x` disables categories or tools.

Env-only mode (no settings file, for containers and quick tests), one host
named `default`:

- `PROXMOX_URL`, `PROXMOX_TOKEN_ID`, and either `PROXMOX_TOKEN_SECRET` or
  `PROXMOX_TOKEN_SECRET_FILE`
- optional `PROXMOX_CA_FILE`, `PROXMOX_TLS_FINGERPRINT`,
  `PROXMOX_TLS_VERIFY=0`, `PROXMOX_READ_ONLY=1`

If both a settings file and `PROXMOX_URL` exist, the settings file wins and a
warning goes to stderr.

## Secret references

```ts
type SecretRef =
  | { source: 'env'; name: string }
  | { source: 'file'; path: string }
  | { source: 'keyring'; service?: string; account?: string } // default service "proxmox-ve-mcp", account = host alias
  | {
      source: 'bws';
      secretId: string;
      accessToken?: SecretRef;
      serverUrl?: string;
      binary?: string;
    }
  | { source: '1password'; ref: string; account?: string; binary?: string }
  | {
      source: 'vault';
      path: string;
      field: string;
      mount?: string;
      address?: string;
      token?: SecretRef;
      namespace?: string;
      binary?: string;
    }
  | { source: 'pass'; name: string; binary?: string }
  | { source: 'command'; command: string[]; timeoutSeconds?: number };
```

- External CLIs (`bws`, `op`, `vault` or `bao`, `pass`, custom commands) run
  through one helper: argv array, never a shell, minimal inherited
  environment plus explicitly passed variables, timeout, output size limit.
  A stderr excerpt may appear in error messages. It is scrubbed of every
  known secret value and of every stdout line, secret material that the
  server does not know cannot be recognized there.
- `file`: on POSIX the file must be owned by the server user or root and
  must not be accessible by group or others. Exception: root owned files
  under `/run/secrets/` (path and real path) that nobody but root can write,
  as Docker and Kubernetes mount them with mode 0444 or 0644.
- `bws`: access token defaults to env `BWS_ACCESS_TOKEN`. Nested refs
  (`bws.accessToken`, `vault.token`) may not be `bws` or `vault`, so there is
  no recursion.
- Secrets are resolved lazily on first use of a host and kept in memory only.
  They never appear in logs, tool output or error messages.

## ProxmoxClient

```ts
type ParamValue = string | number | boolean | undefined | null;
type Params = Record<string, ParamValue | ParamValue[]>;

interface ProxmoxClient {
  readonly alias: string;
  readonly readOnly: boolean;
  request<T = unknown>(
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
    path: string,
    params?: Params,
  ): Promise<T>;
  get<T = unknown>(path: string, params?: Params): Promise<T>;
  getEnvelope<T = unknown>(
    path: string,
    params?: Params,
  ): Promise<{ data: T; meta: Record<string, unknown> }>;
  post<T = unknown>(path: string, params?: Params): Promise<T>;
  put<T = unknown>(path: string, params?: Params): Promise<T>;
  delete<T = unknown>(path: string, params?: Params): Promise<T>;
}
```

- `path` is relative to `/api2/json` and starts with `/`. Tools build paths
  with the `pvePath` tagged template, which percent-encodes every
  interpolated value. pveproxy decodes the path before routing, so an
  encoded `/` would become a separator: `pvePath` rejects plain values that
  contain `/`. Volume ids are the only values with `/` by design and must be
  wrapped with `volid(value)`, which checks the `storage:name` form and
  rejects empty, `.` and `..` parts. The client validates every path again
  (no `..`, no query or fragment, no control characters, allowed character
  set only).
- Returns the unwrapped `data` field of the Proxmox response. `getEnvelope`
  also returns the other top level fields as `meta`, for example `total` of
  task logs (used by `tailTaskLog` to read the tail with one request) and
  `changes` of the node network (shown by `pve_network_list` as
  `pendingChanges`).
- Booleans are sent as `1` and `0`, `undefined` and `null` are dropped,
  arrays become repeated keys. GET and DELETE send params as query string,
  POST and PUT as `application/x-www-form-urlencoded` body. A parameter name
  or value (also an array element) with a NUL character is refused before
  anything is sent.
- Auth header `Authorization: PVEAPIToken=<tokenId>=<secret>`.
- TLS: system CAs plus optional `caFile`, or SHA-256 fingerprint pinning of
  the leaf certificate, or (explicit opt-in only) no verification with a
  warning on every start. Hostname verification stays on with `caFile`.
- Timeout per request, response size limit, no redirects followed.
  pveproxy compresses some answers (for example the journal) even for
  `Accept-Encoding: identity`. gzip and deflate bodies are decoded with the
  same limit on the decoded size, other encodings are an error.
- `tls.caFile` is refused on POSIX when it is writable by group or others or
  owned by another user than the server user or root.
- Read-only clients reject non-GET requests before any network traffic.
- Errors are `ProxmoxApiError` with HTTP status, Proxmox message and the
  per-parameter `errors` object (listed once in the message). No headers, no
  secret, no full URL with credentials.

`HostRegistry`:

```ts
interface HostInfo {
  alias: string;
  description?: string;
  url: string;
  readOnly: boolean;
  isDefault: boolean;
}
interface HostRegistry {
  list(): HostInfo[];
  aliases(): string[];
  defaultAlias(): string | undefined;
  client(alias?: string): Promise<ProxmoxClient>; // throws a helpful error listing aliases
}
```

## Tool framework

```ts
type Access = 'read' | 'write' | 'destructive';

interface ToolDef<Shape extends z.ZodRawShape> {
  name: string; // snake_case, prefix pve_
  category: CategoryId;
  title: string;
  description: string; // written for an agent: what, when, notable params
  access: Access;
  input: Shape; // `host` is added by the framework
  handler(args: z.infer<z.ZodObject<Shape>>, ctx: ToolContext): Promise<unknown>;
}

interface ToolContext {
  client: ProxmoxClient; // already resolved for args.host
  hosts: HostRegistry;
  settings: Settings;
  signal: AbortSignal;
  log(message: string): void; // stderr, never secrets
}
```

- `defineTool` keeps the generic types, `catalog.ts` exports `ALL_TOOLS`.
- Annotations: read tools `readOnlyHint: true`, write tools
  `readOnlyHint: false, destructiveHint: false`, destructive tools
  `destructiveHint: true`. `openWorldHint: false` everywhere except tools
  that make Proxmox download from a URL.
- Every tool gets an optional `host` argument. With more than one host it is
  a zod enum of the aliases, and the description names the default host.
- Handler results are serialized as JSON text, truncated at
  `limits.maxOutputChars` with a note how to narrow the query. Errors become
  `isError: true` results with a short message and the Proxmox parameter
  errors, never a stack trace.
- Optional `ToolDef` fields: `openWorld` (download tools),
  `needsConfirmation(args, ctx)` (a write tool that asks like a destructive
  one for some arguments, also sets `destructiveHint`, may be async and read
  from Proxmox, answers true when in doubt), `confirmTarget(args, ctx)` and
  `local` (never talks to
  Proxmox, no `host` argument, no client is resolved).
- `confirmTarget` is required for every destructive tool and every tool with
  `needsConfirmation` (a test enforces it). It names the concrete target:
  VMID with name, type and node, node, argv, volume id, snapshot name,
  storage id, job id, method, path and parameters (credential-like values
  hidden), firewall level and rule. It may read from Proxmox through `ctx`
  and falls back to the arguments when a lookup fails. Values are JSON
  quoted, long values are cut in the middle with the number of left out
  characters so start and end stay visible, and the whole question shows
  every character outside printable ASCII as `\uXXXX` (line separators, NEL,
  bidi controls), so a value cannot add lines or reorder the text.
- Confirmation uses the SDK's input-required flow: the tool callback returns
  `inputRequired(...)` and is called again with the answer. The SDK fulfils it
  with a real `elicitation/create` request for clients on the 2025 protocol.
- The question carries a `requestState` with an HMAC-SHA256 binding over tool
  name, host alias and the canonical arguments, sealed with the SDK codec
  (`createRequestStateCodec`). Both keys are random per process, states live
  10 minutes. An answer is accepted only when the echoed state verifies and
  its binding matches the current call. An answer for other arguments is
  refused, an answer without state (never asked for) is ignored and the
  question is asked.
- Write and destructive tools that start a Proxmox task accept
  `wait: boolean` (default true) and return the task result (status,
  exitstatus, last log lines) or the UPID when not waiting.

### Destructive operations

`access: 'destructive'` is reserved for operations that lose data or cut off
access: deleting guests, volumes (including backup files), snapshots,
storage definitions, backup jobs, pools, HA resources or firewall rules,
snapshot rollback, backup restore, node shutdown or reboot, applying node
network changes and running commands in a VM (`pve_vm_agent_exec`). There
is no tool that deletes users.

Write tools that ask like destructive ones for some arguments
(`needsConfirmation`):

- `pve_api_request` with method DELETE. It is registered as `write`, a POST
  or PUT through it is not confirmed.
- `pve_guest_update_config` when `delete` contains a disk key (QEMU:
  `ide`, `sata`, `scsi`, `virtio`, `efidisk`, `tpmstate`, `unused` plus a
  number, `vmstate`, LXC: `rootfs`, `mp` plus a number, `unused` plus a
  number). `splitList` in `src/tools/resolve-node.ts` splits entries like
  PVE::Tools::split_list (commas, semicolons, whitespace) and refuses
  entries with control characters (C0, DEL, C1), because split_list splits
  only at NUL once one is present. The same split is used for the
  `prune-backups` check and the firewall option check, and the split list is
  what is sent. `force` in `set` is refused.
- `pve_storage_define` and `pve_backup_job_set` when they set or remove
  `prune-backups`.
- `pve_firewall_options_set` on cluster or node level when it sets or
  resets `enable`, `policy_in`, `policy_out` or `policy_forward`.
- `pve_firewall_rule_add` on cluster or node level with action DROP or
  REJECT.
- `pve_firewall_rule_update` on cluster or node level with action DROP or
  REJECT, and otherwise after reading the current rule: when the update
  changes a filtering field (type, action, macro, proto, source, dest,
  sport, dport, iface, icmp-type, enable) or moves the rule, and the rule is
  active and DROP, REJECT or a security group afterwards, or was an active
  ACCEPT or group rule before. A rule that cannot be read asks.
- `pve_node_service_action` for stop, and for restart of pveproxy,
  pvedaemon, sshd, pve-cluster, corosync or a firewall service.

`pve_vm_create` and `pve_lxc_create` refuse `archive`, `restore`,
`live-restore`, `unique` and `force` in `extra`, and `pve_lxc_create`
refuses a backup archive as `ostemplate`, because these turn a create into a
restore that can replace an existing guest. Restores go through the
destructive `pve_backup_restore`. Free form records (`extra`, `set`,
`options`) may not set keys that a typed argument or the path already sets
(for example `iface` and `type` of `pve_network_set`).

`confirmDestructive`:

- `auto` (default): ask the user through MCP elicitation when the client
  supports it, otherwise rely on the client's own tool approval.
- `always`: ask through elicitation, refuse when the client cannot ask.
- `never`: no extra confirmation.

## Categories and tools

`R` read, `W` write, `D` destructive. Guest tools work for QEMU and LXC and
find node and type from the VMID when they are not given.

| Category  | Tool                          | Access | Purpose                                                                       |
| --------- | ----------------------------- | ------ | ----------------------------------------------------------------------------- |
| core      | pve_hosts_list                | R      | Configured Proxmox targets, default host, read-only flags                     |
| core      | pve_version                   | R      | Proxmox version of a host                                                     |
| cluster   | pve_cluster_status            | R      | Cluster membership, quorum, nodes online                                      |
| cluster   | pve_cluster_resources         | R      | All resources (vm, lxc, storage, node, sdn, pool) with usage, filterable      |
| cluster   | pve_next_vmid                 | R      | Next free VMID                                                                |
| cluster   | pve_cluster_log               | R      | Recent cluster log entries                                                    |
| nodes     | pve_node_list                 | R      | Nodes with status, CPU, memory, uptime                                        |
| nodes     | pve_node_status               | R      | Detailed node status (CPU model, kernel, load, memory, rootfs)                |
| nodes     | pve_node_rrd                  | R      | Node metrics over a timeframe                                                 |
| nodes     | pve_node_services             | R      | System services and their state                                               |
| nodes     | pve_node_service_action       | W      | Start, stop, restart or reload a node service                                 |
| nodes     | pve_node_syslog               | R      | Journal lines with since, until, limit                                        |
| nodes     | pve_node_disks                | R      | Physical disks, SMART health, usage                                           |
| nodes     | pve_node_apt_updates          | R      | Pending package updates                                                       |
| nodes     | pve_node_power                | D      | Reboot or shut down a node                                                    |
| network   | pve_network_list              | R      | Node network interfaces, bridges, bonds, VLANs, pending changes               |
| network   | pve_network_set               | W      | Create or update an interface (staged until applied)                          |
| network   | pve_network_delete            | W      | Delete an interface (staged until applied)                                    |
| network   | pve_network_apply             | D      | Apply staged network changes (ifreload)                                       |
| network   | pve_network_revert            | W      | Discard staged network changes                                                |
| guests    | pve_guest_list                | R      | VMs and containers with status, filter by node, type, status, pool, tag       |
| guests    | pve_guest_status              | R      | Current status of one guest (uptime, CPU, memory, disk, net, HA)              |
| guests    | pve_guest_config              | R      | Configuration of a guest, optionally with pending changes                     |
| guests    | pve_guest_rrd                 | R      | Guest metrics over a timeframe                                                |
| guests    | pve_guest_power               | W      | start, shutdown, reboot, suspend, resume (stop and reset need force)          |
| guests    | pve_guest_update_config       | W      | Set or delete config keys (cores, memory, net, disks, cloud-init, tags, ...)  |
| guests    | pve_guest_resize_disk         | W      | Grow a disk (absolute or +size)                                               |
| guests    | pve_guest_move_disk           | W      | Move a disk or volume to another storage                                      |
| guests    | pve_guest_migrate             | W      | Migrate to another node (online or offline)                                   |
| guests    | pve_guest_clone               | W      | Clone a guest or template (full or linked)                                    |
| guests    | pve_guest_template            | W      | Convert a guest into a template                                               |
| guests    | pve_guest_delete              | D      | Delete a guest, optionally purge from jobs and unreferenced disks             |
| guests    | pve_vm_create                 | W      | Create a QEMU VM (common fields typed, everything else via extra)             |
| guests    | pve_lxc_create                | W      | Create an LXC container from a template                                       |
| guests    | pve_vm_agent_info             | R      | QEMU guest agent: ping, OS info, network interfaces, filesystems, users, time |
| guests    | pve_vm_agent_exec             | D      | Run a command inside a VM through the guest agent and return its output       |
| guests    | pve_vm_cloudinit              | R      | Rendered cloud-init config and pending cloud-init changes                     |
| snapshots | pve_snapshot_list             | R      | Snapshots of a guest                                                          |
| snapshots | pve_snapshot_create           | W      | Create a snapshot (optionally with RAM for VMs)                               |
| snapshots | pve_snapshot_rollback         | D      | Roll back to a snapshot                                                       |
| snapshots | pve_snapshot_delete           | D      | Delete a snapshot                                                             |
| storage   | pve_storage_list              | R      | Storages with type, content types, usage, per node or cluster wide            |
| storage   | pve_storage_content           | R      | Volumes on a storage (images, ISO, templates, backups), filterable            |
| storage   | pve_storage_download_url      | W      | Let Proxmox download an ISO or template from a URL, optional checksum         |
| storage   | pve_storage_templates         | R      | Available LXC appliance templates (aplinfo)                                   |
| storage   | pve_storage_template_download | W      | Download an appliance template to a storage                                   |
| storage   | pve_storage_volume_delete     | D      | Delete a volume                                                               |
| storage   | pve_storage_define            | W      | Create or update a storage definition                                         |
| storage   | pve_storage_remove            | D      | Remove a storage definition                                                   |
| backup    | pve_backup_list               | R      | Backups on one or all backup storages, filter by VMID                         |
| backup    | pve_backup_create             | W      | Run vzdump now for one or more guests                                         |
| backup    | pve_backup_restore            | D      | Restore a backup to a new or (with force) an existing VMID                    |
| backup    | pve_backup_jobs_list          | R      | Scheduled backup jobs                                                         |
| backup    | pve_backup_job_set            | W      | Create or update a backup job                                                 |
| backup    | pve_backup_job_delete         | D      | Delete a backup job                                                           |
| tasks     | pve_task_list                 | R      | Recent tasks, filter by node, VMID, type, status, errors only                 |
| tasks     | pve_task_status               | R      | Status of a task by UPID                                                      |
| tasks     | pve_task_log                  | R      | Log lines of a task                                                           |
| tasks     | pve_task_wait                 | R      | Wait until a task finishes (bounded)                                          |
| tasks     | pve_task_stop                 | W      | Stop a running task                                                           |
| access    | pve_access_list               | R      | Users, groups, roles, ACLs, realms or API tokens                              |
| access    | pve_access_permissions        | R      | Effective permissions of this token or of a user on a path                    |
| firewall  | pve_firewall_rules            | R      | Rules at cluster, node or guest level                                         |
| firewall  | pve_firewall_rule_add         | W      | Add a rule                                                                    |
| firewall  | pve_firewall_rule_update      | W      | Change a rule                                                                 |
| firewall  | pve_firewall_rule_delete      | D      | Delete a rule                                                                 |
| firewall  | pve_firewall_options          | R      | Firewall options at a level                                                   |
| firewall  | pve_firewall_options_set      | W      | Change firewall options (enable, policies, log levels)                        |
| pools     | pve_pool_list                 | R      | Resource pools and members                                                    |
| pools     | pve_pool_set                  | W      | Create a pool or change comment and members                                   |
| pools     | pve_pool_delete               | D      | Delete an empty pool                                                          |
| ha        | pve_ha_status                 | R      | HA manager status, resources, groups or rules                                 |
| ha        | pve_ha_resource_set           | W      | Add or change an HA resource                                                  |
| ha        | pve_ha_resource_remove        | D      | Remove a guest from HA                                                        |
| api       | pve_api_get                   | R      | GET any API path (escape hatch for everything without a dedicated tool)       |
| api       | pve_api_request               | W      | POST, PUT or DELETE any API path (DELETE counts as destructive)               |
| api       | pve_api_describe              | R      | API schema for a path: methods, parameters, permissions                       |

`pve_api_request` is registered as `write` but asks for confirmation like a
destructive tool when the method is DELETE.

`pve_api_get` refuses, in read-only mode (global or for the host), GET calls
that make the node contact an address: `/cluster/acme/tos`,
`/cluster/acme/meta` and `/cluster/acme/directories` with `directory`,
`/nodes/{node}/query-url-metadata` with `url`,
`/nodes/{node}/scan/{nfs,cifs,pbs,glusterfs}` with `server` and
`/nodes/{node}/scan/iscsi` with `portal`. Path and parameter names are
compared decoded and case insensitive.

`pve_api_describe` reads the API schema that Proxmox ships at
`/pve-docs/api-viewer/apidoc.js` on the same host, caches it per host and
returns only the entry for the requested path.

## CLI

```
proxmox-ve-mcp                      start the MCP server on stdio (same as `serve`)
proxmox-ve-mcp setup                interactive first-time setup
proxmox-ve-mcp host add|edit|remove|list|test [alias]
proxmox-ve-mcp secret set <alias>   store or replace a token secret in the OS keychain
proxmox-ve-mcp tools                print all categories and tools with access level and state
proxmox-ve-mcp config path|validate|sync|edit
proxmox-ve-mcp doctor [alias]       check config, secrets, TLS, connectivity and token permissions per host
proxmox-ve-mcp client-config <client> [--name <name>] [--config <path>]
                                    print the snippet for claude-code, claude-desktop, cursor, vscode, codex, windsurf
proxmox-ve-mcp help [command]       show help, also: <command> --help
```

Options, the full list is in `proxmox-ve-mcp help <command>`:

- `--config <path>` selects the settings file.
- `--json` gives machine readable output for `host list` and `tools`.
- `host remove --yes` skips the prompt, `--delete-secret` also deletes the keychain entry of the host.
- `secret set --stdin` reads the secret from standard input, `--use-keyring` switches the host to the keychain.
- `config sync --dry-run` only shows what sync would add.
- `-v` or `--version` prints the version, `-h` or `--help` shows the help.

Nothing is written to stdout in `serve` mode except MCP protocol messages.
Logs go to stderr, and every console method that writes to stdout (`log`,
`info`, `debug`, `dir`, `dirxml`, `table`, `trace`, `group*`, `count*`,
`time*`) is pointed to stderr before the server modules are loaded.
