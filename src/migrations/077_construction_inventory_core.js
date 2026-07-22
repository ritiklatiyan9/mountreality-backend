import 'dotenv/config';
import pool from '../config/db.js';

/**
 * Migration 077 — Construction Management + Inventory core tables.
 *
 * Foundation for the two new modules. Additive and idempotent (all CREATE ...
 * IF NOT EXISTS), guarded by an advisory lock like the other migrations.
 *
 * Design notes (the "why", so later phases don't drift):
 *  - `inventory_movements` is a single append-only ledger. Stock on-hand,
 *    reserved, available, valuation and history are ALL derived from it — no
 *    separate stock-balance table to drift out of sync. Issue / Receipt /
 *    Consumption / Adjustment / Reserve / Transfer / Return are just rows with
 *    a different movement_type. on-hand delta per type:
 *      RECEIPT/RETURN/TRANSFER_IN  → +qty
 *      ISSUE/CONSUMPTION/TRANSFER_OUT → −qty
 *      ADJUSTMENT → +qty (qty may be negative to shrink stock)
 *      RESERVE/UNRESERVE → don't touch on-hand; they move `reserved` only.
 *  - A project's `actual_cost` is NOT stored — it's derived from CONSUMPTION
 *    movement valuations (SUM qty*rate) so it can never disagree with the
 *    ledger. Only `budget` and `progress_pct` are stored (user-set).
 *  - Everything is site-scoped (site_id) to match every other module and the
 *    permission/site-access model.
 */

const migrate = async () => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SELECT pg_advisory_xact_lock(hashtext('077_construction_inventory_core'))`);

    // ─────────────────────────────────────────────
    //  INVENTORY: material master
    // ─────────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS inventory_materials (
        id            SERIAL PRIMARY KEY,
        site_id       INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
        code          VARCHAR(60),
        name          VARCHAR(255) NOT NULL,
        unit          VARCHAR(30) NOT NULL DEFAULT 'NOS',
        category      VARCHAR(120),
        min_stock     NUMERIC(15,3) NOT NULL DEFAULT 0,
        rate          NUMERIC(15,2) NOT NULL DEFAULT 0,
        notes         TEXT,
        is_active     BOOLEAN NOT NULL DEFAULT TRUE,
        created_by    INTEGER REFERENCES users(id) ON DELETE SET NULL,
        created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS uq_inventory_materials_site_name
        ON inventory_materials(site_id, UPPER(name))
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_inventory_materials_site ON inventory_materials(site_id)`);

    // ─────────────────────────────────────────────
    //  CONSTRUCTION: projects
    // ─────────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS construction_projects (
        id                SERIAL PRIMARY KEY,
        site_id           INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
        name              VARCHAR(255) NOT NULL,
        code              VARCHAR(60),
        status            VARCHAR(20) NOT NULL DEFAULT 'PLANNING'
                            CHECK (status IN ('PLANNING','ACTIVE','ON_HOLD','DELAYED','COMPLETED','CANCELLED')),
        start_date        DATE,
        target_end_date   DATE,
        actual_end_date   DATE,
        budget            NUMERIC(15,2) NOT NULL DEFAULT 0,
        progress_pct      INTEGER NOT NULL DEFAULT 0 CHECK (progress_pct BETWEEN 0 AND 100),
        notes             TEXT,
        assigned_admin_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
        created_by        INTEGER REFERENCES users(id) ON DELETE SET NULL,
        created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_construction_projects_site ON construction_projects(site_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_construction_projects_status ON construction_projects(status)`);

    // ─────────────────────────────────────────────
    //  CONSTRUCTION: tasks
    // ─────────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS construction_tasks (
        id            SERIAL PRIMARY KEY,
        project_id    INTEGER NOT NULL REFERENCES construction_projects(id) ON DELETE CASCADE,
        name          VARCHAR(255) NOT NULL,
        status        VARCHAR(20) NOT NULL DEFAULT 'PENDING'
                        CHECK (status IN ('PENDING','IN_PROGRESS','BLOCKED','DONE')),
        progress_pct  INTEGER NOT NULL DEFAULT 0 CHECK (progress_pct BETWEEN 0 AND 100),
        sequence      INTEGER NOT NULL DEFAULT 0,
        start_date    DATE,
        due_date      DATE,
        created_by    INTEGER REFERENCES users(id) ON DELETE SET NULL,
        created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_construction_tasks_project ON construction_tasks(project_id)`);

    // ─────────────────────────────────────────────
    //  CONSTRUCTION: material requests + line items
    // ─────────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS construction_material_requests (
        id            SERIAL PRIMARY KEY,
        site_id       INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
        project_id    INTEGER NOT NULL REFERENCES construction_projects(id) ON DELETE CASCADE,
        task_id       INTEGER REFERENCES construction_tasks(id) ON DELETE SET NULL,
        status        VARCHAR(24) NOT NULL DEFAULT 'REQUESTED'
                        CHECK (status IN ('DRAFT','REQUESTED','PARTIALLY_FULFILLED','FULFILLED','CANCELLED')),
        note          TEXT,
        requested_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
        created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_cmr_project ON construction_material_requests(project_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_cmr_status ON construction_material_requests(status)`);

    await client.query(`
      CREATE TABLE IF NOT EXISTS construction_material_request_items (
        id            SERIAL PRIMARY KEY,
        request_id    INTEGER NOT NULL REFERENCES construction_material_requests(id) ON DELETE CASCADE,
        material_id   INTEGER NOT NULL REFERENCES inventory_materials(id) ON DELETE RESTRICT,
        qty_requested NUMERIC(15,3) NOT NULL CHECK (qty_requested > 0),
        qty_issued    NUMERIC(15,3) NOT NULL DEFAULT 0,
        created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_cmri_request ON construction_material_request_items(request_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_cmri_material ON construction_material_request_items(material_id)`);

    // ─────────────────────────────────────────────
    //  INVENTORY: movement ledger (source of truth for stock)
    // ─────────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS inventory_movements (
        id             SERIAL PRIMARY KEY,
        site_id        INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
        material_id    INTEGER NOT NULL REFERENCES inventory_materials(id) ON DELETE CASCADE,
        movement_type  VARCHAR(16) NOT NULL
                         CHECK (movement_type IN (
                           'RECEIPT','ISSUE','CONSUMPTION','ADJUSTMENT',
                           'RESERVE','UNRESERVE','TRANSFER_IN','TRANSFER_OUT','RETURN'
                         )),
        qty            NUMERIC(15,3) NOT NULL,
        rate           NUMERIC(15,2) NOT NULL DEFAULT 0,
        project_id     INTEGER REFERENCES construction_projects(id) ON DELETE SET NULL,
        task_id        INTEGER REFERENCES construction_tasks(id) ON DELETE SET NULL,
        request_id     INTEGER REFERENCES construction_material_requests(id) ON DELETE SET NULL,
        ref_type       VARCHAR(40),
        ref_id         INTEGER,
        note           TEXT,
        created_by     INTEGER REFERENCES users(id) ON DELETE SET NULL,
        created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_inv_mov_material ON inventory_movements(material_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_inv_mov_site ON inventory_movements(site_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_inv_mov_project ON inventory_movements(project_id) WHERE project_id IS NOT NULL`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_inv_mov_created ON inventory_movements(created_at)`);

    await client.query('COMMIT');
    console.log('Migration 077_construction_inventory_core complete');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Migration 077_construction_inventory_core failed:', err.message);
    throw err;
  } finally {
    client.release();
  }
};

migrate()
  .then(() => process.exit(0))
  .catch(() => process.exit(1));
