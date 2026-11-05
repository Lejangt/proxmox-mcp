# Proxmox permissions for proxmox-ve-mcp

`proxmox-ve-mcp` talks to Proxmox VE with an API token. The token decides what
an agent can do. The switches in the settings file (read-only mode, categories,
tool switches) only restrict it further. This page shows how to create a user
and a token in Proxmox VE 9 and which privileges each kind of agent needs.

Privilege names are taken from the
[Proxmox VE user management chapter](https://pve.proxmox.com/pve-docs/chapter-pveum.html)
and the permission rules of each endpoint from the
[API viewer](https://pve.proxmox.com/pve-docs/api-viewer/).

## 1. Create a user and an API token

The examples use the user `mcp@pve` and the token name `agent`, so the token id
is `mcp@pve!agent`. Run the commands as root on any cluster node.

### On the command line

```sh
# A user in the Proxmox VE realm. It needs no password, it only owns the token.
pveum user add mcp@pve --comment "MCP server"

# An API token with privilege separation.
pveum user token add mcp@pve agent --privsep 1
```

The second command prints the token secret (a UUID) **once**. Store it right
away, for example with `proxmox-ve-mcp secret set <alias>` in the OS keychain
or in a file only you can read. Proxmox cannot show it again, you can only
delete the token and create a new one.

Optionally give the token an expiry date (Unix epoch seconds), so a forgotten
setup stops working on its own:

```sh
pveum user token add mcp@pve agent --privsep 1 --expire 1798761600
```

### In the web interface

1. **Datacenter > Permissions > Users > Add**: user name `mcp`, realm
   `Proxmox VE authentication server`, comment `MCP server`.
2. **Datacenter > Permissions > API Tokens > Add**: user `mcp@pve`, token ID
   `agent`, keep **Privilege Separation** checked. Copy the secret from the
   dialog, it is shown only once.
3. Grant permissions as described in the next section with **Datacenter >
   Permissions > Add > User Permission** and **Add > API Token Permission**.

## 2. Grant permissions to the token (and the user)

With privilege separation the token has **no permissions at all** until it gets
its own ACL entries. Its effective permissions are the **intersection** of the
user's permissions and the token's own ACL entries: the token can never do more
than its user. So both need an entry:

```sh
pveum acl modify / --users mcp@pve --roles PVEAuditor
pveum acl modify / --tokens 'mcp@pve!agent' --roles PVEAuditor
```

Replace `/` and `PVEAuditor` with the path and role of the profile you choose
below. Giving the user a broad role and the token a narrow one is fine, the
narrower one wins. Quote the token id, `!` has a meaning in most shells.

A typical mistake is a 403 `Permission check failed` although the user has the
right role: the token itself has no ACL entry. `proxmox-ve-mcp` points this out
in the error message.

Without privilege separation (`--privsep 0`) the token has exactly the
permissions of its user. That works, but it ties the agent to whatever the
user can do, now and later.

## 3. Choose a profile

| Profile | Role | Path | What the agent can do |
| --- | --- | --- | --- |
| Read-only | `PVEAuditor` | `/` | Read everything the read tools show, change nothing |
| Read-only plus power | `PVEAuditor` and `MCPPower` | `/` | Read, and start, stop and reboot guests |
| Guest operator | `MCPOperator` | `/` or a pool | Run guests day to day, no host or user administration |
| Full admin | `PVEAdmin` or `Administrator` | `/` | Everything the tools offer |

Combine the token profile with matching settings, for example `readOnly: true`
for the read-only profile. The server checks its own switches before it asks
Proxmox, the token is the line Proxmox enforces.

### Read-only

```sh
pveum acl modify / --users mcp@pve --roles PVEAuditor
pveum acl modify / --tokens 'mcp@pve!agent' --roles PVEAuditor
```

Set `readOnly: true` in the settings file as well. A few read tools need
privileges that are not part of a read-only role, they fail with a 403 and
everything else keeps working (see the table in section 4, for example
`pve_node_apt_updates` and `pve_node_syslog`).

### Read-only plus power

Read access plus `VM.PowerMgmt`, nothing else:

```sh
pveum role add MCPPower --privs "VM.PowerMgmt"
pveum acl modify / --users mcp@pve --roles PVEAuditor,MCPPower
pveum acl modify / --tokens 'mcp@pve!agent' --roles PVEAuditor,MCPPower
```

Keep `readOnly: false` (read-only mode would remove `pve_guest_power`) and
switch off the write tools you do not want listed, for example by disabling
every category except the ones you need and every write tool except
`pve_guest_power`. Proxmox refuses everything else anyway.

### Guest operator (`MCPOperator`)

A custom role for an agent that manages guests: read guests, create,
configure, start and stop, clone, migrate, snapshot, back up and restore them,
read storage and download ISO images and container templates. It deliberately
does **not** contain user and permission management (`User.Modify`,
`Permissions.Modify`, `Realm.Allocate`, `Realm.AllocateUser`), system changes
(`Sys.Modify`), node power (`Sys.PowerMgmt`), storage definitions
(`Datastore.Allocate`) or arbitrary guest agent commands
(`VM.GuestAgent.Unrestricted`).

```sh
pveum role add MCPOperator --privs "VM.Audit,VM.Allocate,VM.Clone,VM.Config.Disk,VM.Config.CDROM,VM.Config.CPU,VM.Config.Memory,VM.Config.Network,VM.Config.HWType,VM.Config.Options,VM.Config.Cloudinit,VM.PowerMgmt,VM.Migrate,VM.Snapshot,VM.Backup,VM.GuestAgent.Audit,Datastore.Audit,Datastore.AllocateSpace,Datastore.AllocateTemplate,SDN.Use,Sys.Audit,Sys.AccessNetwork"
pveum acl modify / --users mcp@pve --roles MCPOperator
pveum acl modify / --tokens 'mcp@pve!agent' --roles MCPOperator
```

Why each privilege is there:

| Privilege | Needed for |
| --- | --- |
| `VM.Audit` | Listing guests, status, config, metrics, snapshots, cloud-init. Guests without it are invisible in the resource list. |
| `VM.Allocate` | Creating VMs and containers, converting to a template, the target of a clone, restoring a backup to a new VMID |
| `VM.Clone` | The source of a clone |
| `VM.Config.*` (8 privileges) | Creating guests with their settings, `pve_guest_update_config`, resizing and moving disks |
| `VM.PowerMgmt` | `pve_guest_power` |
| `VM.Migrate` | `pve_guest_migrate` |
| `VM.Snapshot` | Creating, deleting and rolling back snapshots |
| `VM.Backup` | `pve_backup_create`, restoring over an existing guest |
| `VM.GuestAgent.Audit` | `pve_vm_agent_info` (informational agent commands only) |
| `Datastore.Audit` | Listing storages, their content and backups |
| `Datastore.AllocateSpace` | Disks on create, clone, move and restore, writing backups |
| `Datastore.AllocateTemplate` | `pve_storage_download_url`, `pve_storage_template_download` |
| `SDN.Use` | Attaching guests to bridges and VNets on create, clone and config changes |
| `Sys.Audit` | Node status, cluster status, task lists of other users, backup job list, SMART data |
| `Sys.AccessNetwork` | `pve_storage_download_url` (the node fetches a URL) |

Things to know about this role:

- `VM.Allocate` is also the privilege to **delete** a guest, and `VM.Snapshot`
  alone allows a snapshot **rollback**. Proxmox has no separate privilege for
  either, so `pve_guest_delete` and `pve_snapshot_rollback` work with this
  role. Switch the tools off in the settings file if the agent must not use
  them, and keep `confirmDestructive` at `auto` or `always`.
- `Sys.AccessNetwork` was added during the Proxmox VE 8 series for the
  download endpoint. It is not listed in the privilege table of the admin
  guide, but the API viewer names it for `download-url`, and among the builtin
  roles only `Administrator` has it. Without it, downloading from a URL
  needs `Sys.Audit` and `Sys.Modify` on `/`, which this role avoids on purpose.
  If `pveum role add` rejects the name on your version, leave it out and
  `pve_storage_download_url` will fail with a 403.
- Not covered: backup jobs (`pve_backup_job_set`, `pve_backup_job_delete`
  need `Sys.Modify` on `/`), storage definitions and deleting non-backup
  volumes (`Datastore.Allocate`), privileged containers (`Sys.Modify` on `/`),
  `pve_vm_agent_exec` (`VM.GuestAgent.Unrestricted`), node services, network,
  firewall at cluster and node level, pools and HA.
- Some vzdump options are restricted by Proxmox: an explicit `prune-backups`
  needs `Datastore.Allocate`, `bwlimit`, `ionice` and `performance` need
  `Sys.Modify`, and `tmpdir`, `dumpdir` and `script` are reserved for
  `root@pam`. `pve_backup_create` does not send these.

To let the agent run commands in VMs as well, add `VM.GuestAgent.Unrestricted`
to the role (`pveum role modify MCPOperator --privs VM.GuestAgent.Unrestricted --append 1`).
That is effectively root access inside every VM the role covers.

### Full admin

```sh
pveum acl modify / --users mcp@pve --roles PVEAdmin
pveum acl modify / --tokens 'mcp@pve!agent' --roles PVEAdmin
```

`PVEAdmin` can do most tasks but cannot modify system settings. It lacks the
privileges reserved for `Administrator`, for example `Sys.AccessNetwork`, so
some tools fail with a 403.
`Administrator` can do everything, including user and permission management,
node power, network and storage configuration.

**Warning:** with either role a single wrong or manipulated tool call can
delete guests and backups, change the network of a node, or (with
`Administrator`) create new users and tokens for an attacker. Content from
Proxmox (VM descriptions, logs, guest agent output) reaches the model and can
contain instructions, see [SECURITY.md](../SECURITY.md). Use this profile only
with confirmation of destructive operations enabled and a client that asks
before running tools.

## 4. Privileges per category

The path in brackets is where Proxmox checks the privilege. `{node}`, `{vmid}`
and `{storage}` stand for the object the tool works on.

| Category | Read tools | Write and destructive tools |
| --- | --- | --- |
| core | none | none |
| cluster | `Sys.Audit` (`/`) for cluster status. The resource list only shows objects with an audit privilege. `Sys.Syslog` (`/`) for the full cluster log. | none |
| nodes | `Sys.Audit` (`/nodes/{node}`) for status, metrics, services, disks, SMART data needs it on `/`. `Sys.Syslog` (`/nodes/{node}`) for the journal. `pve_node_apt_updates` needs `Sys.Modify` (`/nodes/{node}`). | `Sys.Modify` (`/nodes/{node}`) for service actions, `Sys.PowerMgmt` (`/nodes/{node}`) for `pve_node_power` |
| network | none | `Sys.Modify` (`/nodes/{node}`) |
| guests | `VM.Audit` (`/vms/{vmid}`), `VM.GuestAgent.Audit` for agent info | `VM.PowerMgmt`, `VM.Config.*`, `VM.Migrate`, `VM.Clone`, `VM.Allocate` (all `/vms/{vmid}` or the pool), `Datastore.AllocateSpace` (`/storage/{storage}`) for disks, `SDN.Use` for bridges, `VM.GuestAgent.Unrestricted` for `pve_vm_agent_exec` |
| snapshots | `VM.Audit` (`/vms/{vmid}`) | `VM.Snapshot` (`/vms/{vmid}`). Rollback accepts `VM.Snapshot` or `VM.Snapshot.Rollback`. |
| storage | `Datastore.Audit` (`/storage/{storage}`) | `Datastore.AllocateTemplate` (`/storage/{storage}`) for downloads, plus `Sys.AccessNetwork` (`/nodes/{node}`) for `download-url`. `Datastore.Allocate` for deleting volumes (backup volumes: `Datastore.AllocateSpace` plus `VM.Backup` on the guest) and on `/storage` for storage definitions. |
| backup | `Datastore.Audit` (`/storage/{storage}`), `Sys.Audit` (`/`) for the job list | `VM.Backup` (`/vms/{vmid}`) and `Datastore.AllocateSpace` (`/storage/{storage}`) for backups and restores, `VM.Allocate` for a restore to a new VMID, `Sys.Modify` (`/`) for backup jobs |
| tasks | none for tasks of this token, `Sys.Audit` (`/nodes/{node}`) for tasks of others | `Sys.Modify` (`/nodes/{node}`) to stop tasks of others |
| access | Lists are filtered by Proxmox: users need `Sys.Audit` or `User.Modify` on `/access/groups`, ACLs are shown where the token may modify permissions. `pve_access_permissions` for the own token needs nothing. | none |
| firewall | Cluster `Sys.Audit` (`/`), node `Sys.Audit` (`/nodes/{node}`), guest `VM.Audit` (`/vms/{vmid}`) | Cluster `Sys.Modify` (`/`), node `Sys.Modify` (`/nodes/{node}`), guest `VM.Config.Network` (`/vms/{vmid}`) |
| pools | `Pool.Audit` (`/pool/{pool}`) | `Pool.Allocate` (`/pool/{pool}`), plus the right to modify permissions on added or removed members |
| ha | `Sys.Audit` (`/`) | `Sys.Console` (`/`) |
| api | whatever the endpoint requires, `pve_api_describe` shows it | whatever the endpoint requires |

API tokens cannot use console endpoints at all, regardless of their
privileges.

## 5. Limit the agent to some guests and storages with a pool

A resource pool groups guests and storages, and permissions on
`/pool/<name>` apply to all members. Grant the role on the pool instead of `/`:

```sh
pveum pool add mcp-lab --comment "Guests the MCP agent may manage"
pveum pool modify mcp-lab --vms 100,101,102 --storage local-lvm,backup

pveum acl modify /pool/mcp-lab --users mcp@pve --roles MCPOperator
pveum acl modify /pool/mcp-lab --tokens 'mcp@pve!agent' --roles MCPOperator
```

Node and network privileges are not checked on pool paths. Grant the same role
on the paths where they apply, the VM and storage privileges in it have no
effect there:

```sh
# Sys.Audit and Sys.AccessNetwork on the nodes
pveum acl modify /nodes --users mcp@pve --roles MCPOperator
pveum acl modify /nodes --tokens 'mcp@pve!agent' --roles MCPOperator
# SDN.Use on local bridges
pveum acl modify /sdn/zones/localnetwork --users mcp@pve --roles MCPOperator
pveum acl modify /sdn/zones/localnetwork --tokens 'mcp@pve!agent' --roles MCPOperator
```

New guests have to be created in the pool: pass `pool` to `pve_vm_create`,
`pve_lxc_create`, `pve_guest_clone` and `pve_backup_restore`. Proxmox then
checks `VM.Allocate` on `/pool/<name>` instead of `/vms/<vmid>`. Guests outside
the pool stay invisible to the agent.

## 6. Check what the token can do

- `proxmox-ve-mcp doctor` checks the configuration, secrets, TLS and
  connectivity of every host and shows the permissions of the token.
- The tool `pve_access_permissions` returns the effective privileges of the
  token per path, optionally limited to one path such as `/vms/100`. An agent
  can call it to find out what it is allowed to do before it tries.
- On a node, `pveum user token permissions mcp@pve agent` shows the same, and
  `pveum user permissions mcp@pve` shows those of the user.
