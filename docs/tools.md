# Tools

Access: R = read, W = write, D = destructive. Every tool also takes the optional parameter `host`, except local tools (`pve_hosts_list`), which never contact Proxmox.

## Core

Configured Proxmox targets and the Proxmox version of a host.

| Tool | Access | Description |
|---|---|---|
| `pve_hosts_list` | R | List the configured Proxmox targets with alias, URL, description, read-only flag and which one is the default. |
| `pve_version` | R | Get the Proxmox VE version of a host (version, release, repository id). |

### Parameters

**`pve_hosts_list`**

- None. Local tool, no `host` parameter.

**`pve_version`**

- None besides `host`.

## Cluster

Cluster membership, resources, free VMIDs and the cluster log.

| Tool | Access | Description |
|---|---|---|
| `pve_cluster_status` | R | Cluster membership: cluster name, quorum, and every node with online state and IP. |
| `pve_cluster_resources` | R | List resources across the whole cluster with usage: VMs and containers, storages, nodes, pools. |
| `pve_next_vmid` | R | Get the next free VMID of the cluster, to use when creating a VM or container. |
| `pve_cluster_log` | R | Recent cluster log entries (task starts and ends, user actions, errors) across all nodes, newest first. |

### Parameters

**`pve_cluster_status`**

- None besides `host`.

**`pve_cluster_resources`**

- `type` (optional): Resource type. vm means qemu and lxc together. Omit for all types.
- `node` (optional): Only resources on this node
- `status` (optional): Only resources with this status, for example running, stopped, online, available
- `full` (optional): Return all fields instead of the compact set

**`pve_next_vmid`**

- `vmid` (optional): Check this VMID instead

**`pve_cluster_log`**

- `max` (optional): Maximum number of entries, default 50

## Nodes

Node status, metrics, services, logs, disks, updates and power control.

| Tool | Access | Description |
|---|---|---|
| `pve_node_list` | R | Nodes of the host or cluster with online status, CPU load (0 to 1), memory, uptime and support level. |
| `pve_node_status` | R | Detailed status of one node: CPU model and count, load average, memory, swap, root filesystem, kernel and Proxmox version, uptime. |
| `pve_node_rrd` | R | CPU, memory, load, network and disk metrics of a node over a timeframe (hour, day, week, month, year). |
| `pve_node_services` | R | System services of a node (pveproxy, pvedaemon, pve-cluster, corosync, sshd, chrony, ...) with their state. |
| `pve_node_service_action` | W | Start, stop, restart or reload a system service of a node. |
| `pve_node_syslog` | R | Systemd journal lines of a node. |
| `pve_node_disks` | R | Physical disks of a node with model, serial, size, type (ssd, hdd, nvme), usage and SMART health. |
| `pve_node_apt_updates` | R | Packages with an available update on a node: name, installed version, new version and priority. |
| `pve_node_power` | D | Reboot or shut down a whole node. |

### Parameters

**`pve_node_list`**

- None besides `host`.

**`pve_node_status`**

- `node` (optional): Node name. Optional when the host has exactly one node.

**`pve_node_rrd`**

- `node` (optional): Node name. Optional when the host has exactly one node.
- `timeframe` (required): Time window of the metrics: hour, day, week, month or year
- `cf` (optional): Consolidation function, default AVERAGE

**`pve_node_services`**

- `node` (optional): Node name. Optional when the host has exactly one node.

**`pve_node_service_action`**

- `node` (optional): Node name. Optional when the host has exactly one node.
- `service` (required): Service id from pve_node_services, for example "pveproxy" or "chrony"
- `action` (required): start, stop, restart, or reload (re-read the config without restart, if supported)
- `wait` (optional): Wait for the Proxmox task to finish, default true

**`pve_node_syslog`**

- `node` (optional): Node name. Optional when the host has exactly one node.
- `since` (optional): Unix epoch seconds or an ISO 8601 timestamp such as 2026-01-31T12:00:00Z
- `until` (optional): Unix epoch seconds or an ISO 8601 timestamp such as 2026-01-31T12:00:00Z
- `limit` (optional): Maximum number of lines, default 100
- `unit` (optional): Only messages of this systemd unit (needs a recent Proxmox version)

**`pve_node_disks`**

- `node` (optional): Node name. Optional when the host has exactly one node.
- `partitions` (optional): Also list partitions
- `smartDisk` (optional): Device such as /dev/sda: return SMART data of this disk instead of the list
- `healthOnly` (optional): With smartDisk: only the health status

**`pve_node_apt_updates`**

- `node` (optional): Node name. Optional when the host has exactly one node.

**`pve_node_power`**

- `node` (required): Proxmox node name, for example "pve1"
- `command` (required): reboot: restart the node. shutdown: power the node off

## Network

Node network interfaces with staged changes that are applied explicitly.

| Tool | Access | Description |
|---|---|---|
| `pve_network_list` | R | Network interfaces of a node: bridges, bonds, VLANs, physical NICs with addresses, gateway, bridge ports, bond slaves and whether they are active. |
| `pve_network_set` | W | Stage a node network interface. |
| `pve_network_delete` | W | Stage the removal of a node network interface. |
| `pve_network_apply` | D | Apply all staged network changes of a node (ifreload). |
| `pve_network_revert` | W | Discard all staged, not yet applied network changes of a node. |

