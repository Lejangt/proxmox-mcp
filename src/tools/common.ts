import { z } from 'zod';

/** Shared zod building blocks for tool inputs. Every schema carries a description for the agent. */

export const vmidSchema = z
  .number()
  .int()
  .min(100)
  .max(999999999)
  .describe('VMID of the VM or container (integer, 100 to 999999999)');

/** Proxmox node names are DNS labels: letters, digits and hyphens, no leading or trailing hyphen. */
export const nodeSchema = z
  .string()
  .regex(/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,62}[A-Za-z0-9])?$/, 'invalid Proxmox node name')
  .describe('Proxmox node name, for example "pve1"');

export const guestTypeSchema = z
  .enum(['qemu', 'lxc'])
  .describe('Guest type: "qemu" for virtual machines, "lxc" for containers');

/** Storage ids follow the pve-storage-id format. */
export const storageIdSchema = z
  .string()
  .regex(/^[a-z][a-z0-9_.-]*[a-z0-9]$/i, 'invalid storage id')
  .describe('Storage id, for example "local" or "local-lvm"');

export const waitSchema = z
  .boolean()
  .optional()
  .describe('Wait for the Proxmox task to finish, default true');

export const timeframeSchema = z
  .enum(['hour', 'day', 'week', 'month', 'year'])
  .describe('Time window of the metrics: hour, day, week, month or year');

export const configValueSchema = z
  .union([z.string(), z.number(), z.boolean()])
  .describe('Configuration value as string, number or boolean');

export const upidSchema = z
  .string()
  .min(1)
  .max(512)
  .describe(
    'Task id (UPID), for example "UPID:pve1:000A1B2C:0123ABCD:65F0A1B2:qmstart:100:root@pam:"',
  );
