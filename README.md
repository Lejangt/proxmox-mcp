# Proxmox MCP

[![CI](https://github.com/Lejangt/proxmox-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/Lejangt/proxmox-mcp/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/proxmox-ve-mcp)](https://www.npmjs.com/package/proxmox-ve-mcp)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

Proxmox MCP is an MCP server for Proxmox VE. It lets MCP clients manage VMs, containers, storage, backups and more through the Proxmox API, authenticated with API tokens.

## Highlights

- 77 tools in 14 categories: VMs and containers, storage, backups, snapshots, networking, firewall, HA, pools, tasks, access rights, and a generic API access with schema lookup.
- Several independent Proxmox hosts or clusters in one settings file, with a default host.
- Token secrets from the OS keychain, Bitwarden Secrets Manager, 1Password, Vault or OpenBao, `pass`, an environment variable, a file, or your own command.
- TLS certificate verification on by default, with a CA file or SHA-256 fingerprint pinning.
- Read-only mode, globally or per host.
- One settings file (YAML) that lists every category and tool, so each one can be switched on or off.
- Confirmation before destructive actions, when the MCP client supports it.
- Setup assistant: `npx proxmox-ve-mcp setup`.

## Quick start

1. In Proxmox VE, create a user and an API token with privilege separation. Grant the token only the rights the agent needs. The steps are in [docs/permissions.md](docs/permissions.md).
2. Run the setup assistant. It checks the server certificate, asks for the token and where its secret is stored, tests the connection and writes the settings file.

   ```sh
   npx proxmox-ve-mcp setup
   ```

3. Connect your MCP client. For Claude Code, run:

   ```sh
   claude mcp add --transport stdio proxmox -- npx -y proxmox-ve-mcp
   ```

   For the other clients see [Connect your client](#connect-your-client), or run `npx proxmox-ve-mcp client-config <client>`.

4. Check the setup:

   ```sh
   npx proxmox-ve-mcp doctor
   ```

## Connect your client

`npx proxmox-ve-mcp client-config <client>` prints the snippet for a client and says where it goes. The snippets below match that output in a more compact form. If the file already has other servers, add only the `proxmox` entry.

**Claude Code** runs the one-line command from the quick start. Add `--scope user` before `proxmox` to use the server in every project.

**Claude Desktop** config file: `~/.config/Claude/claude_desktop_config.json` on Linux, `~/Library/Application Support/Claude/claude_desktop_config.json` on macOS, `%APPDATA%\Claude\claude_desktop_config.json` on Windows. Restart Claude Desktop afterwards.

```json
{
  "mcpServers": {
    "proxmox": { "command": "npx", "args": ["-y", "proxmox-ve-mcp"] }
  }
}
```

**Cursor** config file: `~/.cursor/mcp.json` for all projects, or `.cursor/mcp.json` for one project.

```json
{
  "mcpServers": {
    "proxmox": { "type": "stdio", "command": "npx", "args": ["-y", "proxmox-ve-mcp"] }
  }
}
```

**VS Code** config file: `.vscode/mcp.json` in the workspace. The key is `servers`, not `mcpServers`.

```json
{
  "servers": {
    "proxmox": { "type": "stdio", "command": "npx", "args": ["-y", "proxmox-ve-mcp"] }
  }
}
```

**Codex** config file: `~/.codex/config.toml`. Or run `codex mcp add proxmox -- npx -y proxmox-ve-mcp`.

```toml
[mcp_servers.proxmox]
command = "npx"
args = ["-y", "proxmox-ve-mcp"]
```

**Windsurf** config file: `~/.codeium/windsurf/mcp_config.json`. Restart Windsurf or refresh the MCP servers afterwards.

```json
{
  "mcpServers": {
    "proxmox": { "command": "npx", "args": ["-y", "proxmox-ve-mcp"] }
  }
}
```

## Configuration

The settings file is YAML. The server looks for it in this order:

1. `--config <path>` on the command line, or the `PROXMOX_MCP_CONFIG` environment variable.
2. The default location: `~/.config/proxmox-ve-mcp/config.yaml` on Linux and macOS (below `$XDG_CONFIG_HOME` if set), `%APPDATA%\proxmox-ve-mcp\config.yaml` on Windows.

Example with two hosts and a few switches:

```yaml
version: 1
defaultHost: lab
categories:
  ha:
    enabled: false
  api:
    tools:
      pve_api_request: false
hosts:
  lab:
    description: Lab cluster
    url: https://pve-lab.example.com:8006
    tokenId: mcp@pve!agent
    tokenSecret:
      source: keyring
  prod:
    description: Production cluster, read-only for this server
    url: https://pve-prod.example.com:8006
    tokenId: mcp@pve!agent
    tokenSecret:
      source: bws
      secretId: 00000000-0000-0000-0000-000000000000
    tls:
      caFile: /etc/proxmox-mcp/pve-prod-ca.pem
    readOnly: true
```

Unknown keys stop the server at startup, so typos are not ignored. `npx proxmox-ve-mcp config validate` checks the file. The server also runs without a file when `PROXMOX_URL`, `PROXMOX_TOKEN_ID` and `PROXMOX_TOKEN_SECRET` or `PROXMOX_TOKEN_SECRET_FILE` are set. All fields, the TLS modes and the environment variables are in [docs/configuration.md](docs/configuration.md).

## Secrets

Each host reads its token secret from one source. The secret is resolved on first use and is never written to logs, tool output or error messages.

| Source      | Use it when                                                                                                                                                   | Example reference                                                   |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| `keyring`   | A workstation with an OS keychain. The default entry is service `proxmox-ve-mcp` and account = host alias. Store it with `proxmox-ve-mcp secret set <alias>`. | `{ source: keyring, service: proxmox-ve-mcp, account: lab }`        |
| `env`       | Containers and CI that pass the secret as an environment variable.                                                                                            | `{ source: env, name: PVE_LAB_TOKEN }`                              |
| `file`      | Docker secrets or other files under `/run/secrets`. On Linux and macOS the file must not be readable by group or others.                                      | `{ source: file, path: /run/secrets/pve-lab-token }`                |
| `bws`       | Bitwarden Secrets Manager. The access token comes from `BWS_ACCESS_TOKEN` unless the reference sets one.                                                      | `{ source: bws, secretId: 00000000-0000-0000-0000-000000000000 }`   |
| `1password` | 1Password, read through the `op` CLI.                                                                                                                         | `{ source: 1password, ref: op://Homelab/proxmox-lab/token }`        |
| `vault`     | HashiCorp Vault or OpenBao, read through the `vault` or `bao` CLI.                                                                                            | `{ source: vault, path: proxmox/lab, field: token }`                |
| `pass`      | The `pass` password store.                                                                                                                                    | `{ source: pass, name: proxmox/lab }`                               |
| `command`   | Your own command that prints the secret. It runs as an argument list, never through a shell.                                                                  | `{ source: command, command: ["/usr/local/bin/pve-token", "lab"] }` |

Details and the rules of each source: [docs/secrets.md](docs/secrets.md).

## Safety

- **Read-only:** `readOnly: true` at the top level, or `PROXMOX_MCP_READ_ONLY=1`, removes all write and destructive tools. Per host, `readOnly: true` refuses write and destructive calls to that host, and the other hosts still accept them.
- **Categories and tools:** whole categories or single tools can be switched off in the settings file. A switched-off tool is not registered, so the client never sees it.
- **Confirmation:** `confirmDestructive` is `auto` by default and asks the user when the client supports it. `always` refuses destructive calls when the client cannot ask. `never` runs them without asking.
- **Token rights:** the API token is the real boundary. The server cannot do more in Proxmox than the token is allowed to do. See [docs/permissions.md](docs/permissions.md).
- **TLS:** certificate checks stay on by default. For self-signed certificates use `tls.caFile` or `tls.fingerprint`.

The threat model and the known risks are in [SECURITY.md](SECURITY.md).

## Tools

| Category                 | Tools | Examples                                                               |
| ------------------------ | ----- | ---------------------------------------------------------------------- |
| Core (`core`)            | 2     | `pve_hosts_list`, `pve_version`                                        |
| Cluster (`cluster`)      | 4     | `pve_cluster_status`, `pve_next_vmid`                                  |
| Nodes (`nodes`)          | 9     | `pve_node_status`, `pve_node_power`                                    |
| Network (`network`)      | 5     | `pve_network_list`, `pve_network_apply`                                |
| Guests (`guests`)        | 17    | `pve_guest_list`, `pve_guest_power`, `pve_vm_create`, `pve_lxc_create` |
| Snapshots (`snapshots`)  | 4     | `pve_snapshot_list`, `pve_snapshot_rollback`                           |
| Storage (`storage`)      | 8     | `pve_storage_list`, `pve_storage_download_url`                         |
| Backup (`backup`)        | 6     | `pve_backup_create`, `pve_backup_restore`                              |
| Tasks (`tasks`)          | 5     | `pve_task_status`, `pve_task_wait`                                     |
| Access (`access`)        | 2     | `pve_access_list`, `pve_access_permissions`                            |
| Firewall (`firewall`)    | 6     | `pve_firewall_rules`, `pve_firewall_rule_add`                          |
| Pools (`pools`)          | 3     | `pve_pool_list`, `pve_pool_set`                                        |
| High availability (`ha`) | 3     | `pve_ha_status`, `pve_ha_resource_set`                                 |
| Raw API (`api`)          | 3     | `pve_api_get`, `pve_api_describe`                                      |

Each tool has an access level: R (read), W (write) or D (destructive). The parameters of every tool are in [docs/tools.md](docs/tools.md).

## CLI

```
proxmox-ve-mcp [--config <path>]          start the MCP server on stdio (what MCP clients run)
proxmox-ve-mcp <command> [options]

setup                                     interactive setup: host, TLS, token, secret store, client snippet
host list|add|edit|remove|test [alias]    manage Proxmox hosts
secret set <alias> [--stdin]              store or replace a token secret in the OS keychain
tools [--json]                            list categories and tools with access level and state
config path|validate|sync|edit            work with the settings file
doctor [alias]                            check settings, secrets, TLS, connection and permissions
client-config <client> [--name <n>]       print the snippet for an MCP client
help [command]                            show help, also: <command> --help
```

`--config <path>` works with every command. `-v` or `--version` prints the version. Options such as `--json`, `--yes`, `--delete-secret`, `--use-keyring` and `--dry-run` are listed by `proxmox-ve-mcp help <command>`.

## Docker

```sh
docker build -t proxmox-ve-mcp .
```

Env-only mode, without a settings file:

```sh
docker run -i --rm \
  -e PROXMOX_URL=https://pve.example.com:8006 \
  -e PROXMOX_TOKEN_ID='mcp@pve!agent' \
  -e PROXMOX_TOKEN_SECRET_FILE=/run/secrets/pve-token \
  -v /path/to/pve-token:/run/secrets/pve-token:ro \
  proxmox-ve-mcp
```

Or mount a settings file and the secret files it refers to:

```sh
docker run -i --rm \
  -e PROXMOX_MCP_CONFIG=/config/config.yaml \
  -v /path/to/config.yaml:/config/config.yaml:ro \
  -v /path/to/secrets:/run/secrets:ro \
  proxmox-ve-mcp
```

The container has no OS keychain, so the `keyring` source does not work there. Use `env`, `file` or a secret manager reference instead.

## Development

See [CONTRIBUTING.md](CONTRIBUTING.md) for the setup, the project layout and how to add a tool.

## License

MIT. See [LICENSE](LICENSE).