### Parameters

**`pve_network_list`**

- `node` (optional): Node name. Optional when the host has exactly one node.
- `type` (optional): Only interfaces of this type

**`pve_network_set`**

- `node` (optional): Node name. Optional when the host has exactly one node.
- `iface` (required): Interface name, for example "vmbr1", "bond0" or "eno1.100"
- `update` (optional): true: change an existing interface instead of creating
- `type` (optional): Interface type, required when creating
- `address` (optional): IPv4 address, use with netmask
- `netmask` (optional): IPv4 netmask, for example 255.255.255.0
- `cidr` (optional): IPv4 address with prefix, for example 192.0.2.10/24
- `cidr6` (optional): IPv6 address with prefix
- `gateway` (optional): IPv4 default gateway, for example 192.0.2.1
- `gateway6` (optional): IPv6 default gateway address
- `autostart` (optional): Bring the interface up on boot
- `bridge_ports` (optional): Bridge ports, space separated
- `bridge_vlan_aware` (optional): Make the bridge VLAN aware, so guest NICs can carry VLAN tags
- `bond-primary` (optional): Primary slave of an active-backup bond
- `bond_mode` (optional): Bond mode, for example active-backup, or 802.3ad for LACP
- `slaves` (optional): Bond slave interfaces, space separated
- `vlan-id` (optional): VLAN tag, 1 to 4094
- `vlan-raw-device` (optional): Parent interface of a VLAN
- `mtu` (optional): MTU in bytes, 68 to 65535
- `comments` (optional): Comment stored with the interface
- `extra` (optional): Further Proxmox network options by name
- `delete` (optional): update only: settings to remove, for example ["gateway", "comments"]

**`pve_network_delete`**

- `node` (optional): Node name. Optional when the host has exactly one node.
- `iface` (required): Interface name, for example "vmbr1", "bond0" or "eno1.100"

**`pve_network_apply`**

- `node` (required): Proxmox node name, for example "pve1"
- `wait` (optional): Wait for the Proxmox task to finish, default true

**`pve_network_revert`**

- `node` (optional): Node name. Optional when the host has exactly one node.

## Guests

Create, inspect, configure, power, move and delete VMs and containers.

| Tool | Access | Description |
|---|---|---|
| `pve_guest_list` | R | List QEMU VMs and LXC containers of the whole cluster with status and usage. |
| `pve_guest_status` | R | Current runtime status of one VM or container: state, uptime, CPU, memory, disk, network counters, HA state. |
| `pve_guest_config` | R | Configuration of a VM or container (cores, memory, disks, network, cloud-init, tags, ...). |
| `pve_guest_rrd` | R | CPU, memory, disk and network metrics of a guest over a timeframe (hour, day, week, month, year). |
| `pve_guest_power` | W | Change the power state of a VM or container. |
| `pve_guest_update_config` | W | Change the configuration of a VM or container. |
| `pve_guest_resize_disk` | W | Grow a disk of a VM (scsi0, virtio0, sata0, ide0) or container (rootfs, mp0). |
| `pve_guest_move_disk` | W | Move a disk (VM: scsi0, virtio0, ...) or volume (container: rootfs, mp0) to another storage. |
| `pve_guest_migrate` | W | Migrate a guest to another cluster node. |
| `pve_guest_clone` | W | Clone a VM or container (or a template) to a new VMID. |
| `pve_guest_template` | W | Convert a stopped VM or container into a template. |
| `pve_guest_delete` | D | Permanently delete a stopped VM or container with its disks. |
| `pve_vm_create` | W | Create a QEMU VM. |
| `pve_lxc_create` | W | Create an LXC container from a template. |
| `pve_vm_agent_info` | R | Query the QEMU guest agent of a running VM: info (agent version and supported commands), get-osinfo, network-get-interfaces (IPs and MACs), get-fsinfo, get-users, get-time, get-host-name. |
| `pve_vm_agent_exec` | D | Run a command inside a running VM through the QEMU guest agent and return exitcode, stdout and stderr. |
| `pve_vm_cloudinit` | R | Cloud-init state of a VM: the pending list shows current and pending values of the cloud-init options (changes apply after the cloud-init drive is regenerated, usually on the next start). |

### Parameters

**`pve_guest_list`**

- `node` (optional): Only guests on this node
- `type` (optional): Guest type: "qemu" for virtual machines, "lxc" for containers
- `status` (optional): Only guests in this state: running, stopped or paused
- `pool` (optional): Only members of this resource pool
- `tag` (optional): Only guests carrying this tag (case insensitive)
- `template` (optional): true: only templates, false: hide templates

**`pve_guest_status`**

- `vmid` (required): VMID of the VM or container (integer, 100 to 999999999)
- `node` (optional): Node the guest runs on. Optional, found from the VMID when omitted.
- `type` (optional): qemu (VM) or lxc (container). Optional, found from the VMID.

**`pve_guest_config`**

- `vmid` (required): VMID of the VM or container (integer, 100 to 999999999)
- `node` (optional): Node the guest runs on. Optional, found from the VMID when omitted.
- `type` (optional): qemu (VM) or lxc (container). Optional, found from the VMID.
- `pending` (optional): Return the pending changes list instead of the config
- `current` (optional): Show running values instead of pending ones

