import { describe, expect, it } from 'vitest';
import { backupTools, backupType } from '../src/tools/backup.js';
import { callTool, UPID } from './helpers/call-tool.js';
import { fakeClient, type FakeClient } from './helpers/fake-client.js';

const guests = [
  { type: 'qemu', vmid: 100, node: 'pve1' },
  { type: 'lxc', vmid: 101, node: 'pve1' },
  { type: 'qemu', vmid: 200, node: 'pve2' },
];

const run = (c: FakeClient, name: string, args: Record<string, unknown>) =>
  callTool(backupTools, name, args, c);
const last = (c: FakeClient) => c.calls[c.calls.length - 1];

describe('backup tools', () => {
  it('uses the contract names, categories and access levels', () => {
    expect(backupTools.map((t) => `${t.name}:${t.category}:${t.access}`)).toEqual([
      'pve_backup_list:backup:read',
      'pve_backup_create:backup:write',
      'pve_backup_restore:backup:destructive',
      'pve_backup_jobs_list:backup:read',
      'pve_backup_job_set:backup:write',
      'pve_backup_job_delete:backup:destructive',
    ]);
  });

  it('list reads backup storages once per shared storage, sorts newest first and filters by vmid', async () => {
    const c = fakeClient({
      'GET /cluster/resources': [
        { storage: 'nas', node: 'pve1', status: 'available', content: 'backup', shared: 1 },
        { storage: 'nas', node: 'pve2', status: 'available', content: 'backup', shared: 1 },
        { storage: 'local', node: 'pve1', status: 'available', content: 'iso,backup' },
        { storage: 'fast', node: 'pve1', status: 'available', content: 'images' },
        { storage: 'down', node: 'pve2', status: 'unknown', content: 'backup' },
      ],
      'GET /nodes/pve1/storage/nas/content': [
        {
          volid: 'nas:backup/vzdump-qemu-100-a.vma.zst',
          vmid: 100,
          ctime: 1700000000,
          size: 1,
          format: 'vma.zst',
        },
        {
          volid: 'nas:backup/vzdump-qemu-100-b.vma.zst',
          vmid: 100,
          ctime: 1700001000,
          size: 1,
          protected: 1,
        },
        { volid: 'nas:backup/vzdump-lxc-101-a.tar.zst', vmid: 101, ctime: 1700002000, size: 1 },
      ],
      'GET /nodes/pve1/storage/local/content': [],
    });
    const out = (await run(c, 'pve_backup_list', { vmid: 100 })) as {
      total: number;
      backups: Array<{ volid: string; ctime: string; protected: boolean }>;
    };
    const reads = c.calls.filter((x) => x.path.endsWith('/content'));
    expect(reads.map((r) => r.path).sort()).toEqual([
      '/nodes/pve1/storage/local/content',
      '/nodes/pve1/storage/nas/content',
    ]);
    expect(reads[0]?.params).toMatchObject({ content: 'backup', vmid: 100 });
    expect(out.backups.map((b) => b.volid)).toEqual([
      'nas:backup/vzdump-qemu-100-b.vma.zst',
      'nas:backup/vzdump-qemu-100-a.vma.zst',
    ]);
    expect(out.backups[0]).toMatchObject({ ctime: '2023-11-14T22:30:00.000Z', protected: true });
  });

  it('create groups the VMIDs by node and starts one vzdump per node', async () => {
    const c = fakeClient({
      'GET /cluster/resources': guests,
      'POST /nodes/pve1/vzdump': UPID,
      'POST /nodes/pve2/vzdump': UPID,
    });
    const out = (await run(c, 'pve_backup_create', {
      vmids: [100, 200, 101, 100],
      storage: 'nas',
      mode: 'snapshot',
      notes: '{{guestname}}',
      protected: true,
      wait: false,
    })) as { tasks: Array<{ node: string; vmids: number[] }> };
    const posts = c.calls.filter((x) => x.method === 'POST');
    expect(posts).toHaveLength(2);
    const byPath = Object.fromEntries(posts.map((p) => [p.path, p.params]));
    expect(byPath['/nodes/pve1/vzdump']).toMatchObject({
      vmid: '100,101',
      storage: 'nas',
      mode: 'snapshot',
      compress: 'zstd',
      'notes-template': '{{guestname}}',
      protected: true,
    });
    expect(byPath['/nodes/pve2/vzdump']).toMatchObject({ vmid: '200' });
    expect(out.tasks.map((t) => t.node).sort()).toEqual(['pve1', 'pve2']);
  });

  it('derives the guest type of a backup from the volume id', () => {
    expect(backupType('local:backup/vzdump-qemu-100-2024_01_01-00_00_00.vma.zst')).toBe('qemu');
    expect(backupType('local:backup/vzdump-lxc-101-2024_01_01-00_00_00.tar.zst')).toBe('lxc');
    expect(backupType('pbs:backup/vm/100/2024-01-01T00:00:00Z')).toBe('qemu');
    expect(backupType('pbs:backup/ct/101/2024-01-01T00:00:00Z')).toBe('lxc');
    expect(backupType('local:backup/mystery.bin')).toBeUndefined();
  });

  it('restores a VM backup through POST /qemu with archive', async () => {
    const c = fakeClient({
      'GET /cluster/resources': [
        { storage: 'nas', node: 'pve1', status: 'available', content: 'backup' },
      ],
      'POST /nodes/pve1/qemu': UPID,
    });
    const out = await run(c, 'pve_backup_restore', {
      archive: 'nas:backup/vzdump-qemu-100-2024_01_01-00_00_00.vma.zst',
      vmid: 300,
      storage: 'fast',
      force: true,
      unique: true,
      start: true,
      pool: 'p',
      wait: false,
    });
    expect(last(c)).toMatchObject({
      method: 'POST',
      path: '/nodes/pve1/qemu',
      params: {
        vmid: 300,
        archive: 'nas:backup/vzdump-qemu-100-2024_01_01-00_00_00.vma.zst',
        storage: 'fast',
        force: true,
        unique: true,
        start: true,
        pool: 'p',
      },
    });
    expect(out).toMatchObject({ type: 'qemu', vmid: 300, node: 'pve1' });
  });

  it('restores a container backup through POST /lxc with ostemplate and restore', async () => {
    const c = fakeClient({
      'GET /cluster/nextid': '310',
      'POST /nodes/pve2/lxc': UPID,
    });
    await run(c, 'pve_backup_restore', {
      archive: 'nas:backup/vzdump-lxc-101-2024_01_01-00_00_00.tar.zst',
      node: 'pve2',
      wait: false,
    });
    expect(last(c)).toMatchObject({
      method: 'POST',
      path: '/nodes/pve2/lxc',
      params: {
        vmid: 310,
        ostemplate: 'nas:backup/vzdump-lxc-101-2024_01_01-00_00_00.tar.zst',
        restore: true,
      },
    });
    expect(last(c)?.params).not.toHaveProperty('archive');
  });

  it('restore needs a type when the volume id does not show it', async () => {
    const c = fakeClient({});
    await expect(
      run(c, 'pve_backup_restore', { archive: 'nas:backup/mystery.bin', node: 'pve1' }),
    ).rejects.toThrow(/Pass type/);
  });

  it('lists jobs and creates, updates and deletes one', async () => {
    const c = fakeClient({
      'GET /cluster/backup': [{ id: 'backup-1' }],
      'POST /cluster/backup': null,
      'PUT /cluster/backup/backup-1': null,
      'DELETE /cluster/backup/backup-1': null,
    });
    expect(await run(c, 'pve_backup_jobs_list', {})).toEqual([{ id: 'backup-1' }]);

    await run(c, 'pve_backup_job_set', {
      schedule: 'sat 03:00',
      storage: 'nas',
      vmid: [100, 101],
      mode: 'snapshot',
      compress: 'zstd',
      enabled: true,
      notesTemplate: '{{guestname}}',
      pruneBackups: 'keep-last=3',
      extra: { bwlimit: 1000 },
    });
    expect(last(c)).toMatchObject({
      method: 'POST',
      path: '/cluster/backup',
      params: {
        schedule: 'sat 03:00',
        storage: 'nas',
        vmid: '100,101',
        mode: 'snapshot',
        enabled: true,
        'notes-template': '{{guestname}}',
        'prune-backups': 'keep-last=3',
        bwlimit: 1000,
      },
    });

    await run(c, 'pve_backup_job_set', { id: 'backup-1', enabled: false, delete: ['comment'] });
    expect(last(c)).toMatchObject({
      method: 'PUT',
      path: '/cluster/backup/backup-1',
      params: { enabled: false, delete: 'comment' },
    });

    await run(c, 'pve_backup_job_delete', { id: 'backup-1' });
    expect(last(c)).toMatchObject({ method: 'DELETE', path: '/cluster/backup/backup-1' });
  });

  it('rejects vmid together with all', async () => {
    const c = fakeClient({});
    await expect(run(c, 'pve_backup_job_set', { vmid: [100], all: true })).rejects.toThrow(
      /either vmid or all/,
    );
  });
});
