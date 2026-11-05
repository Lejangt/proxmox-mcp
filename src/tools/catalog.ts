import type { AnyToolDef } from '../server/registry.js';
import { accessTools } from './access.js';
import { apiTools } from './api.js';
import { backupTools } from './backup.js';
import { clusterTools } from './cluster.js';
import { coreTools } from './core.js';
import { firewallTools } from './firewall.js';
import { guestTools } from './guests.js';
import { haTools } from './ha.js';
import { networkTools } from './network.js';
import { nodeTools } from './nodes.js';
import { poolTools } from './pools.js';
import { snapshotTools } from './snapshots.js';
import { storageTools } from './storage.js';
import { taskTools } from './tasks.js';

export const ALL_TOOLS: AnyToolDef[] = [
  ...coreTools,
  ...clusterTools,
  ...nodeTools,
  ...networkTools,
  ...guestTools,
  ...snapshotTools,
  ...storageTools,
  ...backupTools,
  ...taskTools,
  ...accessTools,
  ...firewallTools,
  ...poolTools,
  ...haTools,
  ...apiTools,
];