**`pve_guest_rrd`**

- `vmid` (required): VMID of the VM or container (integer, 100 to 999999999)
- `node` (optional): Node the guest runs on. Optional, found from the VMID when omitted.
- `type` (optional): qemu (VM) or lxc (container). Optional, found from the VMID.
- `timeframe` (required): Time window of the metrics: hour, day, week, month or year
- `cf` (optional): Consolidation function, default AVERAGE

**`pve_guest_power`**

- `vmid` (required): VMID of the VM or container (integer, 100 to 999999999)
- `node` (optional): Node the guest runs on. Optional, found from the VMID when omitted.
- `type` (optional): qemu (VM) or lxc (container). Optional, found from the VMID.
- `action` (required): start, shutdown (clean, via ACPI or container init), reboot, suspend, resume, stop (hard power off, needs force: true), or reset (hard, VMs only, needs force: true)
- `force` (optional): Required for stop and reset
- `timeout` (optional): Seconds, for shutdown and reboot
- `forceStop` (optional): shutdown only: hard stop when the timeout expires
- `wait` (optional): Wait for the Proxmox task to finish, default true

**`pve_guest_update_config`**

- `vmid` (required): VMID of the VM or container (integer, 100 to 999999999)
- `node` (optional): Node the guest runs on. Optional, found from the VMID when omitted.
- `type` (optional): qemu (VM) or lxc (container). Optional, found from the VMID.
- `set` (optional): Keys to set
- `delete` (optional): Keys to delete. Deleting a disk key (scsi0, unused0, rootfs, mp0, ...) asks first
- `revert` (optional): Pending keys to revert
- `digest` (optional): Config digest for optimistic locking
- `wait` (optional): Wait for the Proxmox task to finish, default true

**`pve_guest_resize_disk`**

- `vmid` (required): VMID of the VM or container (integer, 100 to 999999999)
- `node` (optional): Node the guest runs on. Optional, found from the VMID when omitted.
- `type` (optional): qemu (VM) or lxc (container). Optional, found from the VMID.
- `disk` (required): Disk key such as scsi0, virtio0, rootfs or mp0
- `size` (required): "+10G" to grow by 10 GiB, "50G" to grow to 50 GiB
- `wait` (optional): Wait for the Proxmox task to finish, default true

**`pve_guest_move_disk`**

- `vmid` (required): VMID of the VM or container (integer, 100 to 999999999)
- `node` (optional): Node the guest runs on. Optional, found from the VMID when omitted.
- `type` (optional): qemu (VM) or lxc (container). Optional, found from the VMID.
- `disk` (required): Disk key such as scsi0, rootfs or mp0
- `storage` (required): Target storage id
- `deleteSource` (optional): Delete the source volume after copying
- `format` (optional): VM only: target format
- `wait` (optional): Wait for the Proxmox task to finish, default true

**`pve_guest_migrate`**

- `vmid` (required): VMID of the VM or container (integer, 100 to 999999999)
- `node` (optional): Node the guest runs on. Optional, found from the VMID when omitted.
- `type` (optional): qemu (VM) or lxc (container). Optional, found from the VMID.
- `target` (required): Target node
- `online` (optional): VM only: live migration of a running VM
- `withLocalDisks` (optional): VM only: also migrate local disks
- `targetStorage` (optional): Storage on the target node
- `restart` (optional): Container only: restart migration of a running container
- `timeout` (optional): Container only: shutdown timeout in seconds
- `wait` (optional): Wait for the Proxmox task to finish, default true

**`pve_guest_clone`**

- `vmid` (required): VMID of the VM or container (integer, 100 to 999999999)
- `node` (optional): Node the guest runs on. Optional, found from the VMID when omitted.
- `type` (optional): qemu (VM) or lxc (container). Optional, found from the VMID.
- `newid` (optional): VMID of the clone, default: next free VMID
- `name` (optional): VM name or container hostname of the clone
- `full` (optional): Full clone with copied disks. Without it, a template makes a linked clone
- `target` (optional): Node for the clone, default: the source node
- `storage` (optional): Target storage for a full clone
- `pool` (optional): Resource pool to add the clone to
- `description` (optional): Description of the clone
- `snapname` (optional): Clone from this snapshot
- `wait` (optional): Wait for the Proxmox task to finish, default true

**`pve_guest_template`**

- `vmid` (required): VMID of the VM or container (integer, 100 to 999999999)
- `node` (optional): Node the guest runs on. Optional, found from the VMID when omitted.
- `type` (optional): qemu (VM) or lxc (container). Optional, found from the VMID.
- `wait` (optional): Wait for the Proxmox task to finish, default true

**`pve_guest_delete`**

- `vmid` (required): VMID of the VM or container (integer, 100 to 999999999)
- `node` (optional): Node the guest runs on. Optional, found from the VMID when omitted.
- `type` (optional): qemu (VM) or lxc (container). Optional, found from the VMID.
- `purge` (optional): Also remove from backup jobs, replication and HA
- `destroyUnreferencedDisks` (optional): Also delete unreferenced disks with this VMID on all storages
- `wait` (optional): Wait for the Proxmox task to finish, default true

**`pve_vm_create`**

