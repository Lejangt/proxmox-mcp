# Changelog

All notable changes to this project are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
