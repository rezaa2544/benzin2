import type { NodeHeartbeatRecord, NodeRepository } from '../../ports.js';

const clone = <T>(value: T): T => structuredClone(value);

/**
 * Heartbeats in memory (task G-28): enough for tests and for `pnpm dev` without Postgres — the
 * helper's failover poll reads the same rows the panel does, just without persistence.
 */
export class MemoryNodeRepository implements NodeRepository {
  private readonly byId = new Map<string, NodeHeartbeatRecord>();

  async save(record: NodeHeartbeatRecord): Promise<void> {
    this.byId.set(record.nodeId, clone(record));
  }

  async list(): Promise<NodeHeartbeatRecord[]> {
    return [...this.byId.values()].map(clone);
  }

  async get(nodeId: string): Promise<NodeHeartbeatRecord | null> {
    const record = this.byId.get(nodeId);
    return record ? clone(record) : null;
  }
}
