# Changelog

All notable changes to this project are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.1] - 2026-11-06

### Changed

- First release published from GitHub Actions through npm trusted
  publishing (OIDC, no stored npm token), with provenance.
- Development happens on `dev`. `main` changes only through pull requests
  with passing CI. Dependabot opens its updates against `dev`.

No changes to the server or the CLI compared to 0.1.0.

## [0.1.0] - 2026-11-05

### Added

- Several Proxmox hosts in one settings file, with a default host.
- Secret references resolved from environment variables, files, commands, the
  OS keyring, `pass`, Bitwarden Secrets Manager, 1Password, and HashiCorp Vault
  or OpenBao.
- Settings file (YAML) with tool categories and per-tool switches.
- Read-only mode, global and per host.
- Confirmation before destructive actions.
- TLS certificate verification on by default, and TLS certificate pinning.
- Setup assistant: `proxmox-ve-mcp setup`.
- 77 tools in 14 categories: access, api, backup, cluster, core, firewall,
  guests, ha, network, nodes, pools, snapshots, storage, and tasks.

[Unreleased]: https://github.com/Lejangt/proxmox-mcp/compare/v0.1.1...HEAD
[0.1.1]: https://github.com/Lejangt/proxmox-mcp/compare/814425c...v0.1.1
[0.1.0]: https://github.com/Lejangt/proxmox-mcp/tree/814425ccef4395ef9da7204c12356a81d4cf29dd
