# Configuration

proxmox-ve-mcp reads one settings file in YAML. If no explicit path is given and the default file does not exist, it runs in env-only mode when `PROXMOX_URL` is set (see [Env-only mode](#env-only-mode)).

The file can be written by hand or with the CLI. `proxmox-ve-mcp help` lists the commands, among them `setup` (creates the file), `host` and `secret` (hosts and token secrets) and `config` (validates the file). The server starts with no command, with `serve`, or with `--config <path>` alone. `--version` and `--help` print their text and exit.

## Location

The first source that is set wins:

1. `--config <path>` or `--config=<path>` on the command line.
2. The environment variable `PROXMOX_MCP_CONFIG`. An empty value counts as not set.
3. The platform default:
   - Linux and macOS: `$XDG_CONFIG_HOME/proxmox-ve-mcp/config.yaml` if `XDG_CONFIG_HOME` is an absolute path, otherwise `~/.config/proxmox-ve-mcp/config.yaml`.
   - Windows: `%APPDATA%\proxmox-ve-mcp\config.yaml` if `APPDATA` is an absolute path, otherwise `<home>\AppData\Roaming\proxmox-ve-mcp\config.yaml`.

A leading `~` or `~/` is replaced by the home directory in the path of option 1 or 2, in the `path` of a `source: file` secret, in `tls.caFile` and in `PROXMOX_CA_FILE`. Relative paths are resolved against the working directory of the server process.

If an explicit path (option 1 or 2) does not exist, startup fails. Without an explicit path, a missing default file leads to env-only mode when `PROXMOX_URL` is set. Otherwise startup fails with `No settings found`.

## File rules

- The file is at most 1 MiB, must not be empty and must be valid YAML.
- Duplicate keys are errors. YAML merge keys (`<<`) are not expanded and are rejected.
- Every object is strict. An unknown key is an error, so a misspelled key stops startup instead of being ignored.
- Error messages name the field path and the rule. Secret values are never printed.
- Tool names under `categories` must exist in the tool catalog and must sit under their own category. Otherwise startup fails and lists the names.

On Linux and macOS whoever can change the settings file controls the server (tools, hosts, TLS trust), so startup fails when:

- the file is writable by group or others. Fix: `chmod go-w <file>`, or `chmod 600 <file>`.
- the file is owned by a user other than the server user or root. Fix: copy it to a file you own, or `chown <your uid> <file>` as root.
- the directory that holds the file is writable by group or others without the sticky bit, so the file could be replaced. For a symlink this applies to the directory of the link and to the directory of the real file. Fix: `chmod go-w <directory>`, or move the file to a private directory.

A file that is only readable by group or others gives a warning (fix with `chmod 600`). The file holds no secrets, but it shows hosts and token ids. These checks are skipped on Windows.

The same owner and write rules apply to `tls.caFile` (and `PROXMOX_CA_FILE`): a CA file that is writable by group or others, or owned by another user than the server user or root, is refused with the `chmod` or `chown` to fix it. A readable CA file (for example mode 644) is fine.

## Example

Two hosts: `lab` gets its token from the OS keyring and pins the certificate fingerprint. `prod` gets its token from Bitwarden Secrets Manager, trusts a CA file and is read-only.

```yaml
version: 1
readOnly: false
confirmDestructive: auto
defaultHost: lab
limits:
  maxOutputChars: 60000
  taskWaitSeconds: 600
categories:
  ha:
    enabled: false
  api:
    tools:
      pve_api_request: false
hosts:
  lab:
    description: Lab cluster, node pve1
    url: https://pve-lab.example.com:8006
    tokenId: mcp@pve!agent
    tokenSecret:
      source: keyring
      service: proxmox-ve-mcp
      account: lab
    tls:
      fingerprint: "00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00"
    timeoutSeconds: 30
  prod:
    description: Production cluster, read-only for this server
    url: https://pve-prod.example.com:8006
    tokenId: mcp@pve!agent
    tokenSecret:
      source: bws
      secretId: 00000000-0000-0000-0000-000000000000
      serverUrl: https://secrets.example.com
    tls:
      caFile: /etc/proxmox-mcp/pve-prod-ca.pem
    readOnly: true
```

The secret sources are described in [secrets.md](secrets.md).

## Fields

### Top level

| Field | Type | Default | Meaning |
|---|---|---|---|
| `version` | `1` | required | Settings format version. Must be `1`. |
| `readOnly` | boolean | `false` | Removes all write and destructive tools for every host. |
| `confirmDestructive` | `auto`, `always` or `never` | `auto` | Confirmation policy for destructive calls. See [Destructive confirmation](#destructive-confirmation). |
| `defaultHost` | host alias | none | Host used when a tool call has no `host`. Must be a key under `hosts`. With exactly one host, that host is used and this field can be left out. |
| `hosts` | map | `{}` | Host aliases mapped to host settings. |
| `limits.maxOutputChars` | integer, 1000 to 10000000 | `60000` | Longer tool output is cut to this many characters, and a note says so. |
| `limits.taskWaitSeconds` | integer, 0 to 86400 | `600` | Upper bound in seconds for waiting on a Proxmox task. |
| `categories` | map | `{}` | Switches per category. See [Categories and tool switches](#categories-and-tool-switches). |

### Host aliases

The keys under `hosts` and the value of `defaultHost` use lower case letters, digits, `_` and `-`. The first character is a letter or digit, and the alias is at most 32 characters long.

### `hosts.<alias>`

| Field | Type | Default | Meaning |
|---|---|---|---|
| `description` | string, max 500 characters | none | Shown by `pve_hosts_list`. |
| `url` | https URL | required | Origin only: scheme, host and optional port, for example `https://pve.example.com:8006`. Credentials, a path other than `/`, a query and a fragment are errors. Stored as the origin. |
| `tokenId` | string | required | Proxmox API token ID in the form `user@realm!tokenname`, for example `mcp@pve!agent`. |
| `tokenSecret` | secret reference | required | Where the token secret comes from. See [secrets.md](secrets.md). A plain string is an error. |
| `tls` | object | `{}` | Certificate checks. See [TLS](#tls). |
| `readOnly` | boolean | `false` | Removes write and destructive calls for this host. |
| `timeoutSeconds` | integer, 1 to 3600 | `30` | Timeout for each HTTP request to this host. |

### `hosts.<alias>.tls`

| Field | Type | Default | Meaning |
|---|---|---|---|
| `verify` | boolean | `true` | `false` disables all certificate checks. Cannot be combined with `caFile` or `fingerprint`. |
| `caFile` | path, max 4096 characters | none | PEM file with a CA certificate, trusted in addition to the system CAs. |
| `fingerprint` | SHA-256 fingerprint | none | Pinned fingerprint of the server certificate: 64 hex digits, colons and letter case optional. Stored as upper case pairs separated by colons. |

## TLS

The fields select one of these modes:

| Settings | Mode | What is checked |
|---|---|---|
| `verify` true (default), no `caFile`, no `fingerprint` | CA | The certificate chain against the system CAs, and the host name from `url`. |
| `verify` true, `caFile` set | CA | The chain against the system CAs plus `caFile`, and the host name. |
| `fingerprint` set, no `caFile` | Pin | The SHA-256 fingerprint of the leaf certificate. The chain and the host name are not checked, so any certificate with the pinned fingerprint is accepted. |
| `fingerprint` and `caFile` set | Pin with CA | The chain against the system CAs plus `caFile`, the host name, and the fingerprint. |
| `verify` false | Insecure | Nothing. |

The fingerprint is compared right after the TLS handshake, before any request is sent. A certificate with another fingerprint is refused, and the error shows the expected and the actual value.

With `verify: false` the server writes a warning for that host on every start.

## Categories and tool switches

Tools belong to one of these categories. The ID is the key under `categories`.

| ID | Title |
|---|---|
| `core` | Core |
| `cluster` | Cluster |
| `nodes` | Nodes |
| `network` | Network |
| `guests` | Guests |
| `snapshots` | Snapshots |
| `storage` | Storage |
| `backup` | Backup |
| `tasks` | Tasks |
| `access` | Access |
| `firewall` | Firewall |
| `pools` | Pools |
| `ha` | High availability |
| `api` | Raw API |

Rules:

- A tool is active when its category is enabled (default `true`) and its own entry under `tools` is not `false`. Inactive tools are not registered with the MCP server, so clients do not see them.
- The `enabled` switch of `core` has no effect: core tools always stay active. Single core tools can be switched off, for example `tools: { pve_hosts_list: false }`.
- Each tool switch must name a real tool that belongs to that category.

```yaml
categories:
  ha:
    enabled: false
  api:
    tools:
      pve_api_request: false
```

## Read-only

Read-only mode keeps tools with access `read` and removes tools with access `write` or `destructive`.

- Top-level `readOnly: true`, or `PROXMOX_MCP_READ_ONLY`, removes these tools for every host.
- If every configured host has `readOnly: true`, these tools are removed as well.
- If only some hosts are read-only, the tools stay registered. A call with a write or destructive tool to a read-only host fails with `Host "<alias>" is read-only, <tool> was not run.` followed by a hint to use another host or to change `readOnly`. The other hosts still accept writes.

## Destructive confirmation

`confirmDestructive` applies to destructive tools and to calls that a tool flags for confirmation, such as a `DELETE` request through `pve_api_request`.

- `never`: the call runs without asking.
- `auto` (default): if the MCP client supports form elicitation, the user is asked to confirm. Without it, the call runs without a question from this server.
- `always`: the user is asked if the client supports form elicitation. Without it, the call is refused with a message that says the client cannot ask questions and that nothing was changed.

A call that is not confirmed is refused and not run. The answer reads `<tool> was not confirmed by the user. Nothing was changed.`

## Limits

- `limits.maxOutputChars` cuts long tool output. The cut output ends with a note that shows how many characters were kept and how many there were in total.
- `limits.taskWaitSeconds` is the upper bound for waiting on a Proxmox task. `pve_task_wait` caps its `timeoutSeconds` argument at this value. Tools that start a task wait for it up to this many seconds, unless their `wait` argument is `false`.

## Environment tightening

`PROXMOX_MCP_READ_ONLY` and `PROXMOX_MCP_DISABLE` work in file mode and in env-only mode. They can only make the settings stricter.

| Variable | Effect |
|---|---|
| `PROXMOX_MCP_READ_ONLY` | Boolean. True sets the top-level `readOnly` to true. False changes nothing. |
| `PROXMOX_MCP_DISABLE` | Comma-separated list of category IDs and tool names. A category ID sets `enabled: false` for that category, except `core`, which stays active. A tool name sets its switch to `false`. Unknown names stop startup. |

The boolean variables here and in env-only mode accept `1`, `true`, `yes` or `on` as true, and `0`, `false`, `no`, `off` or an empty value as false. Case and surrounding spaces are ignored. Any other value stops startup with an error.

## Env-only mode

Env-only mode is used when no explicit path is set (neither `--config` nor `PROXMOX_MCP_CONFIG`), the default file does not exist, and `PROXMOX_URL` is set. It builds one host with the alias `default`, and that alias is also the `defaultHost`.

| Variable | Required | Meaning |
|---|---|---|
| `PROXMOX_URL` | yes | Same rules as `url`. |
| `PROXMOX_TOKEN_ID` | yes | Same rules as `tokenId`. |
| `PROXMOX_TOKEN_SECRET` | one of the two | The token secret. It is read from this environment variable on the first request. |
| `PROXMOX_TOKEN_SECRET_FILE` | one of the two | Path to a file with the token secret. The file rules are the ones for `source: file` in [secrets.md](secrets.md). |
| `PROXMOX_TLS_VERIFY` | no | Boolean, default true. False disables all certificate checks. Read in env-only mode only. |
| `PROXMOX_CA_FILE` | no | Same as `tls.caFile`. |
| `PROXMOX_TLS_FINGERPRINT` | no | Same as `tls.fingerprint`. |
| `PROXMOX_READ_ONLY` | no | Boolean. Sets `readOnly` of the `default` host. Read in env-only mode only. |

Rules:

- Set exactly one of `PROXMOX_TOKEN_SECRET` and `PROXMOX_TOKEN_SECRET_FILE`. An empty value counts as not set.
- Settings without a variable (`timeoutSeconds`, `confirmDestructive`, `limits`, `categories`) keep their defaults.
- If a settings file is found (at the path from `--config`, `PROXMOX_MCP_CONFIG` or the default location), it wins. `PROXMOX_URL` and the other host variables are then ignored. If `PROXMOX_URL` is set as well, a warning says so.

## Startup output

The server writes to stderr, prefixed with `[proxmox-ve-mcp]`:

- `settings: <path>` for a settings file, or `settings: env` for env-only mode.
- `warning: ...` for each of these conditions:
  - the settings file is readable by group or others,
  - a settings file and `PROXMOX_URL` are both present,
  - TLS verification is disabled for a host,
  - no hosts are configured.
- `fatal: ...` and exit code 1 when the settings are invalid, or when the settings file or its directory fails the owner and write checks under "File rules".

## Editor support

`config.schema.json` is a JSON Schema of the settings file. `npm run generate` (`scripts/generate.ts`) writes it to the repository root, and it is listed in the npm package `files`.

To use it in an editor with yaml-language-server support, put this line at the top of the settings file:

```yaml
# yaml-language-server: $schema=/path/to/config.schema.json
```