- `node` (optional): Target node, optional on a single node host
- `vmid` (optional): New VMID, default: next free VMID
- `name` (optional): VM name, up to 63 characters
- `memory` (optional): RAM in MiB
- `cores` (optional): CPU cores per socket
- `sockets` (optional): CPU sockets, vCPUs are sockets times cores
- `cpu` (optional): CPU type, for example "x86-64-v2-AES" or "host"
- `ostype` (optional): Guest OS type, for example "l26" (Linux) or "win11"
- `machine` (optional): Machine type, for example "q35"
- `bios` (optional): Firmware: seabios (BIOS) or ovmf (UEFI)
- `scsihw` (optional): SCSI controller, for example "virtio-scsi-single"
- `boot` (optional): Boot order, for example "order=scsi0;ide2"
- `agent` (optional): QEMU guest agent: true or a string like "enabled=1,fstrim_cloned_disks=1"
- `net0` (optional): For example "virtio,bridge=vmbr0"
- `disks` (optional): Drive key to volume spec, e.g. {"scsi0": "local-lvm:32"}
- `iso` (optional): ISO volume id, e.g. "local:iso/debian.iso", attached as ide2 CD-ROM
- `ciuser` (optional): Cloud-init user name
- `cipassword` (optional): Cloud-init password, stored by Proxmox
- `sshkeys` (optional): Public keys, one per line, plain text
- `ipconfig0` (optional): Cloud-init network config for net0, for example "ip=dhcp"
- `nameserver` (optional): DNS server for cloud-init
- `searchdomain` (optional): DNS search domain for cloud-init
- `tags` (optional): Tags for the VM
- `pool` (optional): Resource pool to add the VM to
- `description` (optional): Description of the VM, free text
- `onboot` (optional): Start the VM when the node boots
- `start` (optional): Start the VM after creation
- `extra` (optional): Any other Proxmox option
- `wait` (optional): Wait for the Proxmox task to finish, default true

**`pve_lxc_create`**

- `node` (optional): Target node, optional on a single node host
- `vmid` (optional): New VMID, default: next free VMID
- `ostemplate` (required): Template volume id, e.g. local:vztmpl/<file>
- `hostname` (optional): Container hostname, up to 63 characters
- `rootfs` (optional): Root volume, e.g. "local-lvm:8" (size in GiB)
- `storage` (optional): Root disk storage, together with diskSizeGB
- `diskSizeGB` (optional): Root disk size in GiB, together with storage
- `memory` (optional): RAM in MiB
- `swap` (optional): Swap in MiB
- `cores` (optional): CPU cores for the container
- `net0` (optional): For example "name=eth0,bridge=vmbr0,ip=dhcp"
- `password` (optional): Root password
- `sshPublicKeys` (optional): Public keys for root, one per line
- `unprivileged` (optional): Default true
- `features` (optional): For example "nesting=1" or "keyctl=1,nesting=1"
- `onboot` (optional): Start the container when the node boots
- `start` (optional): Start the container after creation
- `nameserver` (optional): DNS server for the container
- `searchdomain` (optional): DNS search domain for the container
- `tags` (optional): Tags for the container
- `pool` (optional): Resource pool to add the container to
- `description` (optional): Description of the container, free text
- `extra` (optional): Any other Proxmox option
- `wait` (optional): Wait for the Proxmox task to finish, default true

**`pve_vm_agent_info`**

- `vmid` (required): VMID of the VM or container (integer, 100 to 999999999)
- `node` (optional): Node the guest runs on. Optional, found from the VMID when omitted.
- `type` (optional): qemu (VM) or lxc (container). Optional, found from the VMID.
- `command` (required): Agent command: info, get-osinfo, network-get-interfaces, get-fsinfo, get-users, get-time, or get-host-name

**`pve_vm_agent_exec`**

- `vmid` (required): VMID of the VM or container (integer, 100 to 999999999)
- `node` (optional): Node the guest runs on. Optional, found from the VMID when omitted.
- `type` (optional): qemu (VM) or lxc (container). Optional, found from the VMID.
- `command` (required): Program followed by its arguments
- `input` (optional): Data for stdin
- `timeoutSeconds` (optional): How long to wait for the command, default 30, capped by the server task limit

**`pve_vm_cloudinit`**

- `vmid` (required): VMID of the VM or container (integer, 100 to 999999999)
- `node` (optional): Node the guest runs on. Optional, found from the VMID when omitted.
- `type` (optional): qemu (VM) or lxc (container). Optional, found from the VMID.
- `dump` (optional): Also return this rendered document

## Snapshots

List, create, roll back and delete guest snapshots.

| Tool | Access | Description |
|---|---|---|
| `pve_snapshot_list` | R | Snapshots of a VM or container with name, description, time, parent and whether RAM state is included. |
| `pve_snapshot_create` | W | Create a snapshot of a VM or container. |
| `pve_snapshot_rollback` | D | Roll a guest back to a snapshot. |
| `pve_snapshot_delete` | D | Delete a snapshot. |

### Parameters

**`pve_snapshot_list`**

- `vmid` (required): VMID of the VM or container (integer, 100 to 999999999)
- `node` (optional): Node the guest runs on. Optional, found from the VMID when omitted.
- `type` (optional): qemu (VM) or lxc (container). Optional, found from the VMID.

**`pve_snapshot_create`**

