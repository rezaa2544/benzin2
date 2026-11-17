import type { InfraKind, InfraResource } from '../../../domain/entities.js';
import type { InfraResourceRepository } from '../../../ports.js';
import { query, queryOne, type Db } from './pg-common.js';

/**
 * G-13 — the infrastructure inventory on Postgres.
 *
 * A tiny table on purpose: it is read by one panel screen and written a handful of times a year.
 * The secret is stored as given (the deployment is single-tenant and the database is the trust
 * boundary) and is never selected back into a response — the service masks it.
 */

type InfraRow = {
  id: string;
  name: string;
  kind: string;
  address: string;
  secret: string | null;
  is_active: boolean;
  created_at: Date;
  updated_at: Date;
  updated_by: string | null;
};

const COLUMNS = 'id, name, kind, address, secret, is_active, created_at, updated_at, updated_by';

const toEntity = (row: InfraRow): InfraResource => ({
  id: row.id,
  name: row.name,
  kind: row.kind as InfraKind,
  address: row.address,
  secret: row.secret,
  isActive: row.is_active,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  updatedBy: row.updated_by,
});

export class PgInfraResourceRepository implements InfraResourceRepository {
  constructor(private readonly db: Db) {}

  async list(): Promise<InfraResource[]> {
    const rows = await query<InfraRow>(this.db, `SELECT ${COLUMNS} FROM infra_resources ORDER BY name`);
    return rows.map(toEntity);
  }

  async findById(id: string): Promise<InfraResource | null> {
    const row = await queryOne<InfraRow>(
      this.db,
      `SELECT ${COLUMNS} FROM infra_resources WHERE id = $1`,
      [id],
    );
    return row ? toEntity(row) : null;
  }

  async findByName(name: string): Promise<InfraResource | null> {
    const row = await queryOne<InfraRow>(
      this.db,
      `SELECT ${COLUMNS} FROM infra_resources WHERE name = $1`,
      [name],
    );
    return row ? toEntity(row) : null;
  }

  async create(
    input: Pick<InfraResource, 'name' | 'kind' | 'address' | 'secret' | 'isActive' | 'updatedBy'>,
    at: Date,
  ): Promise<InfraResource> {
    const row = await queryOne<InfraRow>(
      this.db,
      `INSERT INTO infra_resources (name, kind, address, secret, is_active, created_at, updated_at, updated_by)
       VALUES ($1, $2, $3, $4, $5, $6, $6, $7)
       RETURNING ${COLUMNS}`,
      [input.name, input.kind, input.address, input.secret, input.isActive, at, input.updatedBy],
    );
    if (!row) throw new Error('infra resource insert returned no row');
    return toEntity(row);
  }

  async update(
    id: string,
    patch: Partial<Pick<InfraResource, 'name' | 'kind' | 'address' | 'secret' | 'isActive' | 'updatedBy'>>,
    at: Date,
  ): Promise<InfraResource | null> {
    const sets: string[] = [];
    const values: unknown[] = [];
    const assign = (column: string, value: unknown): void => {
      values.push(value);
      sets.push(`${column} = $${values.length}`);
    };
    if (patch.name !== undefined) assign('name', patch.name);
    if (patch.kind !== undefined) assign('kind', patch.kind);
    if (patch.address !== undefined) assign('address', patch.address);
    if (patch.secret !== undefined) assign('secret', patch.secret);
    if (patch.isActive !== undefined) assign('is_active', patch.isActive);
    if (patch.updatedBy !== undefined) assign('updated_by', patch.updatedBy);
    if (sets.length === 0) return this.findById(id);
    values.push(at);
    sets.push(`updated_at = $${values.length}`);
    values.push(id);
    const row = await queryOne<InfraRow>(
      this.db,
      `UPDATE infra_resources SET ${sets.join(', ')} WHERE id = $${values.length} RETURNING ${COLUMNS}`,
      values,
    );
    return row ? toEntity(row) : null;
  }

  async remove(id: string): Promise<boolean> {
    const rows = await query<{ id: string }>(
      this.db,
      'DELETE FROM infra_resources WHERE id = $1 RETURNING id',
      [id],
    );
    return rows.length > 0;
  }
}
