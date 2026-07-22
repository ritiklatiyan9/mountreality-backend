import 'dotenv/config';
import pool from '../config/db.js';

/**
 * Migration 075 — enforce registry/source-payment plot ownership in PostgreSQL.
 *
 * Controller checks provide friendly errors, while these triggers close the
 * concurrency window between validation and INSERT/UPDATE. A linked Plot
 * Payment must always belong to the registry's exact plot (legacy plotless
 * registries fall back to the same site + plot number).
 */
const migrate = async () => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Multiple application replicas may run startup migrations together.
    // Serialize this migration inside PostgreSQL before replacing triggers.
    await client.query(`SELECT pg_advisory_xact_lock(hashtext('075_registry_payment_plot_invariants'))`);

    // Repair only unambiguous legacy rows. Ambiguous duplicate plot numbers
    // intentionally remain plotless and continue through the legacy fallback;
    // new records are required to carry an exact plot_id below.
    await client.query(`
      WITH unique_matches AS (
        SELECT pr.id AS registry_id, MIN(p.id) AS plot_id
          FROM plot_registries pr
          JOIN plots p
            ON p.site_id = pr.site_id
           AND UPPER(p.plot_no) = UPPER(pr.plot_no)
         WHERE pr.plot_id IS NULL
         GROUP BY pr.id
        HAVING COUNT(*) = 1
      )
      UPDATE plot_registries pr
         SET plot_id = match.plot_id,
             updated_at = NOW()
        FROM unique_matches match
       WHERE pr.id = match.registry_id
    `);

    // site_id is denormalized on registry payments. The registry is the
    // authoritative owner for both linked and manual rows.
    await client.query(`
      UPDATE plot_registry_payments prp
         SET site_id = pr.site_id,
             updated_at = NOW()
        FROM plot_registries pr
       WHERE pr.id = prp.registry_id
         AND prp.site_id IS DISTINCT FROM pr.site_id
    `);

    // A plot with an audit-bearing registry must not silently turn that record
    // into a legacy plotless row. The controller gives a friendly 409; this FK
    // closes the validation/delete race.
    await client.query(`
      ALTER TABLE plot_registries
        DROP CONSTRAINT IF EXISTS plot_registries_plot_id_fkey
    `);
    await client.query(`
      ALTER TABLE plot_registries
        ADD CONSTRAINT plot_registries_plot_id_fkey
        FOREIGN KEY (plot_id) REFERENCES plots(id) ON DELETE RESTRICT
    `);

    await client.query(`
      CREATE OR REPLACE FUNCTION enforce_registry_plot_reference_scope()
      RETURNS TRIGGER AS $$
      DECLARE
        referenced_site_id INTEGER;
        referenced_plot_no TEXT;
      BEGIN
        IF NEW.plot_id IS NULL THEN
          IF TG_OP = 'INSERT' THEN
            RAISE EXCEPTION 'A registry must reference an exact plot'
              USING ERRCODE = '23514';
          END IF;
          IF OLD.plot_id IS NOT NULL
             OR NEW.site_id IS DISTINCT FROM OLD.site_id
             OR UPPER(COALESCE(NEW.plot_no, ''))
                IS DISTINCT FROM UPPER(COALESCE(OLD.plot_no, '')) THEN
            RAISE EXCEPTION 'A registry must reference an exact plot'
              USING ERRCODE = '23514';
          END IF;
          -- Preserve an unresolved legacy row on unrelated updates only.
          RETURN NEW;
        END IF;

        SELECT p.site_id, p.plot_no
          INTO referenced_site_id, referenced_plot_no
          FROM plots p
         WHERE p.id = NEW.plot_id
         FOR SHARE;
        IF NOT FOUND THEN
          RAISE EXCEPTION 'Plot % does not exist', NEW.plot_id
            USING ERRCODE = '23503';
        END IF;
        IF referenced_site_id IS DISTINCT FROM NEW.site_id
           OR UPPER(COALESCE(referenced_plot_no, ''))
              IS DISTINCT FROM UPPER(COALESCE(NEW.plot_no, '')) THEN
          RAISE EXCEPTION 'Registry plot/site does not match plot %', NEW.plot_id
            USING ERRCODE = '23514';
        END IF;

        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql
    `);

    await client.query(`
      DROP TRIGGER IF EXISTS trg_registry_00_reference_scope ON plot_registries;
      CREATE TRIGGER trg_registry_00_reference_scope
      BEFORE INSERT OR UPDATE OF site_id, plot_id, plot_no
      ON plot_registries
      FOR EACH ROW
      EXECUTE FUNCTION enforce_registry_plot_reference_scope()
    `);

    await client.query(`
      CREATE OR REPLACE FUNCTION prevent_referenced_plot_identity_change()
      RETURNS TRIGGER AS $$
      BEGIN
        IF TG_OP = 'UPDATE'
           AND NEW.site_id IS NOT DISTINCT FROM OLD.site_id
           AND UPPER(COALESCE(NEW.plot_no, ''))
               IS NOT DISTINCT FROM UPPER(COALESCE(OLD.plot_no, '')) THEN
          RETURN NEW;
        END IF;

        IF EXISTS (
          SELECT 1
            FROM plot_registries pr
           WHERE pr.plot_id = OLD.id
              OR (
                pr.plot_id IS NULL
                AND pr.site_id = OLD.site_id
                AND UPPER(pr.plot_no) = UPPER(OLD.plot_no)
              )
        ) THEN
          IF TG_OP = 'DELETE' THEN
            RAISE EXCEPTION 'Plot % has a registry record and cannot be deleted', OLD.id
              USING ERRCODE = '23503';
          END IF;
          RAISE EXCEPTION 'Plot % identity cannot change while a registry references it', OLD.id
            USING ERRCODE = '23514';
        END IF;

        IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql
    `);

    await client.query(`
      DROP TRIGGER IF EXISTS trg_plot_registry_reference_guard ON plots;
      CREATE TRIGGER trg_plot_registry_reference_guard
      BEFORE UPDATE OF site_id, plot_no OR DELETE
      ON plots
      FOR EACH ROW
      EXECUTE FUNCTION prevent_referenced_plot_identity_change()
    `);

    await client.query(`
      CREATE OR REPLACE FUNCTION enforce_registry_payment_plot_scope()
      RETURNS TRIGGER AS $$
      DECLARE
        registry_site_id INTEGER;
        registry_plot_id INTEGER;
        registry_plot_no TEXT;
        source_site_id INTEGER;
        source_plot_site_id INTEGER;
        source_plot_id INTEGER;
        source_plot_no TEXT;
      BEGIN
        SELECT site_id, plot_id, plot_no
          INTO registry_site_id, registry_plot_id, registry_plot_no
          FROM plot_registries
         WHERE id = NEW.registry_id
         FOR SHARE;
        IF NOT FOUND THEN
          RAISE EXCEPTION 'Registry % does not exist', NEW.registry_id
            USING ERRCODE = '23503';
        END IF;

        NEW.site_id := registry_site_id;
        IF NEW.source_plot_payment_id IS NULL THEN
          RETURN NEW;
        END IF;

        SELECT pp.site_id, p.site_id, pp.plot_id, p.plot_no
          INTO source_site_id, source_plot_site_id, source_plot_id, source_plot_no
          FROM plot_payments pp
          JOIN plots p ON p.id = pp.plot_id
         WHERE pp.id = NEW.source_plot_payment_id
         FOR SHARE OF pp, p;
        IF NOT FOUND THEN
          RAISE EXCEPTION 'Source plot payment % does not exist', NEW.source_plot_payment_id
            USING ERRCODE = '23503';
        END IF;

        IF source_site_id IS DISTINCT FROM registry_site_id
           OR source_plot_site_id IS DISTINCT FROM registry_site_id
           OR (
             registry_plot_id IS NOT NULL
             AND source_plot_id IS DISTINCT FROM registry_plot_id
           )
           OR (
             registry_plot_id IS NULL
             AND UPPER(COALESCE(source_plot_no, ''))
                 IS DISTINCT FROM UPPER(COALESCE(registry_plot_no, ''))
           ) THEN
          RAISE EXCEPTION 'Source payment belongs to a different plot than registry %', NEW.registry_id
            USING ERRCODE = '23514';
        END IF;

        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql
    `);

    await client.query(`
      DROP TRIGGER IF EXISTS trg_registry_payment_plot_scope ON plot_registry_payments;
      CREATE TRIGGER trg_registry_payment_plot_scope
      BEFORE INSERT OR UPDATE OF registry_id, source_plot_payment_id, site_id
      ON plot_registry_payments
      FOR EACH ROW
      EXECUTE FUNCTION enforce_registry_payment_plot_scope()
    `);

    await client.query(`
      CREATE OR REPLACE FUNCTION enforce_registry_plot_change_scope()
      RETURNS TRIGGER AS $$
      BEGIN
        IF NEW.site_id IS NOT DISTINCT FROM OLD.site_id
           AND NEW.plot_id IS NOT DISTINCT FROM OLD.plot_id
           AND UPPER(COALESCE(NEW.plot_no, '')) IS NOT DISTINCT FROM UPPER(COALESCE(OLD.plot_no, '')) THEN
          RETURN NEW;
        END IF;

        IF OLD.noc_generated_at IS NOT NULL OR OLD.noc_approved_at IS NOT NULL THEN
          RAISE EXCEPTION 'Registry % plot cannot change after NOC generation', OLD.id
            USING ERRCODE = '23514';
        END IF;

        -- Serialize against a concurrent source-payment move/delete. A
        -- concurrent link is serialized by the registry row lock acquired by
        -- the payment trigger.
        PERFORM 1
          FROM plot_registry_payments prp
          JOIN plot_payments pp ON pp.id = prp.source_plot_payment_id
          JOIN plots source_plot ON source_plot.id = pp.plot_id
         WHERE prp.registry_id = OLD.id
           AND prp.source_plot_payment_id IS NOT NULL
         FOR SHARE OF prp, pp, source_plot;

        IF EXISTS (
          SELECT 1
            FROM plot_registry_payments prp
            JOIN plot_payments pp ON pp.id = prp.source_plot_payment_id
            LEFT JOIN plots source_plot ON source_plot.id = pp.plot_id
           WHERE prp.registry_id = OLD.id
             AND prp.source_plot_payment_id IS NOT NULL
             AND (
               COALESCE(pp.site_id, source_plot.site_id) IS DISTINCT FROM NEW.site_id
               OR (NEW.plot_id IS NOT NULL AND pp.plot_id IS DISTINCT FROM NEW.plot_id)
               OR (
                 NEW.plot_id IS NULL
                 AND UPPER(COALESCE(source_plot.plot_no, ''))
                     IS DISTINCT FROM UPPER(COALESCE(NEW.plot_no, ''))
               )
             )
        ) THEN
          RAISE EXCEPTION 'Remove linked plot payments before changing registry % plot', OLD.id
            USING ERRCODE = '23514';
        END IF;

        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql
    `);

    await client.query(`
      DROP TRIGGER IF EXISTS trg_registry_plot_change_scope ON plot_registries;
      DROP TRIGGER IF EXISTS trg_registry_10_plot_change_scope ON plot_registries;
      CREATE TRIGGER trg_registry_10_plot_change_scope
      BEFORE UPDATE OF site_id, plot_id, plot_no
      ON plot_registries
      FOR EACH ROW
      EXECUTE FUNCTION enforce_registry_plot_change_scope()
    `);

    await client.query(`
      CREATE OR REPLACE FUNCTION enforce_linked_plot_payment_move_scope()
      RETURNS TRIGGER AS $$
      DECLARE
        linked_registry_id INTEGER;
        registry_site_id INTEGER;
        registry_plot_id INTEGER;
        registry_plot_no TEXT;
        target_plot_site_id INTEGER;
        target_plot_no TEXT;
      BEGIN
        SELECT registry.id, registry.site_id, registry.plot_id, registry.plot_no
          INTO linked_registry_id, registry_site_id, registry_plot_id, registry_plot_no
          FROM plot_registry_payments prp
          JOIN plot_registries registry ON registry.id = prp.registry_id
         WHERE prp.source_plot_payment_id = OLD.id
         LIMIT 1
         FOR SHARE OF prp, registry;

        IF NOT FOUND THEN
          IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
          RETURN NEW;
        END IF;

        IF TG_OP = 'DELETE' THEN
          RAISE EXCEPTION 'Linked plot payment % cannot be deleted', OLD.id
            USING ERRCODE = '23503';
        END IF;

        IF NEW.site_id IS NOT DISTINCT FROM OLD.site_id
           AND NEW.plot_id IS NOT DISTINCT FROM OLD.plot_id THEN
          RETURN NEW;
        END IF;

        SELECT p.site_id, p.plot_no
          INTO target_plot_site_id, target_plot_no
          FROM plots p
         WHERE p.id = NEW.plot_id
         FOR SHARE;
        IF NOT FOUND THEN
          RAISE EXCEPTION 'Plot % does not exist', NEW.plot_id
            USING ERRCODE = '23503';
        END IF;

        IF NEW.site_id IS DISTINCT FROM registry_site_id
           OR target_plot_site_id IS DISTINCT FROM registry_site_id
           OR (registry_plot_id IS NOT NULL AND NEW.plot_id IS DISTINCT FROM registry_plot_id)
           OR (
             registry_plot_id IS NULL
             AND UPPER(COALESCE(target_plot_no, ''))
                 IS DISTINCT FROM UPPER(COALESCE(registry_plot_no, ''))
           ) THEN
          RAISE EXCEPTION 'Linked plot payment % cannot be moved to a different plot', OLD.id
            USING ERRCODE = '23514';
        END IF;

        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql
    `);

    await client.query(`
      DROP TRIGGER IF EXISTS trg_linked_plot_payment_move_scope ON plot_payments;
      CREATE TRIGGER trg_linked_plot_payment_move_scope
      BEFORE UPDATE OF site_id, plot_id OR DELETE
      ON plot_payments
      FOR EACH ROW
      EXECUTE FUNCTION enforce_linked_plot_payment_move_scope()
    `);

    await client.query('COMMIT');
    console.log('Migration 075_registry_payment_plot_invariants complete');
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Migration 075_registry_payment_plot_invariants failed:', error.message);
    throw error;
  } finally {
    client.release();
  }
};

migrate()
  .then(() => process.exit(0))
  .catch(() => process.exit(1));