- `vmid` (required): VMID of the VM or container (integer, 100 to 999999999)
- `node` (optional): Node the guest runs on. Optional, found from the VMID when omitted.
- `type` (optional): qemu (VM) or lxc (container). Optional, found from the VMID.
- `snapname` (required): Snapshot name: letters, digits, "-" and "_", starting with a letter
- `description` (optional): Free text description of the snapshot
- `vmstate` (optional): VM only: include RAM state
- `wait` (optional): Wait for the Proxmox task to finish, default true

**`pve_snapshot_rollback`**

- `vmid` (required): VMID of the VM or container (integer, 100 to 999999999)
- `node` (optional): Node the guest runs on. Optional, found from the VMID when omitted.
- `type` (optional): qemu (VM) or lxc (container). Optional, found from the VMID.
- `snapname` (required): Snapshot name: letters, digits, "-" and "_", starting with a letter
- `start` (optional): Start the guest after the rollback
- `wait` (optional): Wait for the Proxmox task to finish, default true

**`pve_snapshot_delete`**

- `vmid` (required): VMID of the VM or container (integer, 100 to 999999999)
- `node` (optional): Node the guest runs on. Optional, found from the VMID when omitted.
- `type` (optional): qemu (VM) or lxc (container). Optional, found from the VMID.
- `snapname` (required): Snapshot name: letters, digits, "-" and "_", starting with a letter
- `force` (optional): Remove the snapshot from the config even if deleting its disk data fails
- `wait` (optional): Wait for the Proxmox task to finish, default true

## Storage

Storage definitions, volumes, ISO images and container templates.

| Tool | Access | Description |
|---|---|---|
| `pve_storage_list` | R | Storages with type, allowed content types and usage. |
| `pve_storage_content` | R | Volumes on a storage: disk images, ISO files, container templates, backups, snippets. |
| `pve_storage_download_url` | W | Let the Proxmox node download an ISO image, container template or disk image (content import) from an http or https URL into a storage that allows that content type. |
| `pve_storage_templates` | R | Container templates that Proxmox offers for download (appliance list). |
| `pve_storage_template_download` | W | Download a container template from the Proxmox appliance list to a storage with content type vztmpl (usually "local"). |
| `pve_storage_volume_delete` | D | Permanently delete a volume (disk image, ISO, template, backup, snippet) from a storage. |
| `pve_storage_define` | W | Create a storage definition (update: false, default) or change an existing one (update: true). |
| `pve_storage_remove` | D | Remove a storage definition from the cluster. |

### Parameters

**`pve_storage_list`**

- `node` (optional): Only this node, with exact capacity numbers
- `content` (optional): Only storages allowing this content type
- `enabled` (optional): true: only enabled storages, false: only disabled ones

**`pve_storage_content`**

- `storage` (required): Storage id, for example "local" or "local-lvm"
- `node` (optional): Node. Optional when the storage exists on exactly one node.
- `content` (optional): Only volumes of this content type: images, rootdir, vztmpl, iso, backup, snippets or import
- `vmid` (optional): Only volumes of this guest

**`pve_storage_download_url`**

- `storage` (required): Storage id, for example "local" or "local-lvm"
- `node` (optional): Node. Optional when the storage exists on exactly one node.
- `url` (required): HTTP or HTTPS URL of the file to download
- `filename` (required): File name to store the download as, without a path
- `content` (required): Content type of the download: iso, vztmpl (container template) or import
- `checksum` (optional): Expected checksum of the download, see checksumAlgorithm
- `checksumAlgorithm` (optional): Required together with checksum
- `verifyCertificates` (optional): Default true
- `wait` (optional): Wait for the Proxmox task to finish, default true

**`pve_storage_templates`**

- `node` (optional): Node, optional on a single node host
- `section` (optional): For example "system" or "turnkeylinux"
- `os` (optional): For example "debian", "ubuntu", "alpine"
- `search` (optional): Case insensitive text
- `limit` (optional): Default 50

**`pve_storage_template_download`**

- `storage` (required): Storage id, for example "local" or "local-lvm"
- `node` (optional): Node. Optional when the storage exists on exactly one node.
- `template` (required): Template file name from pve_storage_templates
- `wait` (optional): Wait for the Proxmox task to finish, default true

**`pve_storage_volume_delete`**

- `storage` (required): Storage id, for example "local" or "local-lvm"
- `node` (optional): Node. Optional when the storage exists on exactly one node.
- `volume` (required): Volume id as listed by pve_storage_content
- `wait` (optional): Wait for the Proxmox task to finish, default true

**`pve_storage_define`**

- `storage` (required): Storage id, for example "local" or "local-lvm"
- `type` (optional): Required when creating, for example "dir" or "nfs"
- `update` (optional): true: change an existing storage
- `content` (optional): Content types the storage holds: images, rootdir, vztmpl, iso, backup, snippets or import
- `nodes` (optional): Restrict the storage to these nodes
- `disable` (optional): true: disable the storage, so Proxmox does not use it
- `options` (optional): Type specific options
- `delete` (optional): Update only: option keys to remove

**`pve_storage_remove`**

- `storage` (required): Storage id, for example "local" or "local-lvm"

## Backup

Backups, restores and scheduled backup jobs.

