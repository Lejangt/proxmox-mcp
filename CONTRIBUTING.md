# Contributing

This file covers the setup, the project layout and the rules for changes. The design is in [docs/architecture.md](docs/architecture.md).

## Setup

Use Node.js 22 or newer. CI runs Node 22 and 24.

```sh
npm ci
npm run build
npm test
npm run lint
npm run typecheck
npm run generate
```

`npm run generate` writes [docs/tools.md](docs/tools.md) and `config.schema.json` from the tool catalog. CI runs `npm run generate -- --check`, which writes nothing and exits with 1 when one of these files is out of date. Run `npm run generate` after every change to a tool.

## Layout

The full layout is in [docs/architecture.md](docs/architecture.md#layout). In short:

- `src/index.ts`: entry point, starts the server or runs a CLI command.
- `src/cli/`: setup, host, secret, tools, config, doctor and client-config.
- `src/config/`: settings schema, loading and writing.
- `src/secrets/`: secret references and providers.
- `src/proxmox/`: HTTPS client, TLS, path validation and hosts.
- `src/server/`: MCP server, tool registry, confirmation and output formatting.
- `src/tools/`: one file per category. `catalog.ts` collects all tools.
- `test/`: vitest tests without network access. Helpers are in `test/helpers/`.

## Adding a tool

1. Add a `defineTool({ ... })` to the array of its category in `src/tools/<category>.ts`. Set `name` (snake_case with the prefix `pve_`), `category`, `title`, `description` (written for an agent: what the tool does, when to call it, notable parameters), `access`, `input` and `handler`.
2. Set `access` honestly. Use `read` for tools that only read, `write` for changes, and `destructive` for operations that lose data or cut off access. Examples are deleting guests, volumes, snapshots or rules, rolling back a snapshot, and rebooting a node. The rule is in [docs/architecture.md](docs/architecture.md#destructive-operations).
3. Add a row to the table "Categories and tools" in [docs/architecture.md](docs/architecture.md#categories-and-tools). The row has the category, the tool name, the access as `R`, `W` or `D`, and the purpose. `test/catalog.test.ts` reads this table and fails when a tool is missing from it or when its category or access differs.
   A `destructive` tool, and a `write` tool with `needsConfirmation`, needs a `confirmTarget(args, ctx)` that names the concrete target (the helpers in `src/tools/targets.ts` add guest name and node). `test/safety.test.ts` fails without it. Free form records (`extra`, `set`, `options`) go through `mergeOptions` with the keys of path parameters and safety rules in `reserved`. Values with `/` in a path need `volid()` (volume ids only).
4. `src/tools/catalog.ts` needs a change only for a new category file, because it spreads the arrays of the category files into `ALL_TOOLS`.
5. Add a test that uses `fakeClient` from `test/helpers/fake-client.ts` and, when needed, `fakeContext` from `test/helpers/fixtures.ts`. The fake client records requests and answers from a table of routes, so no network is needed. `test/tools-basic.test.ts` shows the pattern.
6. Run `npm run generate` and include the updated [docs/tools.md](docs/tools.md) and `config.schema.json` in the change.

## Security-relevant changes

Changes to `src/proxmox/client.ts`, `src/proxmox/tls.ts`, `src/proxmox/path.ts`, `src/secrets/`, `src/config/` and `src/cli/` need tests for attack cases. Examples are a tool parameter with `..` in a path, a server certificate with another fingerprint than the pinned one, a secret file that group or others can read, a settings file with an unknown key, and a secret given as a command argument. Existing tests for these areas are in `test/safety.test.ts`, `test/confirm.test.ts`, `test/path.test.ts`, `test/tls.test.ts`, `test/secrets.test.ts`, `test/secret-file-policy.test.ts`, `test/config-load.test.ts` and `test/cli-host-secret.test.ts`.

## Test data

Tests and examples must not contain real host names, tokens or IP addresses. Use `example.com` names, addresses from `192.0.2.0/24` and the token ID `mcp@pve!agent`.

## Reporting security gaps

Report security gaps as described in [SECURITY.md](SECURITY.md).
