# Secrets

Each host needs one secret: the Proxmox API token secret. The settings file
names where it comes from in `tokenSecret` and never holds the value. A plain
string in `tokenSecret` is rejected.

For the rest of the settings file see [configuration.md](configuration.md).

## Principles

- The settings file holds a reference, never the value.
- Secrets are resolved per host on the first request to that host, not at
  startup. A host whose secret cannot be read fails on its first request and
  does not affect the other hosts.
- A successful lookup is kept in memory for the lifetime of the process. A
  failed lookup is not kept, so the next request tries again.
- Errors name the host and the source, never the value. Known secret values
  are removed from error text. Values shorter than 4 characters are not added
  to that list.

## Sources

| `source` | The value comes from | Keys |
|---|---|---|
| `env` | an environment variable of the server process | `name` |
| `file` | a file | `path` |
| `keyring` | the OS keychain | `service`, `account` |
| `1password` | the 1Password CLI, `op read` | `ref`, `account`, `binary` |
| `bws` | the Bitwarden Secrets Manager CLI, `bws secret get` | `secretId`, `accessToken`, `serverUrl`, `binary` |
| `vault` | the Vault CLI, `vault kv get` | `address`, `path`, `field`, `mount`, `token`, `namespace`, `binary` |
| `pass` | the `pass` password store, `pass show` | `name`, `binary` |
| `command` | a command you name, started without a shell | `command`, `timeoutSeconds` |

`binary` is an executable name looked up in PATH, or an absolute path. Each
example below is the value of `tokenSecret` for one host. The values are
placeholders.

### env

```yaml
tokenSecret:
  source: env
  name: PVE_LAB_TOKEN_SECRET
```

Reads the variable `name`, trimmed. An empty value is an error.

### file

```yaml
tokenSecret:
  source: file
  path: /etc/proxmox-mcp/lab-token-secret
```

Reads the file at `path`, with a leading `~` expanded, and uses its trimmed
content. Rules:

- The file is a regular file of at most 64 KiB and must not be empty.
- A symlink is followed only when the link is owned by the server user or
  root. A dangling symlink is an error.
- The file must be owned by the server user or by root.
- On Linux and macOS, group and other permission bits must be 0. Run
  `chmod 600 <path>`. The exception is a root-owned file under `/run/secrets/`,
  both the path and its real target, that group and others cannot write. Docker
  and Kubernetes mount secrets there.
- The permission checks are skipped on Windows.

### keyring

```yaml
tokenSecret:
  source: keyring
  service: proxmox-ve-mcp
  account: lab
```

Reads the entry for `service` and `account`. The defaults are `proxmox-ve-mcp`
for `service` and the host alias for `account`. This source needs the optional
package `@napi-rs/keyring`. `proxmox-ve-mcp secret set <alias>` reads the value
from a hidden prompt in a terminal, or from standard input with `--stdin`, and
stores it in the keychain under the `service` and `account` shown above. With
`--use-keyring` the host is switched to this source.

### 1password

```yaml
tokenSecret:
  source: 1password
  ref: op://example/proxmox-lab/token-secret
```

Runs `op read --no-newline <ref>`, with `--account <account>` before `read`
when `account` is set. `ref` must start with `op://` and contain no
whitespace. These variables are passed on to `op` when set: `OP_SERVICE_ACCOUNT_TOKEN`,
`OP_CONNECT_HOST`, `OP_CONNECT_TOKEN`, `OP_ACCOUNT`, `OP_CONFIG_DIR`,
`OP_BIOMETRIC_UNLOCK_ENABLED`, and every variable whose name starts with
`OP_SESSION_`.

### bws

```yaml
tokenSecret:
  source: bws
  secretId: 00000000-0000-0000-0000-000000000000
  serverUrl: https://secrets.example.com
```

Runs `bws secret get <secretId> --output json --color no` and uses the `value`
field of the result, trimmed. `secretId` must be a UUID. The access token comes
from the nested reference `accessToken`, or else from the variable
`BWS_ACCESS_TOKEN` of the server process. It is passed to `bws` as an
environment variable, never as an argument. `serverUrl` must be an https URL
without credentials and is passed to `bws` as `BWS_SERVER_URL`.

With the access token taken from a reference:

```yaml
tokenSecret:
  source: bws
  secretId: 00000000-0000-0000-0000-000000000000
  accessToken:
    source: env
    name: PVE_BWS_ACCESS_TOKEN
```

### vault

```yaml
tokenSecret:
  source: vault
  address: https://vault.example.com:8200
  path: proxmox/lab
  field: token_secret
  mount: secret
  token:
    source: env
    name: PVE_VAULT_TOKEN
```

Runs `vault kv get [-mount=<mount>] -field=<field> <path>`. `address` must be an
https URL, or an http URL to `localhost`, `127.0.0.1` or `[::1]`. It is passed
as `VAULT_ADDR` and `BAO_ADDR`, and `namespace` as `VAULT_NAMESPACE` and
`BAO_NAMESPACE`. The nested reference `token` is passed as `VAULT_TOKEN` and
`BAO_TOKEN`. Without `address`, `namespace` or `token`, the matching variables
of the server process are passed on. The variables `CACERT`, `CAPATH`,
`CLIENT_CERT`, `CLIENT_KEY`, `TLS_SERVER_NAME` and `CONFIG_PATH`, each with the
prefix `VAULT_` or `BAO_`, are passed on when set in the server process.
`VAULT_SKIP_VERIFY` and `BAO_SKIP_VERIFY` are never passed on.

### pass

```yaml
tokenSecret:
  source: pass
  name: proxmox/lab-token
```

Runs `pass show <name>` and uses the first line of the output, trimmed. `name`
must not start with `-` and must not contain `.` or `..` segments. An empty
first line is an error.

### command

```yaml
tokenSecret:
  source: command
  command: [example-cli, get, proxmox-lab-token]
  timeoutSeconds: 10
```

Runs the program named in `command` with the remaining items as arguments. The
list has 1 to 64 items. The command is started directly, never through a shell.
The trimmed standard output is the value. Empty output is an error. The
timeout is `timeoutSeconds`, from 1 to 300, and defaults to 30 seconds.

## Nested references

Two fields take a reference of their own: `bws.accessToken` and `vault.token`.
They accept the sources `env`, `file`, `keyring` (with `account` required),
`1password`, `pass` and `command`. A nested reference cannot be `bws` or
`vault`, so the references never nest further.

## How secrets are handled

- The programs `op`, `bws`, `vault`, `pass` and the `command` source are
  started without a shell and with stdin not connected.
- A child process gets a fixed set of base variables plus the variables its
  provider needs. On Linux and macOS the base set is `PATH`, `HOME`, `USER`,
  `LOGNAME`, `LANG`, `LC_ALL`, `LC_CTYPE`, `TMPDIR` and the `XDG_*`
  directories. On Windows it is a set of Windows variables such as `PATH`,
  `SYSTEMROOT` and `USERPROFILE`. Nothing else from the server environment is
  passed on.
- Every child process has a timeout. On POSIX systems the whole process group
  is killed when it expires.
- The standard output of a child process is limited to 1 MiB. Error text from a
  failing command is cut to 300 characters, and lines that the command printed
  on standard output are removed from it.
- Secret values are not put on the command line. `bws` and `vault` receive
  their tokens through environment variables.
- In env-only mode, `PROXMOX_TOKEN_SECRET` becomes an `env` reference to that
  variable, and `PROXMOX_TOKEN_SECRET_FILE` becomes a `file` reference. The
  value is not copied into the settings.