| Tool | Access | Description |
|---|---|---|
| `pve_backup_list` | R | Backups on all storages that allow backup content, or on one storage. |
| `pve_backup_create` | W | Run a vzdump backup now for one or more guests (vmids). |
| `pve_backup_restore` | D | Restore a backup (volid from pve_backup_list) to a VMID. |
| `pve_backup_jobs_list` | R | Scheduled backup jobs of the cluster: id, schedule, storage, mode, selected guests (vmid, all, pool, exclude), retention (prune-backups), enabled. |
| `pve_backup_job_set` | W | Create a scheduled backup job (no id) or change one (id from pve_backup_jobs_list). |
| `pve_backup_job_delete` | D | Delete a scheduled backup job. |

### Parameters

**`pve_backup_list`**

- `storage` (optional): Only this storage, default: all backup storages
- `node` (optional): Only read storages through this node
- `vmid` (optional): VMID of the VM or container (integer, 100 to 999999999)
- `limit` (optional): Default 100

**`pve_backup_create`**

- `vmids` (required): VMIDs of the guests to back up, 1 to 100 entries
- `storage` (optional): Storage id, for example "local" or "local-lvm"
- `mode` (optional): snapshot: live backup (default), suspend: short pause, stop: shut the guest down for the backup
- `compress` (optional): Compression, default zstd. "0" disables it.
- `notes` (optional): Notes template
- `protected` (optional): Protect the backup from pruning and deletion
- `remove` (optional): Prune old backups per the retention settings
- `wait` (optional): Wait for the Proxmox task to finish, default true

**`pve_backup_restore`**

- `archive` (required): Backup volume id as listed by pve_backup_list
- `vmid` (optional): Target VMID, default: next free VMID
- `type` (optional): Only needed when the volid does not show the type
- `node` (optional): Node to restore on
- `storage` (optional): Target storage for the restored disks
- `force` (optional): Overwrite an existing guest with this VMID
- `unique` (optional): Generate new unique properties such as MAC addresses
- `start` (optional): Start the restored guest after the restore
- `pool` (optional): Resource pool to add the restored guest to
- `wait` (optional): Wait for the Proxmox task to finish, default true

**`pve_backup_jobs_list`**

- None besides `host`.

**`pve_backup_job_set`**

- `id` (optional): Existing job id to update, omit to create
- `schedule` (optional): For example "daily" or "sat 03:00"
- `storage` (optional): Storage id, for example "local" or "local-lvm"
- `vmid` (optional): Guests to back up
- `all` (optional): Back up all guests
- `exclude` (optional): With all: guests to skip
- `node` (optional): Only guests on this node
- `pool` (optional): Back up the guests of this pool
- `mode` (optional): snapshot: live backup (default), suspend: short pause, stop: shut the guest down for the backup
- `compress` (optional): Compression, default zstd. "0" disables it.
- `enabled` (optional): Whether the job runs on its schedule
- `mailto` (optional): Comma separated e-mail addresses
- `notesTemplate` (optional): Notes template, e.g. "{{guestname}}"
- `pruneBackups` (optional): Retention, e.g. "keep-last=3,keep-weekly=4"
- `comment` (optional): Free text comment for the job
- `delete` (optional): Update only: keys to remove
- `extra` (optional): Any other job option

**`pve_backup_job_delete`**

- `id` (required): Job id from pve_backup_jobs_list

## Tasks

Inspect, wait for and stop Proxmox tasks.

| Tool | Access | Description |
|---|---|---|
| `pve_task_list` | R | List recent Proxmox tasks (start, stop, backup, migrate, ...), newest first. |
| `pve_task_status` | R | Status of one task by UPID: running or stopped, exit status (OK means success), type, user, start time. |
| `pve_task_log` | R | Read the log of a task by UPID. |
| `pve_task_wait` | R | Wait until a task finishes and return its result: status, exit status, ok flag and the last log lines. |
| `pve_task_stop` | W | Stop a running task by UPID, for example a stuck backup or migration. |

### Parameters

**`pve_task_list`**

- `node` (optional): Only this node, default all online nodes
- `vmid` (optional): Only tasks of this guest
- `typefilter` (optional): Only this task type, for example vzdump
- `statusfilter` (optional): Only these final states: ok, warning, error, unknown (comma separated)
- `errors` (optional): Only tasks that ended with an error
- `limit` (optional): Maximum entries, default 50

**`pve_task_status`**

- `upid` (required): Task id (UPID), for example "UPID:pve1:000A1B2C:0123ABCD:65F0A1B2:qmstart:100:root@pam:"

**`pve_task_log`**

- `upid` (required): Task id (UPID), for example "UPID:pve1:000A1B2C:0123ABCD:65F0A1B2:qmstart:100:root@pam:"
- `start` (optional): First line to return, default 0
- `limit` (optional): Maximum number of lines, default 100

**`pve_task_wait`**

- `upid` (required): Task id (UPID), for example "UPID:pve1:000A1B2C:0123ABCD:65F0A1B2:qmstart:100:root@pam:"
- `timeoutSeconds` (optional): How long to wait, capped by the configured limit (taskWaitSeconds)
- `logLines` (optional): Number of trailing log lines to include, default 20

**`pve_task_stop`**

- `upid` (required): Task id (UPID), for example "UPID:pve1:000A1B2C:0123ABCD:65F0A1B2:qmstart:100:root@pam:"

