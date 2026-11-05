import { describe, expect, it } from 'vitest';
import { storageTools } from '../src/tools/storage.js';
import { callTool, UPID } from './helpers/call-tool.js';
import { fakeClient, type FakeClient } from './helpers/fake-client.js';

const storageRows = [
  {
    id: 'storage/pve1/local',
    storage: 'local',
    node: 'pve1',
    status: 'available',
    content: 'iso,vztmpl,backup',
    disk: 10,
    maxdisk: 100,
  },
  {
    id: 'storage/pve2/local',
    storage: 'local',
    node: 'pve2',
    status: 'available',
    content: 'iso,vztmpl,backup',
    disk: 20,
    maxdisk: 100,
  },
  {
    id: 'storage/pve1/fast',
    storage: 'fast',
    node: 'pve1',
    status: 'available',
    content: 'images,rootdir',
    disk: 1,
    maxdisk: 50,
  },
];

function client(extra: Record<string, unknown> = {}): FakeClient {
  return fakeClient({ 'GET /cluster/resources': storageRows, ...extra } as never);
}

const run = (c: FakeClient, name: string, args: Record<string, unknown>) =>
  callTool(storageTools, name, args, c);
const last = (c: FakeClient) => c.calls[c.calls.length - 1];

describe('storage tools', () => {
  it('uses the contract names, categories and access levels', () => {
    expect(storageTools.map((t) => `${t.name}:${t.category}:${t.access}`)).toEqual([
      'pve_storage_list:storage:read',
      'pve_storage_content:storage:read',
      'pve_storage_download_url:storage:write',
      'pve_storage_templates:storage:read',
      'pve_storage_template_download:storage:write',
      'pve_storage_volume_delete:storage:destructive',
      'pve_storage_define:storage:write',
      'pve_storage_remove:storage:destructive',
    ]);
  });

  it('list without node joins definitions with per node usage', async () => {
    const c = client({
      'GET /storage': [
        { storage: 'local', type: 'dir', content: 'iso,vztmpl,backup' },
        { storage: 'fast', type: 'lvmthin', content: 'images,rootdir', disable: 1 },
      ],
    });
    const all = (await run(c, 'pve_storage_list', {})) as Array<{
      storage: string;
      usage: unknown[];
      enabled: boolean;
    }>;
    expect(all.find((s) => s.storage === 'local')?.usage).toHaveLength(2);
    const onlyBackup = (await run(c, 'pve_storage_list', { content: 'backup' })) as unknown[];
    expect(onlyBackup).toHaveLength(1);
    const disabled = (await run(c, 'pve_storage_list', { enabled: false })) as Array<{
      storage: string;
    }>;
    expect(disabled.map((s) => s.storage)).toEqual(['fast']);
  });

  it('list with node asks the node endpoint with the filters', async () => {
    const c = client({
      'GET /nodes/pve1/storage': [{ storage: 'local', content: 'iso', total: 5 }],
    });
    await run(c, 'pve_storage_list', { node: 'pve1', content: 'iso', enabled: true });
    expect(last(c)).toMatchObject({
      path: '/nodes/pve1/storage',
      params: { content: 'iso', enabled: true },
    });
  });

  it('content finds the node of a single node storage and passes filters', async () => {
    const c = client({
      'GET /nodes/pve1/storage/fast/content': [
        { volid: 'fast:vm-100-disk-0', ctime: 1700000000, size: 5 },
      ],
    });
    const out = (await run(c, 'pve_storage_content', {
      storage: 'fast',
      content: 'images',
      vmid: 100,
    })) as Array<{
      ctime: string;
    }>;
    expect(last(c)).toMatchObject({
      path: '/nodes/pve1/storage/fast/content',
      params: { content: 'images', vmid: 100 },
    });
    expect(out[0]?.ctime).toBe('2023-11-14T22:13:20.000Z');
  });

  it('asks for a node when the storage exists on several', async () => {
    const c = client();
    await expect(run(c, 'pve_storage_content', { storage: 'local' })).rejects.toThrow(/pve1, pve2/);
  });

  it('download_url posts all fields and verifies certificates by default', async () => {
    const c = client({ 'POST /nodes/pve1/storage/local/download-url': UPID });
    await run(c, 'pve_storage_download_url', {
      storage: 'local',
      node: 'pve1',
      url: 'https://example.com/debian.iso',
      filename: 'debian.iso',
      content: 'iso',
      checksum: 'abc',
      checksumAlgorithm: 'sha256',
      wait: false,
    });
    expect(last(c)).toMatchObject({
      method: 'POST',
      path: '/nodes/pve1/storage/local/download-url',
      params: {
        url: 'https://example.com/debian.iso',
        filename: 'debian.iso',
        content: 'iso',
        checksum: 'abc',
        'checksum-algorithm': 'sha256',
        'verify-certificates': true,
      },
    });
  });

  it('download_url rejects non-http URLs, path separators and a lone checksum', async () => {
    const c = client();
    const base = { storage: 'local', node: 'pve1', content: 'iso' };
    await expect(
      run(c, 'pve_storage_download_url', { ...base, url: 'file:///etc/passwd', filename: 'a.iso' }),
    ).rejects.toThrow();
    await expect(
      run(c, 'pve_storage_download_url', {
        ...base,
        url: 'https://example.com/a.iso',
        filename: '../a.iso',
      }),
    ).rejects.toThrow();
    await expect(
      run(c, 'pve_storage_download_url', {
        ...base,
        url: 'https://example.com/a.iso',
        filename: 'a.iso',
        checksum: 'x',
      }),
    ).rejects.toThrow(/belong together/);
  });

  it('templates reads aplinfo and filters', async () => {
    const c = fakeClient({
      'GET /nodes': [{ node: 'pve1' }],
      'GET /nodes/pve1/aplinfo': [
        {
          template: 'debian-12.tar.zst',
          package: 'debian-12-standard',
          os: 'debian-12',
          section: 'system',
          headline: 'Debian 12',
        },
        {
          template: 'alpine.tar.xz',
          package: 'alpine-3',
          os: 'alpine-3',
          section: 'system',
          headline: 'Alpine',
        },
        {
          template: 'wp.tar.gz',
          package: 'wordpress',
          os: 'debian-12',
          section: 'turnkeylinux',
          headline: 'WordPress',
        },
      ],
    });
    const out = (await run(c, 'pve_storage_templates', { section: 'system', search: 'alp' })) as {
      total: number;
      templates: Array<{ template: string }>;
    };
    expect(out.templates.map((t) => t.template)).toEqual(['alpine.tar.xz']);
    const all = (await run(c, 'pve_storage_templates', { limit: 1 })) as {
      total: number;
      shown: number;
    };
    expect(all).toMatchObject({ total: 3, shown: 1 });
  });

  it('template_download posts storage and template to aplinfo', async () => {
    const c = client({ 'POST /nodes/pve1/aplinfo': UPID });
    await run(c, 'pve_storage_template_download', {
      storage: 'local',
      node: 'pve1',
      template: 'debian-12.tar.zst',
      wait: false,
    });
    expect(last(c)).toMatchObject({
      method: 'POST',
      path: '/nodes/pve1/aplinfo',
      params: { storage: 'local', template: 'debian-12.tar.zst' },
    });
  });

  it('volume_delete encodes the volid as one path segment and checks the storage prefix', async () => {
    const c = client({
      'DELETE /nodes/pve1/storage/local/content/local%3Aiso%2Fold.iso': null,
    });
    await run(c, 'pve_storage_volume_delete', {
      storage: 'local',
      node: 'pve1',
      volume: 'local:iso/old.iso',
    });
    expect(last(c)).toMatchObject({
      method: 'DELETE',
      path: '/nodes/pve1/storage/local/content/local%3Aiso%2Fold.iso',
    });
    await expect(
      run(c, 'pve_storage_volume_delete', {
        storage: 'local',
        node: 'pve1',
        volume: 'fast:vm-1-disk-0',
      }),
    ).rejects.toThrow(/belongs to storage "fast"/);
  });

  it('define creates with POST /storage and updates with PUT', async () => {
    const c = client({ 'POST /storage': { storage: 'nas' }, 'PUT /storage/nas': null });
    await run(c, 'pve_storage_define', {
      storage: 'nas',
      type: 'nfs',
      content: ['iso', 'backup'],
      nodes: ['pve1', 'pve2'],
      options: { server: '192.0.2.10', export: '/srv/share' },
    });
    expect(last(c)).toMatchObject({
      method: 'POST',
      path: '/storage',
      params: {
        storage: 'nas',
        type: 'nfs',
        content: 'iso,backup',
        nodes: 'pve1,pve2',
        server: '192.0.2.10',
        export: '/srv/share',
      },
    });
    await run(c, 'pve_storage_define', {
      storage: 'nas',
      update: true,
      disable: true,
      delete: ['nodes'],
    });
    expect(last(c)).toMatchObject({
      method: 'PUT',
      path: '/storage/nas',
      params: { disable: true, delete: 'nodes' },
    });
    expect(last(c)?.params).not.toHaveProperty('type');
  });

  it('define validates type use', async () => {
    const c = client();
    await expect(run(c, 'pve_storage_define', { storage: 'nas' })).rejects.toThrow(
      /type is required/,
    );
    await expect(
      run(c, 'pve_storage_define', { storage: 'nas', update: true, type: 'dir' }),
    ).rejects.toThrow(/cannot be changed/);
    await expect(
      run(c, 'pve_storage_define', { storage: 'nas', type: 'dir', options: { type: 'nfs' } }),
    ).rejects.toThrow(/"type" is not an option/);
  });

  it('remove deletes the definition', async () => {
    const c = client({ 'DELETE /storage/nas': null });
    await run(c, 'pve_storage_remove', { storage: 'nas' });
    expect(last(c)).toMatchObject({ method: 'DELETE', path: '/storage/nas' });
  });
});
