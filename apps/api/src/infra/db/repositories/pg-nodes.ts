import type { NodeHeartbeatRecord, NodeJob, NodeJobs, NodeRepository, NodeResources, NodeTraffic } from '../../../ports.js';
import { query, queryOne, type Db } from './pg-common.js';

/**
 * Node heartbeats on Postgres (task G-28).
 *
 * One row per node, last write wins: telemetry is a "what is true now" feed, not an event log, so
 * the helper's failover poll and the panel both read a single tiny table. The three structured
 * groups travel as `jsonb`; only the fields the panel filters on are real columns.
 */

type NodeRow = {
  node_id: string;
  name: string;
  role: string;
  version: string | null;
  region: string | null;
  resources: NodeResources | null;
  traffic: NodeTraffic;
  jobs: NodeJobs;
  uptime_seconds: number;
  active: boolean;
  last_seen_at: Date;
};

const COLUMNS = `node_id, name, role, version, region, resources, traffic, jobs, uptime_seconds, active, last_seen_at`;

const toRecord = (row: NodeRow): NodeHeartbeatRecord => ({
  nodeId: row.node_id,
  name: row.name,
  role: row.role === 'primary' ? 'primary' : 'helper',
  version: row.version,
  region: row.region,
  resources: row.resources,
  traffic: row.traffic,
  jobs: { ...row.jobs, recent: (row.jobs?.recent ?? []) as NodeJob[] },
  uptimeSeconds: row.uptime_seconds,
  active: row.active,
  lastSeenAt: row.last_seen_at,
});

export class PgNodeRepository implements NodeRepository {
  constructor(private readonly db: Db) {}

  async save(record: NodeHeartbeatRecord): Promise<void> {
    await query(
      this.db,
      `INSERT INTO node_heartbeats (${COLUMNS})
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8::jsonb, $9, $10, $11)
       ON CONFLICT (node_id) DO UPDATE SET
         name = EXCLUDED.name,
         role = EXCLUDED.role,
         version = EXCLUDED.version,
         region = EXCLUDED.region,
         resources = EXCLUDED.resources,
         traffic = EXCLUDED.traffic,
         jobs = EXCLUDED.jobs,
         uptime_seconds = EXCLUDED.uptime_seconds,
         active = EXCLUDED.active,
         last_seen_at = EXCLUDED.last_seen_at`,
      [
        record.nodeId,
        record.name,
        record.role,
        record.version,
        record.region,
        record.resources ? JSON.stringify(record.resources) : null,
        JSON.stringify(record.traffic),
        JSON.stringify(record.jobs),
        record.uptimeSeconds,
        record.active,
        record.lastSeenAt,
      ],
    );
  }

  async list(): Promise<NodeHeartbeatRecord[]> {
    const rows = await query<NodeRow>(this.db, `SELECT ${COLUMNS} FROM node_heartbeats`);
    return rows.map(toRecord);
  }

  async get(nodeId: string): Promise<NodeHeartbeatRecord | null> {
    const row = await queryOne<NodeRow>(
      this.db,
      `SELECT ${COLUMNS} FROM node_heartbeats WHERE node_id = $1`,
      [nodeId],
    );
    return row ? toRecord(row) : null;
  }
}