## Access

Users, groups, roles, ACLs, realms, API tokens and effective permissions.

| Tool | Access | Description |
|---|---|---|
| `pve_access_list` | R | Read the access configuration: kind users, groups, roles (with privileges), acl (path, user or group or token, role, propagate), realms (authentication domains) or tokens. |
| `pve_access_permissions` | R | Effective permissions as privileges per path. |

### Parameters

**`pve_access_list`**

- `kind` (required): Entry type to read: users, groups, roles, acl, realms or tokens
- `userid` (optional): Required for kind tokens
- `full` (optional): Return all fields instead of the compact set

**`pve_access_permissions`**

- `path` (optional): Access control path such as /, /vms/100 or /pool/web
- `userid` (optional): User id or full token id. Omit for the permissions of this server token

## Firewall

Firewall rules and options at cluster, node and guest level.

| Tool | Access | Description |
|---|---|---|
| `pve_firewall_rules` | R | Firewall rules at cluster, node or guest level, in evaluation order with their position. |
| `pve_firewall_rule_add` | W | Add a firewall rule at cluster, node or guest level. |
| `pve_firewall_rule_update` | W | Change the rule at a position. |
| `pve_firewall_rule_delete` | D | Delete the rule at a position. |
| `pve_firewall_options` | R | Firewall options at cluster, node or guest level: enable flag, input/output/forward policies, log levels and similar settings, plus the digest for pve_firewall_options_set. |
| `pve_firewall_options_set` | W | Change firewall options at cluster, node or guest level. |

### Parameters

**`pve_firewall_rules`**

- `level` (required): Firewall level: cluster (datacenter wide), node (needs node unless the host has one node) or guest (needs vmid)
- `node` (optional): level node: the node. level guest: optional hint, found from the VMID otherwise.
- `vmid` (optional): Required for level guest
- `guestType` (optional): level guest only: qemu or lxc, found from the VMID

**`pve_firewall_rule_add`**

- `level` (required): Firewall level: cluster (datacenter wide), node (needs node unless the host has one node) or guest (needs vmid)
- `node` (optional): level node: the node. level guest: optional hint, found from the VMID otherwise.
- `vmid` (optional): Required for level guest
- `guestType` (optional): level guest only: qemu or lxc, found from the VMID
- `type` (required): Rule direction: in, out, forward, or group (refers to a security group)
- `action` (required): ACCEPT, DROP, REJECT, or the name of a security group (type group)
- `enable` (optional): Whether the rule is active, default true on add
- `source` (optional): Source address, CIDR, range, alias or +ipset, for example 192.0.2.0/24
- `dest` (optional): Destination address, same forms as source
- `proto` (optional): Protocol name or number, for example tcp, udp, icmp
- `dport` (optional): Destination port, name, number, range or list
- `sport` (optional): Source port, same forms as dport
- `iface` (optional): Interface name, for guests the net key such as net0
- `macro` (optional): Predefined macro such as SSH, HTTPS or Ping
- `comment` (optional): Free text comment for the rule
- `log` (optional): Log level for this rule
- `icmp-type` (optional): Only with proto icmp or icmpv6
- `pos` (optional): Insert at this position instead of appending
- `digest` (optional): Digest from the last read. Proxmox refuses the change if the config changed since

**`pve_firewall_rule_update`**

- `level` (required): Firewall level: cluster (datacenter wide), node (needs node unless the host has one node) or guest (needs vmid)
- `node` (optional): level node: the node. level guest: optional hint, found from the VMID otherwise.
- `vmid` (optional): Required for level guest
- `guestType` (optional): level guest only: qemu or lxc, found from the VMID
- `pos` (required): Rule position, starting at 0
- `type` (optional): Rule direction: in, out, forward, or group (refers to a security group)
- `action` (optional): ACCEPT, DROP, REJECT, or the name of a security group (type group)
- `enable` (optional): Whether the rule is active, default true on add
- `source` (optional): Source address, CIDR, range, alias or +ipset, for example 192.0.2.0/24
- `dest` (optional): Destination address, same forms as source
- `proto` (optional): Protocol name or number, for example tcp, udp, icmp
- `dport` (optional): Destination port, name, number, range or list
- `sport` (optional): Source port, same forms as dport
- `iface` (optional): Interface name, for guests the net key such as net0
- `macro` (optional): Predefined macro such as SSH, HTTPS or Ping
- `comment` (optional): Free text comment for the rule
- `log` (optional): Log level for this rule
- `icmp-type` (optional): Only with proto icmp or icmpv6
- `moveto` (optional): Move the rule to this position (no other change)
- `delete` (optional): Fields to remove from the rule
- `digest` (optional): Digest from the last read. Proxmox refuses the change if the config changed since

**`pve_firewall_rule_delete`**

- `level` (required): Firewall level: cluster (datacenter wide), node (needs node unless the host has one node) or guest (needs vmid)
- `node` (optional): level node: the node. level guest: optional hint, found from the VMID otherwise.
- `vmid` (optional): Required for level guest
- `guestType` (optional): level guest only: qemu or lxc, found from the VMID
- `pos` (required): Rule position, starting at 0
- `digest` (optional): Digest from the last read. Proxmox refuses the change if the config changed since

**`pve_firewall_options`**

- `level` (required): Firewall level: cluster (datacenter wide), node (needs node unless the host has one node) or guest (needs vmid)
- `node` (optional): level node: the node. level guest: optional hint, found from the VMID otherwise.
- `vmid` (optional): Required for level guest
- `guestType` (optional): level guest only: qemu or lxc, found from the VMID

**`pve_firewall_options_set`**

- `level` (required): Firewall level: cluster (datacenter wide), node (needs node unless the host has one node) or guest (needs vmid)
- `node` (optional): level node: the node. level guest: optional hint, found from the VMID otherwise.
- `vmid` (optional): Required for level guest
- `guestType` (optional): level guest only: qemu or lxc, found from the VMID
- `options` (optional): Option name to value, for example {"enable": true, "policy_in": "DROP"}
- `delete` (optional): Options to reset to their default
- `digest` (optional): Digest from the last read. Proxmox refuses the change if the config changed since

## Pools

Resource pools and their members.

| Tool | Access | Description |
|---|---|---|
| `pve_pool_list` | R | Resource pools with comment. |
| `pve_pool_set` | W | Create a pool when poolid does not exist yet, otherwise change it. |
| `pve_pool_delete` | D | Delete a pool. |

### Parameters

**`pve_pool_list`**

- `poolid` (optional): Pool id, for example "web". Nested pools use "parent/child" on Proxmox VE 9.
- `type` (optional): With poolid: only these members

**`pve_pool_set`**

- `poolid` (required): Pool id, for example "web". Nested pools use "parent/child" on Proxmox VE 9.
- `comment` (optional): Description of the pool, set on create or change
- `vms` (optional): VMIDs to add (or remove)
- `storage` (optional): Storage ids to add (or remove)
- `remove` (optional): Remove the listed vms and storage instead of adding
- `allowMove` (optional): Allow taking guests from another pool

**`pve_pool_delete`**

- `poolid` (required): Pool id, for example "web". Nested pools use "parent/child" on Proxmox VE 9.

## High availability

HA manager status and HA resources.

| Tool | Access | Description |
|---|---|---|
| `pve_ha_status` | R | High availability information. |
| `pve_ha_resource_set` | W | Put a VM or container under HA management, or change its HA settings. |
| `pve_ha_resource_remove` | D | Remove a VM or container from HA management, by sid (vm:100, ct:100) or vmid. |

### Parameters

**`pve_ha_status`**

- `what` (required): status, resources, groups or rules

**`pve_ha_resource_set`**

- `sid` (optional): HA resource id: vm:<vmid> for a VM, ct:<vmid> for a container, for example "vm:100"
- `vmid` (optional): Alternative to sid: the guest VMID, the sid is derived from the guest type
- `type` (optional): With vmid: qemu or lxc. Optional, looked up from the VMID when omitted.
- `update` (optional): true: change an existing HA resource
- `state` (optional): started (default), stopped (guest shut down and kept off), disabled (no recovery on node failure) or ignored (HA leaves it alone)
- `group` (optional): HA group id (deprecated on Proxmox VE 9)
- `max_restart` (optional): Restart attempts on the same node after a failed start, 0 to 10
- `max_relocate` (optional): Relocation attempts to other nodes after a failed start, 0 to 10
- `failback` (optional): Proxmox VE 9: migrate back to the preferred node
- `comment` (optional): Free text comment for the HA resource
- `delete` (optional): update only: settings to remove, for example ["group", "comment"]
- `digest` (optional): update only: digest from pve_ha_status resources

**`pve_ha_resource_remove`**

- `sid` (optional): HA resource id: vm:<vmid> for a VM, ct:<vmid> for a container, for example "vm:100"
- `vmid` (optional): Alternative to sid: the guest VMID, the sid is derived from the guest type
- `type` (optional): With vmid: qemu or lxc. Optional, looked up from the VMID when omitted.
- `purge` (optional): Also remove the resource from HA rules

## Raw API

Escape hatch for any Proxmox API path without a dedicated tool.

| Tool | Access | Description |
|---|---|---|
| `pve_api_get` | R | GET any Proxmox API path (relative to /api2/json) for data no dedicated tool covers. |
| `pve_api_request` | W | POST, PUT or DELETE any Proxmox API path (relative to /api2/json) for changes no dedicated tool covers. |
| `pve_api_describe` | R | Look up the Proxmox API schema for a path: available methods with description, parameters (type, optional, enum, default), permissions and child paths. |

### Parameters

**`pve_api_get`**

- `path` (required): API path relative to /api2/json, starting with /, for example /nodes/pve1/qemu/100/status/current
- `params` (optional): Query or body parameters as an object. Booleans are sent as 1 and 0, arrays become repeated keys. Use pve_api_describe to see the parameters of a path.

**`pve_api_request`**

- `method` (required): HTTP method
- `path` (required): API path relative to /api2/json, starting with /, for example /nodes/pve1/qemu/100/status/current
- `params` (optional): Query or body parameters as an object. Booleans are sent as 1 and 0, arrays become repeated keys. Use pve_api_describe to see the parameters of a path.
- `wait` (optional): Wait for the Proxmox task when the response is a task id, default true

**`pve_api_describe`**

- `path` (required): API path with concrete values, or "/" for the top level
- `method` (optional): Only this method
