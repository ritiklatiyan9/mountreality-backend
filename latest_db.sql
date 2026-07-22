--
-- PostgreSQL database dump
--

\restrict NfdrKFzotKeTPhyQSiMenRUvqL1UJYaznIHHWO9arktnhlWEfh9RUNVWxyT3Xcd

-- Dumped from database version 17.10 (98a80fa)
-- Dumped by pg_dump version 18.4

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET transaction_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: pg_trgm; Type: EXTENSION; Schema: -; Owner: -
--

CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA public;


--
-- Name: enforce_linked_plot_payment_move_scope(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.enforce_linked_plot_payment_move_scope() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
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
      $$;


--
-- Name: enforce_registry_payment_plot_scope(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.enforce_registry_payment_plot_scope() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
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
      $$;


--
-- Name: enforce_registry_plot_change_scope(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.enforce_registry_plot_change_scope() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
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
      $$;


--
-- Name: enforce_registry_plot_reference_scope(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.enforce_registry_plot_reference_scope() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
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
      $$;


--
-- Name: ensure_person_cashflow_month(integer, date, integer, integer, character varying, integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.ensure_person_cashflow_month(p_site_id integer, p_entry_date date, p_mapped_member_id integer, p_mapped_user_id integer, p_display_name character varying, p_created_by integer) RETURNS integer
    LANGUAGE plpgsql
    AS $$
      DECLARE
        v_month INTEGER;
        v_year INTEGER;
        v_month_id INTEGER;
        v_prev_id INTEGER;
        v_opening NUMERIC(15,2) := 0;
        v_name VARCHAR(255);
      BEGIN
        v_month := EXTRACT(MONTH FROM p_entry_date)::INTEGER;
        v_year := EXTRACT(YEAR FROM p_entry_date)::INTEGER;
        v_name := NULLIF(UPPER(TRIM(COALESCE(p_display_name, ''))), '');
        IF v_name IS NULL THEN
          v_name := 'PERSON #' || COALESCE(p_mapped_member_id, p_mapped_user_id)::text;
        END IF;

        SELECT id INTO v_month_id
        FROM cash_flow_months
        WHERE site_id = p_site_id AND month = v_month AND year = v_year AND ledger_type = 'person'
          AND ((p_mapped_member_id IS NOT NULL AND linked_member_id = p_mapped_member_id)
            OR (p_mapped_user_id IS NOT NULL AND linked_user_id = p_mapped_user_id))
        LIMIT 1;

        IF v_month_id IS NOT NULL THEN
          RETURN v_month_id;
        END IF;

        SELECT cfm.id INTO v_prev_id
        FROM cash_flow_months cfm
        WHERE cfm.site_id = p_site_id AND cfm.ledger_type = 'person'
          AND ((p_mapped_member_id IS NOT NULL AND cfm.linked_member_id = p_mapped_member_id)
            OR (p_mapped_user_id IS NOT NULL AND cfm.linked_user_id = p_mapped_user_id))
          AND (cfm.year < v_year OR (cfm.year = v_year AND cfm.month < v_month))
        ORDER BY cfm.year DESC, cfm.month DESC
        LIMIT 1;

        IF v_prev_id IS NOT NULL THEN
          SELECT COALESCE(cfm.opening_balance, 0) + COALESCE(SUM(cfe.credit), 0) - COALESCE(SUM(cfe.debit), 0)
            INTO v_opening
          FROM cash_flow_months cfm
          LEFT JOIN cash_flow_entries cfe ON cfe.cash_flow_month_id = cfm.id
          WHERE cfm.id = v_prev_id
          GROUP BY cfm.opening_balance;
        END IF;

        INSERT INTO cash_flow_months (
          site_id, month, year, ledger_name, ledger_type, opening_balance, created_by,
          linked_member_id, linked_user_id
        ) VALUES (
          p_site_id, v_month, v_year, v_name, 'person', COALESCE(v_opening, 0), p_created_by,
          p_mapped_member_id, p_mapped_user_id
        )
        ON CONFLICT (site_id, month, year, ledger_name) DO NOTHING
        RETURNING id INTO v_month_id;

        IF v_month_id IS NULL THEN
          -- ponytail: display name collided with an unrelated ledger already using
          -- it this period (two different people, same name) — disambiguate by id
          -- so the mapping never silently lands in someone else's ledger.
          INSERT INTO cash_flow_months (
            site_id, month, year, ledger_name, ledger_type, opening_balance, created_by,
            linked_member_id, linked_user_id
          ) VALUES (
            p_site_id, v_month, v_year,
            v_name || ' #' || COALESCE(p_mapped_member_id, p_mapped_user_id)::text,
            'person', COALESCE(v_opening, 0), p_created_by, p_mapped_member_id, p_mapped_user_id
          )
          RETURNING id INTO v_month_id;
        END IF;

        RETURN v_month_id;
      END;
      $$;


--
-- Name: ensure_site_cashflow_month(integer, date, integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.ensure_site_cashflow_month(p_site_id integer, p_entry_date date, p_created_by integer) RETURNS integer
    LANGUAGE plpgsql
    AS $$
      DECLARE
        v_month INTEGER;
        v_year INTEGER;
        v_month_id INTEGER;
        v_prev_id INTEGER;
        v_opening NUMERIC(15,2) := 0;
      BEGIN
        v_month := EXTRACT(MONTH FROM p_entry_date)::INTEGER;
        v_year := EXTRACT(YEAR FROM p_entry_date)::INTEGER;

        SELECT id INTO v_month_id
        FROM cash_flow_months
        WHERE site_id = p_site_id
          AND month = v_month
          AND year = v_year
          AND COALESCE(ledger_name, '') = ''
          AND COALESCE(ledger_type, 'site') = 'site'
        LIMIT 1;

        IF v_month_id IS NOT NULL THEN
          RETURN v_month_id;
        END IF;

        SELECT cfm.id INTO v_prev_id
        FROM cash_flow_months cfm
        WHERE cfm.site_id = p_site_id
          AND COALESCE(cfm.ledger_name, '') = ''
          AND COALESCE(cfm.ledger_type, 'site') = 'site'
          AND (cfm.year < v_year OR (cfm.year = v_year AND cfm.month < v_month))
        ORDER BY cfm.year DESC, cfm.month DESC
        LIMIT 1;

        IF v_prev_id IS NOT NULL THEN
          SELECT
            COALESCE(cfm.opening_balance, 0)
              + COALESCE(SUM(cfe.credit), 0)
              - COALESCE(SUM(cfe.debit), 0)
          INTO v_opening
          FROM cash_flow_months cfm
          LEFT JOIN cash_flow_entries cfe ON cfe.cash_flow_month_id = cfm.id
          WHERE cfm.id = v_prev_id
          GROUP BY cfm.opening_balance;
        END IF;

        INSERT INTO cash_flow_months (
          site_id, month, year, ledger_name, ledger_type, opening_balance, created_by
        ) VALUES (
          p_site_id, v_month, v_year, '', 'site', COALESCE(v_opening, 0), p_created_by
        )
        ON CONFLICT (site_id, month, year, ledger_name)
        DO NOTHING;

        SELECT id INTO v_month_id
        FROM cash_flow_months
        WHERE site_id = p_site_id
          AND month = v_month
          AND year = v_year
          AND COALESCE(ledger_name, '') = ''
          AND COALESCE(ledger_type, 'site') = 'site'
        LIMIT 1;

        RETURN v_month_id;
      END;
      $$;


--
-- Name: prevent_referenced_plot_identity_change(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.prevent_referenced_plot_identity_change() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
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
      $$;


--
-- Name: sync_cashflow_from_modules(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.sync_cashflow_from_modules() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
      DECLARE
        v_site_id INTEGER;
        v_entry_date DATE;
        v_particular VARCHAR(500);
        v_debit NUMERIC(15,2) := 0;
        v_credit NUMERIC(15,2) := 0;
        v_cash_type VARCHAR(20) := 'cash';
        v_remarks TEXT;
        v_created_by INTEGER;
        v_month_id INTEGER;
        v_source_module VARCHAR(50);
        v_person_source_module VARCHAR(60);
        v_source_id INTEGER;
        v_assigned_admin_id INTEGER;
        v_voucher_url TEXT;
        v_status VARCHAR(20) := 'pending';
        v_approved_by INTEGER;
        v_approved_at TIMESTAMPTZ;
        v_mapped_member_id INTEGER;
        v_mapped_user_id INTEGER;
        v_person_month_id INTEGER;
        v_person_display_name VARCHAR(255);
      BEGIN
        v_source_module := TG_TABLE_NAME;
        v_person_source_module := TG_TABLE_NAME || '_person';

        IF TG_OP = 'DELETE' THEN
          DELETE FROM cash_flow_entries cfe
          WHERE cfe.source_module = v_source_module AND cfe.source_id = OLD.id;
          DELETE FROM cash_flow_entries cfe
          WHERE cfe.source_module = v_person_source_module AND cfe.source_id = OLD.id;
          RETURN OLD;
        END IF;

        v_source_id := NEW.id;

        IF TG_TABLE_NAME = 'farmer_payments' THEN
          SELECT f.site_id, f.name INTO v_site_id, v_particular
          FROM farmers f
          WHERE f.id = NEW.farmer_id;

          v_entry_date := COALESCE(NEW.date, CURRENT_DATE);
          v_particular := ('FARMER PAYMENT - ' || COALESCE(v_particular, 'FARMER'))::VARCHAR(500);
          v_debit := COALESCE(NEW.amount, 0);
          v_credit := 0;
          v_cash_type := CASE
            WHEN UPPER(COALESCE(NEW.payment_mode, 'CASH')) = 'BANK' THEN 'bank'
            ELSE 'cash'
          END;
          v_remarks := NEW.remarks;
          v_created_by := NULL;
          v_assigned_admin_id := NEW.assigned_admin_id;
          v_voucher_url := NEW.voucher_url;
          v_status := COALESCE(NEW.status, 'pending');
          v_approved_by := NEW.approved_by;
          v_approved_at := NEW.approved_at;
          v_mapped_member_id := NEW.mapped_member_id;
          v_mapped_user_id := NEW.mapped_user_id;

        ELSIF TG_TABLE_NAME = 'plot_commissions' THEN
          v_site_id := NEW.site_id;
          v_entry_date := COALESCE(NEW.date, CURRENT_DATE);
          v_particular := ('PLOT COMMISSION - ' || COALESCE(NEW.particular, 'COMMISSION'))::VARCHAR(500);
          v_debit := COALESCE(NEW.amount, 0);
          v_credit := 0;
          v_cash_type := CASE
            WHEN UPPER(COALESCE(NEW.by_note, 'CASH')) LIKE '%BANK%' THEN 'bank'
            ELSE 'cash'
          END;
          v_remarks := NEW.remarks;
          v_created_by := NEW.created_by;
          v_assigned_admin_id := NEW.assigned_admin_id;
          v_voucher_url := NEW.voucher_url;
          v_status := COALESCE(NEW.status, 'pending');
          v_approved_by := NEW.approved_by;
          v_approved_at := NEW.approved_at;
          -- legacy table, no writer left — no mapped_* columns added for it.
          v_mapped_member_id := NULL;
          v_mapped_user_id := NULL;

        ELSIF TG_TABLE_NAME = 'plot_commission_payments' THEN
          SELECT COALESCE(m.full_name, 'AGENT') INTO v_particular
          FROM plot_commissions_v2 pcm
          LEFT JOIN members m ON m.id = pcm.agent_id
          WHERE pcm.id = NEW.plot_commission_id;

          v_site_id := NEW.site_id;
          v_entry_date := COALESCE(NEW.date, CURRENT_DATE);
          v_particular := ('PLOT COMMISSION PAYMENT - ' || COALESCE(v_particular, 'AGENT'))::VARCHAR(500);
          v_debit := COALESCE(NEW.amount, 0);
          v_credit := 0;
          v_cash_type := CASE
            WHEN UPPER(COALESCE(NEW.payment_mode, 'CASH')) = 'BANK' THEN 'bank'
            ELSE 'cash'
          END;
          v_remarks := NEW.remarks;
          v_created_by := NEW.created_by;
          v_assigned_admin_id := NEW.assigned_admin_id;
          v_voucher_url := NEW.voucher_url;
          v_status := COALESCE(NEW.status, 'pending');
          v_approved_by := NEW.approved_by;
          v_approved_at := NEW.approved_at;
          v_mapped_member_id := NEW.mapped_member_id;
          v_mapped_user_id := NEW.mapped_user_id;

        ELSIF TG_TABLE_NAME = 'day_book' THEN
          IF UPPER(COALESCE(NEW.entry_type, 'GENERAL')) IN ('CASH FLOW', 'FARMER PAYMENT', 'PLOT COMMISSION', 'FIRM TRANSACTION', 'PLOT PAYMENT', 'VENDOR PAYMENT') THEN
            DELETE FROM cash_flow_entries cfe
            WHERE cfe.source_module = v_source_module AND cfe.source_id = v_source_id;
            DELETE FROM cash_flow_entries cfe
            WHERE cfe.source_module = v_person_source_module AND cfe.source_id = v_source_id;
            RETURN NEW;
          END IF;

          v_site_id := NEW.site_id;
          v_entry_date := COALESCE(NEW.date, CURRENT_DATE);
          v_particular := COALESCE(NEW.particular, 'DAY BOOK ENTRY');
          v_debit := COALESCE(NEW.debit, 0);
          v_credit := COALESCE(NEW.credit, 0);
          v_cash_type := CASE
            WHEN UPPER(COALESCE(NEW.payment_mode, 'CASH')) LIKE '%BANK%' THEN 'bank'
            ELSE 'cash'
          END;
          v_remarks := NEW.remarks;
          v_created_by := NEW.created_by;
          v_assigned_admin_id := NEW.assigned_admin_id;
          v_status := COALESCE(NEW.status, 'pending');
          v_approved_by := NEW.approved_by;
          v_approved_at := NEW.approved_at;
          v_mapped_member_id := NEW.mapped_member_id;
          v_mapped_user_id := NEW.mapped_user_id;

        ELSIF TG_TABLE_NAME = 'firm_transactions' THEN
          v_site_id := NEW.site_id;
          v_entry_date := COALESCE(NEW.date, CURRENT_DATE);
          v_particular := COALESCE(NEW.description, 'FIRM TRANSACTION');
          v_debit := COALESCE(NEW.debit, 0);
          v_credit := COALESCE(NEW.credit, 0);
          v_cash_type := CASE
            WHEN LOWER(COALESCE(NEW.payment_mode, 'cash')) = 'bank' THEN 'bank'
            ELSE 'cash'
          END;
          v_remarks := NEW.remark;
          v_created_by := NEW.created_by;
          v_assigned_admin_id := NEW.assigned_admin_id;
          v_voucher_url := NEW.voucher_url;
          v_status := COALESCE(NEW.status, 'pending');
          v_approved_by := NEW.approved_by;
          v_approved_at := NEW.approved_at;
          v_mapped_member_id := NEW.mapped_member_id;
          v_mapped_user_id := NEW.mapped_user_id;

        ELSIF TG_TABLE_NAME = 'plot_payments' THEN
          v_site_id := NEW.site_id;
          v_entry_date := COALESCE(NEW.date, CURRENT_DATE);
          v_particular := ('PLOT PAYMENT - ' || COALESCE(NEW.payment_from, 'PLOT'))::VARCHAR(500);
          v_debit := 0;
          v_credit := COALESCE(NEW.amount, 0);
          v_cash_type := CASE
            WHEN UPPER(COALESCE(NEW.payment_type, 'CASH')) = 'BANK' THEN 'bank'
            ELSE 'cash'
          END;
          v_remarks := NEW.narration;
          v_created_by := NEW.created_by;
          v_assigned_admin_id := NEW.assigned_admin_id;
          v_voucher_url := NEW.voucher_url;
          v_status := COALESCE(NEW.status, 'pending');
          v_approved_by := NEW.approved_by;
          v_approved_at := NEW.approved_at;
          v_mapped_member_id := NEW.mapped_member_id;
          v_mapped_user_id := NEW.mapped_user_id;

        ELSIF TG_TABLE_NAME = 'expenses' THEN
          v_site_id := NEW.site_id;
          v_entry_date := COALESCE(NEW.date, CURRENT_DATE);
          v_particular := COALESCE(NEW.remark, 'EXPENSE ENTRY');
          v_debit := COALESCE(NEW.debit, 0);
          v_credit := COALESCE(NEW.credit, 0);
          v_cash_type := CASE
            WHEN UPPER(COALESCE(NEW.payment_mode, 'CASH')) LIKE '%BANK%' THEN 'bank'
            ELSE 'cash'
          END;
          v_remarks := CONCAT_WS(' | ', NEW.from_entity, NEW.to_entity, NEW.category);
          v_created_by := NEW.created_by;
          v_assigned_admin_id := NEW.assigned_admin_id;
          v_voucher_url := NEW.voucher_url;
          v_status := COALESCE(NEW.status, 'pending');
          v_approved_by := NEW.approved_by;
          v_approved_at := NEW.approved_at;
          v_mapped_member_id := NEW.mapped_member_id;
          v_mapped_user_id := NEW.mapped_user_id;

        ELSIF TG_TABLE_NAME = 'vendor_payments' THEN
          SELECT COALESCE(vc.vendor_name, 'VENDOR') INTO v_particular
          FROM vendor_commitments vc
          WHERE vc.id = NEW.commitment_id;

          v_site_id := NEW.site_id;
          v_entry_date := COALESCE(NEW.payment_date, CURRENT_DATE);
          v_particular := ('VENDOR PAYMENT - ' || COALESCE(v_particular, 'VENDOR'))::VARCHAR(500);
          v_debit := COALESCE(NEW.amount, 0);
          v_credit := 0;
          v_cash_type := CASE
            WHEN LOWER(COALESCE(NEW.payment_mode, 'cash')) = 'bank' THEN 'bank'
            ELSE 'cash'
          END;
          v_remarks := NEW.note;
          v_created_by := NEW.created_by;
          v_assigned_admin_id := NEW.assigned_admin_id;
          v_voucher_url := NEW.voucher_url;
          v_status := COALESCE(NEW.status, 'pending');
          v_approved_by := NEW.approved_by;
          v_approved_at := NEW.approved_at;
          v_mapped_member_id := NEW.mapped_member_id;
          v_mapped_user_id := NEW.mapped_user_id;
        ELSE
          RETURN NEW;
        END IF;

        IF v_site_id IS NULL OR (COALESCE(v_debit, 0) = 0 AND COALESCE(v_credit, 0) = 0) THEN
          DELETE FROM cash_flow_entries cfe
          WHERE cfe.source_module = v_source_module AND cfe.source_id = v_source_id;
          DELETE FROM cash_flow_entries cfe
          WHERE cfe.source_module = v_person_source_module AND cfe.source_id = v_source_id;
          RETURN NEW;
        END IF;

        v_month_id := ensure_site_cashflow_month(v_site_id, v_entry_date, v_created_by);

        INSERT INTO cash_flow_entries (
          cash_flow_month_id, site_id, date, particular, debit, credit, cash_type, remarks,
          created_by, assigned_admin_id, source_module, source_id, voucher_url, status, approved_by, approved_at
        ) VALUES (
          v_month_id, v_site_id, v_entry_date, v_particular, v_debit, v_credit, v_cash_type, v_remarks,
          v_created_by, v_assigned_admin_id, v_source_module, v_source_id, v_voucher_url, v_status, v_approved_by, v_approved_at
        )
        ON CONFLICT (source_module, source_id)
        DO UPDATE SET
          cash_flow_month_id = EXCLUDED.cash_flow_month_id,
          site_id = EXCLUDED.site_id,
          date = EXCLUDED.date,
          particular = EXCLUDED.particular,
          debit = EXCLUDED.debit,
          credit = EXCLUDED.credit,
          cash_type = EXCLUDED.cash_type,
          remarks = EXCLUDED.remarks,
          created_by = EXCLUDED.created_by,
          assigned_admin_id = EXCLUDED.assigned_admin_id,
          voucher_url = EXCLUDED.voucher_url,
          status = EXCLUDED.status,
          approved_by = EXCLUDED.approved_by,
          approved_at = EXCLUDED.approved_at,
          updated_at = NOW();

        -- ── person-ledger mirror (new in migration 076) ──
        IF v_mapped_member_id IS NOT NULL OR v_mapped_user_id IS NOT NULL THEN
          IF v_mapped_member_id IS NOT NULL THEN
            SELECT full_name INTO v_person_display_name FROM members WHERE id = v_mapped_member_id;
          ELSE
            SELECT COALESCE(name, email) INTO v_person_display_name FROM users WHERE id = v_mapped_user_id;
          END IF;

          v_person_month_id := ensure_person_cashflow_month(
            v_site_id, v_entry_date, v_mapped_member_id, v_mapped_user_id, v_person_display_name, v_created_by
          );

          INSERT INTO cash_flow_entries (
            cash_flow_month_id, site_id, date, particular, debit, credit, cash_type, remarks,
            created_by, assigned_admin_id, source_module, source_id, voucher_url, status, approved_by, approved_at
          ) VALUES (
            v_person_month_id, v_site_id, v_entry_date, v_particular, v_debit, v_credit, v_cash_type, v_remarks,
            v_created_by, v_assigned_admin_id, v_person_source_module, v_source_id, v_voucher_url, v_status, v_approved_by, v_approved_at
          )
          ON CONFLICT (source_module, source_id)
          DO UPDATE SET
            cash_flow_month_id = EXCLUDED.cash_flow_month_id,
            site_id = EXCLUDED.site_id,
            date = EXCLUDED.date,
            particular = EXCLUDED.particular,
            debit = EXCLUDED.debit,
            credit = EXCLUDED.credit,
            cash_type = EXCLUDED.cash_type,
            remarks = EXCLUDED.remarks,
            created_by = EXCLUDED.created_by,
            assigned_admin_id = EXCLUDED.assigned_admin_id,
            voucher_url = EXCLUDED.voucher_url,
            status = EXCLUDED.status,
            approved_by = EXCLUDED.approved_by,
            approved_at = EXCLUDED.approved_at,
            updated_at = NOW();
        ELSE
          -- No person mapped (or mapping was cleared on UPDATE) — drop any stale mirror.
          DELETE FROM cash_flow_entries cfe
          WHERE cfe.source_module = v_person_source_module AND cfe.source_id = v_source_id;
        END IF;

        RETURN NEW;
      END;
      $$;


--
-- Name: sync_cashflow_status_from_source(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.sync_cashflow_status_from_source() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
      BEGIN
        IF TG_TABLE_NAME = 'day_book' THEN
          UPDATE cash_flow_entries cfe
          SET
            status = COALESCE(NEW.status, cfe.status),
            approved_by = NEW.approved_by,
            approved_at = NEW.approved_at,
            assigned_admin_id = NEW.assigned_admin_id,
            updated_at = NOW()
          WHERE cfe.source_module = 'day_book'
            AND cfe.source_id = NEW.id;

        ELSIF TG_TABLE_NAME = 'expenses' THEN
          UPDATE cash_flow_entries cfe
          SET
            status = COALESCE(NEW.status, cfe.status),
            approved_by = NEW.approved_by,
            approved_at = NEW.approved_at,
            voucher_url = COALESCE(NEW.voucher_url, cfe.voucher_url),
            updated_at = NOW()
          WHERE cfe.source_module = 'expenses'
            AND cfe.source_id = NEW.id;

        ELSIF TG_TABLE_NAME = 'firm_transactions' THEN
          UPDATE cash_flow_entries cfe
          SET
            status = COALESCE(NEW.status, cfe.status),
            voucher_url = COALESCE(NEW.voucher_url, cfe.voucher_url),
            updated_at = NOW()
          WHERE cfe.source_module = 'firm_transactions'
            AND cfe.source_id = NEW.id;

        ELSIF TG_TABLE_NAME = 'plot_payments' THEN
          UPDATE cash_flow_entries cfe
          SET
            status = COALESCE(NEW.status, cfe.status),
            voucher_url = COALESCE(NEW.voucher_url, cfe.voucher_url),
            updated_at = NOW()
          WHERE cfe.source_module = 'plot_payments'
            AND cfe.source_id = NEW.id;

        ELSIF TG_TABLE_NAME = 'vendor_payments' THEN
          UPDATE cash_flow_entries cfe
          SET
            status = COALESCE(NEW.status, cfe.status),
            approved_by = NEW.approved_by,
            approved_at = NEW.approved_at,
            voucher_url = COALESCE(NEW.voucher_url, cfe.voucher_url),
            updated_at = NOW()
          WHERE cfe.source_module = 'vendor_payments'
            AND cfe.source_id = NEW.id;
        END IF;

        RETURN NEW;
      END;
      $$;


--
-- Name: sync_daybook_from_vendor_payments(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.sync_daybook_from_vendor_payments() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
      DECLARE
        v_vendor_name VARCHAR(255);
      BEGIN
        SELECT COALESCE(vc.vendor_name, 'VENDOR') INTO v_vendor_name
        FROM vendor_commitments vc
        WHERE vc.id = NEW.commitment_id;

        IF TG_OP = 'INSERT' THEN
          INSERT INTO day_book (
            site_id, date, particular, entry_type,
            debit, credit, remarks, payment_mode,
            category, from_entity, to_entity,
            status, approved_by, approved_at,
            vendor_payment_id, created_by
          ) VALUES (
            NEW.site_id,
            COALESCE(NEW.payment_date, CURRENT_DATE),
            ('VENDOR PAYMENT - ' || COALESCE(v_vendor_name, 'VENDOR'))::VARCHAR(500),
            'VENDOR PAYMENT',
            COALESCE(NEW.amount, 0),
            0,
            NEW.note,
            UPPER(COALESCE(NEW.payment_mode, 'CASH')),
            'VENDOR',
            'COMPANY',
            COALESCE(v_vendor_name, NEW.reference_no, 'VENDOR'),
            COALESCE(NEW.status, 'pending'),
            NEW.approved_by,
            NEW.approved_at,
            NEW.id,
            NEW.created_by
          )
          ON CONFLICT DO NOTHING;
        ELSE
          UPDATE day_book db
          SET
            site_id = NEW.site_id,
            date = COALESCE(NEW.payment_date, db.date),
            particular = ('VENDOR PAYMENT - ' || COALESCE(v_vendor_name, 'VENDOR'))::VARCHAR(500),
            debit = COALESCE(NEW.amount, 0),
            credit = 0,
            remarks = NEW.note,
            payment_mode = UPPER(COALESCE(NEW.payment_mode, db.payment_mode, 'CASH')),
            category = 'VENDOR',
            from_entity = 'COMPANY',
            to_entity = COALESCE(v_vendor_name, db.to_entity),
            status = COALESCE(NEW.status, db.status),
            approved_by = NEW.approved_by,
            approved_at = NEW.approved_at,
            updated_at = NOW()
          WHERE db.vendor_payment_id = NEW.id;
        END IF;

        RETURN NEW;
      END;
      $$;


--
-- Name: sync_vendor_inventory_order(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.sync_vendor_inventory_order() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
      DECLARE
        v_order_id INTEGER;
        v_paid     NUMERIC(14,2);
        v_rcvd     NUMERIC(14,3);
        v_ordered  NUMERIC(14,3);
        v_net      NUMERIC(14,2);
        v_status   VARCHAR(20);
      BEGIN
        -- determine order_id from whichever table fired
        IF TG_TABLE_NAME = 'vendor_inventory_payments' THEN
          v_order_id := COALESCE(NEW.order_id, OLD.order_id);
        ELSE
          v_order_id := COALESCE(NEW.order_id, OLD.order_id);
        END IF;

        SELECT COALESCE(SUM(amount), 0) INTO v_paid
        FROM vendor_inventory_payments WHERE order_id = v_order_id;

        SELECT COALESCE(SUM(qty), 0) INTO v_rcvd
        FROM vendor_inventory_deliveries WHERE order_id = v_order_id;

        SELECT qty_ordered INTO v_ordered
        FROM vendor_inventory_orders WHERE id = v_order_id;

        -- derive net_amount inline (mirrors generated column logic)
        SELECT ROUND(v_rcvd * rate
          - COALESCE(CASE WHEN discount_pct > 0 THEN ROUND(v_rcvd * rate * discount_pct / 100, 2)
                         ELSE discount_amount END, 0), 2)
        INTO v_net
        FROM vendor_inventory_orders WHERE id = v_order_id;

        -- status logic
        IF v_rcvd = 0 THEN
          v_status := 'open';
        ELSIF v_rcvd >= v_ordered THEN
          v_status := 'completed';
        ELSE
          v_status := 'partial';
        END IF;

        UPDATE vendor_inventory_orders
        SET total_paid   = v_paid,
            qty_received = v_rcvd,
            status       = v_status,
            updated_at   = CURRENT_TIMESTAMP
        WHERE id = v_order_id;

        RETURN NULL;
      END;
      $$;


--
-- Name: update_modified_column(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.update_modified_column() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
      BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
      $$;


--
-- Name: update_updated_at_column(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.update_updated_at_column() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: agent_activity_log; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.agent_activity_log (
    id integer NOT NULL,
    actor_user_id integer,
    target_user_id integer,
    action text NOT NULL,
    detail jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: agent_activity_log_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.agent_activity_log_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: agent_activity_log_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.agent_activity_log_id_seq OWNED BY public.agent_activity_log.id;


--
-- Name: agent_ledger_entries; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.agent_ledger_entries (
    id integer NOT NULL,
    user_id integer NOT NULL,
    entry_type text NOT NULL,
    direction text NOT NULL,
    amount numeric(14,2) NOT NULL,
    status text DEFAULT 'PENDING'::text NOT NULL,
    booking_id integer,
    plot_id integer,
    site_id integer,
    narration text,
    meta jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_by integer,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT agent_ledger_entries_amount_check CHECK ((amount >= (0)::numeric)),
    CONSTRAINT agent_ledger_entries_direction_check CHECK ((direction = ANY (ARRAY['CREDIT'::text, 'DEBIT'::text])))
);


--
-- Name: agent_ledger_entries_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.agent_ledger_entries_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: agent_ledger_entries_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.agent_ledger_entries_id_seq OWNED BY public.agent_ledger_entries.id;


--
-- Name: application_settings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.application_settings (
    id integer NOT NULL,
    site_id integer NOT NULL,
    setting_key character varying(100) NOT NULL,
    setting_value jsonb NOT NULL,
    updated_by integer,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    updated_at timestamp without time zone DEFAULT now() NOT NULL
);


--
-- Name: application_settings_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.application_settings_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: application_settings_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.application_settings_id_seq OWNED BY public.application_settings.id;


--
-- Name: bookings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.bookings (
    id integer NOT NULL,
    site_id integer NOT NULL,
    plot_id integer,
    client_member_id integer,
    booking_no character varying(40),
    booking_date date DEFAULT CURRENT_DATE NOT NULL,
    sale_price numeric(15,2) DEFAULT 0 NOT NULL,
    token_amount numeric(15,2) DEFAULT 0 NOT NULL,
    payment_plan character varying(20) DEFAULT 'FULL'::character varying NOT NULL,
    status character varying(20) DEFAULT 'DRAFT'::character varying NOT NULL,
    kyc_status character varying(20) DEFAULT 'NOT_STARTED'::character varying NOT NULL,
    buyer_name character varying(255),
    booked_by character varying(255),
    notes text,
    created_by integer,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    booking_agent_id integer,
    token_payment_id integer,
    token_payment_from character varying(100) DEFAULT 'CASH'::character varying,
    token_payment_date date,
    token_bank_name character varying(150),
    token_branch character varying(150),
    token_bank_details character varying(255),
    token_cheque_no character varying(50),
    token_narration text,
    token_received_by character varying(255),
    agent_user_id integer,
    team_id integer,
    CONSTRAINT bookings_kyc_status_check CHECK (((kyc_status)::text = ANY ((ARRAY['NOT_STARTED'::character varying, 'OCR_PENDING'::character varying, 'OCR_DONE'::character varying, 'VERIFIED'::character varying, 'REJECTED'::character varying])::text[]))),
    CONSTRAINT bookings_payment_plan_check CHECK (((payment_plan)::text = ANY ((ARRAY['FULL'::character varying, 'INSTALLMENT'::character varying])::text[]))),
    CONSTRAINT bookings_status_check CHECK (((status)::text = ANY ((ARRAY['DRAFT'::character varying, 'KYC_PENDING'::character varying, 'KYC_DONE'::character varying, 'CONFIRMED'::character varying, 'CANCELLED'::character varying])::text[])))
);


--
-- Name: bookings_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.bookings_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: bookings_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.bookings_id_seq OWNED BY public.bookings.id;


--
-- Name: cash_flow_entries; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.cash_flow_entries (
    id integer NOT NULL,
    cash_flow_month_id integer NOT NULL,
    site_id integer NOT NULL,
    date date DEFAULT CURRENT_DATE NOT NULL,
    particular character varying(500) NOT NULL,
    debit numeric(15,2) DEFAULT 0 NOT NULL,
    credit numeric(15,2) DEFAULT 0 NOT NULL,
    remarks text,
    created_by integer,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    cash_type character varying(20) DEFAULT 'bank'::character varying NOT NULL,
    voucher_url character varying(1000),
    status character varying(20) DEFAULT 'pending'::character varying NOT NULL,
    approved_by integer,
    approved_at timestamp with time zone,
    is_firm_transaction boolean DEFAULT false NOT NULL,
    from_firm_id integer,
    to_firm_id integer,
    to_name character varying(255),
    source_module character varying(50),
    source_id integer,
    assigned_admin_id integer,
    cheque_status character varying(20) DEFAULT NULL::character varying,
    cheque_no character varying(50) DEFAULT NULL::character varying,
    customer_signature_url text,
    authority_signature_url text,
    CONSTRAINT cash_flow_entries_cash_type_check CHECK (((cash_type)::text = ANY ((ARRAY['cash'::character varying, 'bank'::character varying, 'cheque'::character varying])::text[])))
);


--
-- Name: cash_flow_entries_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.cash_flow_entries_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: cash_flow_entries_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.cash_flow_entries_id_seq OWNED BY public.cash_flow_entries.id;


--
-- Name: cash_flow_months; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.cash_flow_months (
    id integer NOT NULL,
    site_id integer NOT NULL,
    month integer NOT NULL,
    year integer NOT NULL,
    opening_balance numeric(15,2) DEFAULT 0 NOT NULL,
    notes text,
    is_locked boolean DEFAULT false,
    created_by integer,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    ledger_name character varying(255),
    ledger_type character varying(20) DEFAULT 'site'::character varying,
    linked_user_id integer,
    linked_member_id integer,
    CONSTRAINT cash_flow_months_ledger_type_check CHECK (((ledger_type)::text = ANY ((ARRAY['site'::character varying, 'person'::character varying])::text[]))),
    CONSTRAINT cash_flow_months_month_check CHECK (((month >= 1) AND (month <= 12)))
);


--
-- Name: cash_flow_months_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.cash_flow_months_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: cash_flow_months_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.cash_flow_months_id_seq OWNED BY public.cash_flow_months.id;


--
-- Name: construction_material_request_items; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.construction_material_request_items (
    id integer NOT NULL,
    request_id integer NOT NULL,
    material_id integer NOT NULL,
    qty_requested numeric(15,3) NOT NULL,
    qty_issued numeric(15,3) DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT construction_material_request_items_qty_requested_check CHECK ((qty_requested > (0)::numeric))
);


--
-- Name: construction_material_request_items_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.construction_material_request_items_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: construction_material_request_items_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.construction_material_request_items_id_seq OWNED BY public.construction_material_request_items.id;


--
-- Name: construction_material_requests; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.construction_material_requests (
    id integer NOT NULL,
    site_id integer NOT NULL,
    project_id integer NOT NULL,
    task_id integer,
    status character varying(24) DEFAULT 'REQUESTED'::character varying NOT NULL,
    note text,
    requested_by integer,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT construction_material_requests_status_check CHECK (((status)::text = ANY ((ARRAY['DRAFT'::character varying, 'REQUESTED'::character varying, 'PARTIALLY_FULFILLED'::character varying, 'FULFILLED'::character varying, 'CANCELLED'::character varying])::text[])))
);


--
-- Name: construction_material_requests_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.construction_material_requests_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: construction_material_requests_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.construction_material_requests_id_seq OWNED BY public.construction_material_requests.id;


--
-- Name: construction_projects; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.construction_projects (
    id integer NOT NULL,
    site_id integer NOT NULL,
    name character varying(255) NOT NULL,
    code character varying(60),
    status character varying(20) DEFAULT 'PLANNING'::character varying NOT NULL,
    start_date date,
    target_end_date date,
    actual_end_date date,
    budget numeric(15,2) DEFAULT 0 NOT NULL,
    progress_pct integer DEFAULT 0 NOT NULL,
    notes text,
    assigned_admin_id integer,
    created_by integer,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT construction_projects_progress_pct_check CHECK (((progress_pct >= 0) AND (progress_pct <= 100))),
    CONSTRAINT construction_projects_status_check CHECK (((status)::text = ANY ((ARRAY['PLANNING'::character varying, 'ACTIVE'::character varying, 'ON_HOLD'::character varying, 'DELAYED'::character varying, 'COMPLETED'::character varying, 'CANCELLED'::character varying])::text[])))
);


--
-- Name: construction_projects_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.construction_projects_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: construction_projects_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.construction_projects_id_seq OWNED BY public.construction_projects.id;


--
-- Name: construction_tasks; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.construction_tasks (
    id integer NOT NULL,
    project_id integer NOT NULL,
    name character varying(255) NOT NULL,
    status character varying(20) DEFAULT 'PENDING'::character varying NOT NULL,
    progress_pct integer DEFAULT 0 NOT NULL,
    sequence integer DEFAULT 0 NOT NULL,
    start_date date,
    due_date date,
    created_by integer,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT construction_tasks_progress_pct_check CHECK (((progress_pct >= 0) AND (progress_pct <= 100))),
    CONSTRAINT construction_tasks_status_check CHECK (((status)::text = ANY ((ARRAY['PENDING'::character varying, 'IN_PROGRESS'::character varying, 'BLOCKED'::character varying, 'DONE'::character varying])::text[])))
);


--
-- Name: construction_tasks_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.construction_tasks_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: construction_tasks_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.construction_tasks_id_seq OWNED BY public.construction_tasks.id;


--
-- Name: conversations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.conversations (
    id integer NOT NULL,
    user1_id integer,
    user2_id integer,
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP
);


--
-- Name: conversations_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.conversations_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: conversations_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.conversations_id_seq OWNED BY public.conversations.id;


--
-- Name: dashboard_component_permissions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.dashboard_component_permissions (
    id integer NOT NULL,
    user_id integer NOT NULL,
    component character varying(60) NOT NULL,
    allowed boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: dashboard_component_permissions_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.dashboard_component_permissions_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: dashboard_component_permissions_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.dashboard_component_permissions_id_seq OWNED BY public.dashboard_component_permissions.id;


--
-- Name: day_book; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.day_book (
    id integer NOT NULL,
    site_id integer NOT NULL,
    date date DEFAULT CURRENT_DATE NOT NULL,
    particular character varying(500) NOT NULL,
    entry_type character varying(50) DEFAULT 'GENERAL'::character varying NOT NULL,
    debit numeric(15,2) DEFAULT 0 NOT NULL,
    credit numeric(15,2) DEFAULT 0 NOT NULL,
    remarks text,
    payment_mode character varying(50),
    category character varying(100),
    from_entity character varying(255),
    to_entity character varying(255),
    account_no character varying(100),
    branch character varying(255),
    created_by integer,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    farmer_payment_id integer,
    commission_id integer,
    cash_flow_entry_id integer,
    firm_transaction_id integer,
    plot_payment_id integer,
    status character varying(20) DEFAULT 'pending'::character varying NOT NULL,
    approved_by integer,
    approved_at timestamp with time zone,
    imprest_allocation_id integer,
    assigned_user_id integer,
    voucher_url character varying(1000),
    vendor_payment_id integer,
    assigned_admin_id integer,
    cheque_status character varying(20) DEFAULT NULL::character varying,
    cheque_no character varying(50) DEFAULT NULL::character varying,
    customer_signature_url text,
    authority_signature_url text,
    mapped_member_id integer,
    mapped_user_id integer,
    CONSTRAINT day_book_entry_type_check CHECK (((entry_type)::text = ANY ((ARRAY['GENERAL'::character varying, 'EXPENSE'::character varying, 'INCOME'::character varying, 'PAYMENT'::character varying, 'RECEIPT'::character varying, 'TRANSFER'::character varying, 'ADJUSTMENT'::character varying, 'OTHER'::character varying, 'FARMER PAYMENT'::character varying, 'PLOT COMMISSION'::character varying, 'CASH FLOW'::character varying, 'FIRM TRANSACTION'::character varying, 'PLOT PAYMENT'::character varying, 'IMPREST'::character varying, 'VENDOR PAYMENT'::character varying])::text[]))),
    CONSTRAINT day_book_status_check CHECK (((status)::text = ANY ((ARRAY['pending'::character varying, 'approved'::character varying, 'rejected'::character varying])::text[])))
);


--
-- Name: day_book_daily_balance; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.day_book_daily_balance (
    id integer NOT NULL,
    site_id integer NOT NULL,
    date date NOT NULL,
    opening_balance numeric(14,2) DEFAULT 0 NOT NULL,
    closing_balance numeric(14,2) DEFAULT 0 NOT NULL,
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    updated_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP
);


--
-- Name: day_book_daily_balance_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.day_book_daily_balance_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: day_book_daily_balance_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.day_book_daily_balance_id_seq OWNED BY public.day_book_daily_balance.id;


--
-- Name: day_book_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.day_book_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: day_book_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.day_book_id_seq OWNED BY public.day_book.id;


--
-- Name: document_imprest; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.document_imprest (
    id integer NOT NULL,
    document_name text NOT NULL,
    description text,
    receiver_user_id integer,
    receiver_name text,
    issued_by integer,
    photo_key text NOT NULL,
    expected_return_at timestamp with time zone,
    status character varying(12) DEFAULT 'ISSUED'::character varying NOT NULL,
    remarks text,
    returned_at timestamp with time zone,
    return_photo_key text,
    return_received_by integer,
    return_remarks text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    site_id integer
);


--
-- Name: document_imprest_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.document_imprest_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: document_imprest_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.document_imprest_id_seq OWNED BY public.document_imprest.id;


--
-- Name: documents; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.documents (
    id integer NOT NULL,
    kyc_case_id integer,
    client_member_id integer,
    site_id integer,
    type character varying(40) DEFAULT 'OTHER'::character varying NOT NULL,
    file_path text NOT NULL,
    file_hash character varying(80),
    mime_type character varying(120),
    file_size integer,
    ocr_status character varying(20) DEFAULT 'PENDING'::character varying NOT NULL,
    ocr_job_id character varying(120),
    ocr_engine character varying(40),
    ocr_error text,
    ocr_started_at timestamp with time zone,
    ocr_completed_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    plot_id integer,
    original_name text,
    title text,
    category character varying(40),
    uploaded_source character varying(20) DEFAULT 'BOOKING'::character varying,
    uploaded_by integer,
    member_document_field character varying(40),
    metadata jsonb,
    ocr_text text,
    doc_date date,
    expiry_date date,
    search_tsv tsvector GENERATED ALWAYS AS ((to_tsvector('simple'::regconfig, ((((((COALESCE(title, ''::text) || ' '::text) || COALESCE(original_name, ''::text)) || ' '::text) || (COALESCE(category, ''::character varying))::text) || ' '::text) || COALESCE(ocr_text, ''::text))) || jsonb_to_tsvector('simple'::regconfig, COALESCE(metadata, '{}'::jsonb), '["string", "numeric"]'::jsonb))) STORED,
    CONSTRAINT documents_ocr_status_check CHECK (((ocr_status)::text = ANY ((ARRAY['PENDING'::character varying, 'PROCESSING'::character varying, 'DONE'::character varying, 'FAILED'::character varying])::text[]))),
    CONSTRAINT documents_type_check CHECK (((type)::text = ANY ((ARRAY['AADHAAR'::character varying, 'PAN'::character varying, 'PHOTO'::character varying, 'CHEQUE'::character varying, 'VOTER_ID'::character varying, 'PASSPORT'::character varying, 'DL'::character varying, 'DOMICILE'::character varying, 'INCOME'::character varying, 'FINAL_APPROVED_BOOKED_FORM'::character varying, 'KYC_FORM'::character varying, 'FINAL_BOOKING_FORM'::character varying, 'CO_APPLICANT_PHOTO'::character varying, 'OTHER'::character varying])::text[])))
);


--
-- Name: documents_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.documents_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: documents_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.documents_id_seq OWNED BY public.documents.id;


--
-- Name: draw_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.draw_events (
    id integer NOT NULL,
    draw_registration_id integer NOT NULL,
    event_type character varying(40) NOT NULL,
    detail jsonb,
    actor_user_id integer,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: draw_events_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.draw_events_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: draw_events_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.draw_events_id_seq OWNED BY public.draw_events.id;


--
-- Name: draw_payments; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.draw_payments (
    id integer NOT NULL,
    draw_registration_id integer NOT NULL,
    receipt_no character varying(40),
    amount numeric(15,2) NOT NULL,
    payment_date date DEFAULT CURRENT_DATE NOT NULL,
    payment_from character varying(100) DEFAULT 'CASH'::character varying,
    bank_name character varying(150),
    branch character varying(150),
    bank_details character varying(255),
    cheque_no character varying(50),
    narration text,
    received_by character varying(255),
    created_by integer,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    plot_payment_id integer,
    CONSTRAINT draw_payments_amount_check CHECK ((amount > (0)::numeric))
);


--
-- Name: draw_payments_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.draw_payments_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: draw_payments_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.draw_payments_id_seq OWNED BY public.draw_payments.id;


--
-- Name: draw_registrations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.draw_registrations (
    id integer NOT NULL,
    registration_no character varying(40),
    site_id integer NOT NULL,
    client_member_id integer NOT NULL,
    scheme_name character varying(150),
    required_amount numeric(15,2) DEFAULT 0 NOT NULL,
    status character varying(20) DEFAULT 'REGISTERED'::character varying NOT NULL,
    qr_token character varying(64) NOT NULL,
    slip_no character varying(40),
    slip_issued_at timestamp with time zone,
    slip_issued_by integer,
    is_winner boolean DEFAULT false NOT NULL,
    winner_marked_at timestamp with time zone,
    winner_marked_by integer,
    allotted_plot_id integer,
    allotted_at timestamp with time zone,
    allotted_by integer,
    booking_id integer,
    agent_user_id integer,
    notes text,
    created_by integer,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    kyc_case_id integer,
    CONSTRAINT draw_registrations_required_amount_check CHECK ((required_amount >= (0)::numeric)),
    CONSTRAINT draw_registrations_status_check CHECK (((status)::text = ANY ((ARRAY['REGISTERED'::character varying, 'ELIGIBLE'::character varying, 'SLIP_ISSUED'::character varying, 'WINNER'::character varying, 'ALLOTTED'::character varying, 'CANCELLED'::character varying])::text[])))
);


--
-- Name: draw_registrations_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.draw_registrations_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: draw_registrations_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.draw_registrations_id_seq OWNED BY public.draw_registrations.id;


--
-- Name: edit_requests; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.edit_requests (
    id integer NOT NULL,
    requested_by integer NOT NULL,
    site_id integer,
    module character varying(50) NOT NULL,
    record_id integer NOT NULL,
    original_data jsonb DEFAULT '{}'::jsonb NOT NULL,
    proposed_data jsonb DEFAULT '{}'::jsonb NOT NULL,
    proof_photo_url text,
    status character varying(20) DEFAULT 'pending'::character varying NOT NULL,
    reviewed_by integer,
    reviewed_at timestamp without time zone,
    rejection_reason text,
    created_at timestamp without time zone DEFAULT now(),
    updated_at timestamp without time zone DEFAULT now(),
    review_photo_url text
);


--
-- Name: edit_requests_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.edit_requests_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: edit_requests_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.edit_requests_id_seq OWNED BY public.edit_requests.id;


--
-- Name: excel_files; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.excel_files (
    id integer NOT NULL,
    name character varying(255) DEFAULT 'Untitled Spreadsheet'::character varying NOT NULL,
    created_by integer,
    updated_by integer,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    s3_key character varying(255),
    size_bytes integer,
    folder_id integer,
    file_type character varying(20) DEFAULT 'excel'::character varying,
    site_id integer
);


--
-- Name: excel_files_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.excel_files_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: excel_files_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.excel_files_id_seq OWNED BY public.excel_files.id;


--
-- Name: expense_categories; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.expense_categories (
    id integer NOT NULL,
    name character varying(100) NOT NULL,
    icon character varying(50) DEFAULT 'Tag'::character varying,
    color character varying(30) DEFAULT 'slate'::character varying,
    grp character varying(80) DEFAULT 'Custom'::character varying,
    created_at timestamp without time zone DEFAULT now()
);


--
-- Name: expense_categories_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.expense_categories_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: expense_categories_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.expense_categories_id_seq OWNED BY public.expense_categories.id;


--
-- Name: expenses; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.expenses (
    id integer NOT NULL,
    site_id integer NOT NULL,
    date date DEFAULT CURRENT_DATE NOT NULL,
    from_entity character varying(255),
    to_entity character varying(255),
    payment_mode character varying(50),
    debit numeric(15,2) DEFAULT 0 NOT NULL,
    credit numeric(15,2) DEFAULT 0 NOT NULL,
    remark text,
    account_no character varying(100),
    branch character varying(255),
    category character varying(100),
    created_by integer,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    status character varying(20) DEFAULT 'pending'::character varying NOT NULL,
    approved_by integer,
    approved_at timestamp with time zone,
    assigned_user_id integer,
    voucher_url character varying(1000),
    assigned_admin_id integer,
    bill_url text,
    cheque_status character varying(20) DEFAULT NULL::character varying,
    cheque_no character varying(50) DEFAULT NULL::character varying,
    customer_signature_url text,
    authority_signature_url text,
    mapped_member_id integer,
    mapped_user_id integer,
    CONSTRAINT expenses_status_check CHECK (((status)::text = ANY ((ARRAY['pending'::character varying, 'approved'::character varying, 'rejected'::character varying])::text[])))
);


--
-- Name: expenses_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.expenses_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: expenses_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.expenses_id_seq OWNED BY public.expenses.id;


--
-- Name: farmer_payments; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.farmer_payments (
    id integer NOT NULL,
    farmer_id integer NOT NULL,
    date date DEFAULT CURRENT_DATE NOT NULL,
    particular character varying(255) NOT NULL,
    amount numeric(15,2) DEFAULT 0 NOT NULL,
    by_note character varying(500),
    interest_rate numeric(5,2) DEFAULT 0,
    interest_amount numeric(15,2) DEFAULT 0,
    remarks text,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    payment_mode character varying(20) DEFAULT 'CASH'::character varying,
    cash_amount numeric(15,2) DEFAULT 0,
    bank_amount numeric(15,2) DEFAULT 0,
    bank_name character varying(255),
    bank_account_no character varying(100),
    bank_reference character varying(255),
    bank_ifsc character varying(20),
    voucher_url character varying(1000),
    status character varying(20) DEFAULT 'pending'::character varying NOT NULL,
    approved_by integer,
    approved_at timestamp with time zone,
    assigned_admin_id integer,
    cheque_status character varying(20) DEFAULT NULL::character varying,
    cheque_no character varying(50) DEFAULT NULL::character varying,
    created_by integer,
    customer_signature_url text,
    authority_signature_url text,
    mapped_member_id integer,
    mapped_user_id integer
);


--
-- Name: farmer_payments_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.farmer_payments_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: farmer_payments_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.farmer_payments_id_seq OWNED BY public.farmer_payments.id;


--
-- Name: farmers; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.farmers (
    id integer NOT NULL,
    name character varying(255) NOT NULL,
    phone character varying(20),
    address text,
    total_amount numeric(15,2) DEFAULT 0 NOT NULL,
    interest_rate numeric(5,2) DEFAULT 0 NOT NULL,
    site_id integer,
    created_by integer,
    notes text,
    status character varying(20) DEFAULT 'active'::character varying NOT NULL,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    member_id integer,
    payment_mode character varying(10) DEFAULT 'CASH'::character varying,
    cash_amount numeric(15,2) DEFAULT 0,
    bank_amount numeric(15,2) DEFAULT 0,
    bank_name character varying(255),
    bank_account_no character varying(50),
    bank_reference character varying(100),
    bank_ifsc character varying(20),
    land_size_bigha numeric(10,2) DEFAULT NULL::numeric,
    land_rate numeric(15,2) DEFAULT NULL::numeric,
    commission_percentage numeric(5,2) DEFAULT NULL::numeric,
    commission_amount numeric(15,2) DEFAULT NULL::numeric,
    CONSTRAINT farmers_status_check CHECK (((status)::text = ANY ((ARRAY['active'::character varying, 'completed'::character varying, 'inactive'::character varying])::text[])))
);


--
-- Name: farmers_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.farmers_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: farmers_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.farmers_id_seq OWNED BY public.farmers.id;


--
-- Name: file_folders; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.file_folders (
    id integer NOT NULL,
    name character varying(255) NOT NULL,
    parent_id integer,
    created_by integer,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    site_id integer
);


--
-- Name: file_folders_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.file_folders_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: file_folders_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.file_folders_id_seq OWNED BY public.file_folders.id;


--
-- Name: firm_transactions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.firm_transactions (
    id integer NOT NULL,
    firm_id integer NOT NULL,
    site_id integer NOT NULL,
    date date DEFAULT CURRENT_DATE NOT NULL,
    description text NOT NULL,
    debit numeric(15,2) DEFAULT 0 NOT NULL,
    credit numeric(15,2) DEFAULT 0 NOT NULL,
    name character varying(255),
    purpose character varying(500),
    remark character varying(100),
    cheque_no character varying(50),
    created_by integer,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    cash_flow_entry_id integer,
    voucher_url character varying(1000),
    status character varying(20) DEFAULT 'pending'::character varying NOT NULL,
    approved_by integer,
    approved_at timestamp with time zone,
    payment_mode character varying(20) DEFAULT 'cash'::character varying NOT NULL,
    assigned_admin_id integer,
    is_firm_to_firm_transfer boolean DEFAULT false NOT NULL,
    transfer_to_site_id integer,
    transfer_to_firm_id integer,
    transfer_group_id character varying(80),
    transfer_direction character varying(10),
    transaction_no character varying(50),
    cheque_status character varying(20) DEFAULT NULL::character varying,
    remark2 character varying(255),
    mapped_member_id integer,
    mapped_user_id integer,
    CONSTRAINT firm_transactions_payment_mode_check CHECK (((payment_mode)::text = ANY ((ARRAY['cash'::character varying, 'bank'::character varying, 'cheque'::character varying])::text[]))),
    CONSTRAINT firm_transactions_transfer_direction_check CHECK (((transfer_direction IS NULL) OR ((transfer_direction)::text = ANY ((ARRAY['OUT'::character varying, 'IN'::character varying])::text[]))))
);


--
-- Name: firm_transactions_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.firm_transactions_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: firm_transactions_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.firm_transactions_id_seq OWNED BY public.firm_transactions.id;


--
-- Name: firms; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.firms (
    id integer NOT NULL,
    site_id integer NOT NULL,
    name character varying(255) NOT NULL,
    account_number character varying(50),
    bank_name character varying(255),
    ifsc_code character varying(20),
    notes text,
    created_by integer,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    opening_balance numeric(15,2) DEFAULT 0 NOT NULL
);


--
-- Name: firms_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.firms_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: firms_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.firms_id_seq OWNED BY public.firms.id;


--
-- Name: imprest_allocations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.imprest_allocations (
    id integer NOT NULL,
    admin_id integer NOT NULL,
    sub_admin_id integer NOT NULL,
    amount numeric(15,2) NOT NULL,
    remark text,
    status character varying(30) DEFAULT 'PENDING_RECEIPT'::character varying NOT NULL,
    confirmation_remark text,
    created_at timestamp with time zone DEFAULT now(),
    confirmed_at timestamp with time zone,
    updated_at timestamp with time zone DEFAULT now(),
    assigned_admin_id integer,
    site_id integer,
    CONSTRAINT imprest_allocations_status_check CHECK (((status)::text = ANY ((ARRAY['PENDING_RECEIPT'::character varying, 'RECEIVED'::character varying, 'CANCELLED'::character varying])::text[])))
);


--
-- Name: imprest_allocations_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.imprest_allocations_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: imprest_allocations_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.imprest_allocations_id_seq OWNED BY public.imprest_allocations.id;


--
-- Name: imprest_expense_requests; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.imprest_expense_requests (
    id integer NOT NULL,
    sub_admin_id integer NOT NULL,
    site_id integer NOT NULL,
    amount numeric(15,2) NOT NULL,
    expense_data jsonb NOT NULL,
    reason text,
    status character varying(30) DEFAULT 'PENDING'::character varying NOT NULL,
    reviewed_by integer,
    reviewed_at timestamp with time zone,
    review_remark text,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    assigned_admin_id integer,
    request_type character varying(20) DEFAULT 'EXPENSE'::character varying NOT NULL,
    CONSTRAINT imprest_expense_requests_request_type_check CHECK (((request_type)::text = ANY ((ARRAY['IMPREST'::character varying, 'EXPENSE'::character varying])::text[]))),
    CONSTRAINT imprest_expense_requests_status_check CHECK (((status)::text = ANY ((ARRAY['PENDING'::character varying, 'APPROVED'::character varying, 'REJECTED'::character varying])::text[])))
);


--
-- Name: imprest_expense_requests_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.imprest_expense_requests_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: imprest_expense_requests_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.imprest_expense_requests_id_seq OWNED BY public.imprest_expense_requests.id;


--
-- Name: imprest_ledger; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.imprest_ledger (
    id integer NOT NULL,
    user_id integer NOT NULL,
    type character varying(30) NOT NULL,
    reference_id integer,
    amount numeric(15,2) NOT NULL,
    balance_after numeric(15,2) DEFAULT 0 NOT NULL,
    remarks text,
    created_by integer,
    created_at timestamp with time zone DEFAULT now(),
    site_id integer,
    CONSTRAINT imprest_ledger_type_check CHECK (((type)::text = ANY ((ARRAY['ALLOCATION'::character varying, 'EXPENSE'::character varying, 'ADJUSTMENT'::character varying, 'REFUND'::character varying])::text[])))
);


--
-- Name: imprest_ledger_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.imprest_ledger_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: imprest_ledger_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.imprest_ledger_id_seq OWNED BY public.imprest_ledger.id;


--
-- Name: imprest_returns; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.imprest_returns (
    id integer NOT NULL,
    sub_admin_id integer NOT NULL,
    amount numeric(15,2) NOT NULL,
    reason text,
    payment_mode character varying(30) DEFAULT 'CASH'::character varying,
    status character varying(30) DEFAULT 'PENDING'::character varying NOT NULL,
    reviewed_by integer,
    reviewed_at timestamp with time zone,
    review_remark text,
    site_id integer,
    assigned_admin_id integer,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    CONSTRAINT imprest_returns_status_check CHECK (((status)::text = ANY ((ARRAY['PENDING'::character varying, 'ACCEPTED'::character varying, 'REJECTED'::character varying])::text[])))
);


--
-- Name: imprest_returns_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.imprest_returns_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: imprest_returns_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.imprest_returns_id_seq OWNED BY public.imprest_returns.id;


--
-- Name: inventory_materials; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.inventory_materials (
    id integer NOT NULL,
    site_id integer NOT NULL,
    code character varying(60),
    name character varying(255) NOT NULL,
    unit character varying(30) DEFAULT 'NOS'::character varying NOT NULL,
    category character varying(120),
    min_stock numeric(15,3) DEFAULT 0 NOT NULL,
    rate numeric(15,2) DEFAULT 0 NOT NULL,
    notes text,
    is_active boolean DEFAULT true NOT NULL,
    created_by integer,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: inventory_materials_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.inventory_materials_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: inventory_materials_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.inventory_materials_id_seq OWNED BY public.inventory_materials.id;


--
-- Name: inventory_movements; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.inventory_movements (
    id integer NOT NULL,
    site_id integer NOT NULL,
    material_id integer NOT NULL,
    movement_type character varying(16) NOT NULL,
    qty numeric(15,3) NOT NULL,
    rate numeric(15,2) DEFAULT 0 NOT NULL,
    project_id integer,
    task_id integer,
    request_id integer,
    ref_type character varying(40),
    ref_id integer,
    note text,
    created_by integer,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT inventory_movements_movement_type_check CHECK (((movement_type)::text = ANY ((ARRAY['RECEIPT'::character varying, 'ISSUE'::character varying, 'CONSUMPTION'::character varying, 'ADJUSTMENT'::character varying, 'RESERVE'::character varying, 'UNRESERVE'::character varying, 'TRANSFER_IN'::character varying, 'TRANSFER_OUT'::character varying, 'RETURN'::character varying])::text[])))
);


--
-- Name: inventory_movements_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.inventory_movements_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: inventory_movements_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.inventory_movements_id_seq OWNED BY public.inventory_movements.id;


--
-- Name: kyc_cases; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.kyc_cases (
    id integer NOT NULL,
    booking_id integer,
    client_member_id integer,
    site_id integer,
    mode character varying(20) DEFAULT 'MANUAL_OCR'::character varying NOT NULL,
    status character varying(20) DEFAULT 'OPEN'::character varying NOT NULL,
    verified_by integer,
    verified_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    created_by integer,
    qr_token character varying(64),
    CONSTRAINT kyc_cases_mode_check CHECK (((mode)::text = ANY ((ARRAY['MANUAL_OCR'::character varying, 'AADHAAR_EKYC'::character varying])::text[]))),
    CONSTRAINT kyc_cases_status_check CHECK (((status)::text = ANY ((ARRAY['OPEN'::character varying, 'OCR_PENDING'::character varying, 'OCR_DONE'::character varying, 'VERIFIED'::character varying, 'REJECTED'::character varying])::text[])))
);


--
-- Name: kyc_cases_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.kyc_cases_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: kyc_cases_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.kyc_cases_id_seq OWNED BY public.kyc_cases.id;


--
-- Name: login_otps; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.login_otps (
    id integer NOT NULL,
    user_id integer NOT NULL,
    pending_token character varying(64) NOT NULL,
    otp_hash character varying(100) NOT NULL,
    attempts integer DEFAULT 0 NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    consumed_at timestamp with time zone,
    last_sent_at timestamp with time zone DEFAULT now() NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: login_otps_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.login_otps_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: login_otps_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.login_otps_id_seq OWNED BY public.login_otps.id;


--
-- Name: member_categories; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.member_categories (
    id integer NOT NULL,
    name character varying(100) NOT NULL,
    slug character varying(100) NOT NULL,
    description text,
    is_predefined boolean DEFAULT false,
    icon character varying(50),
    color character varying(50),
    created_at timestamp without time zone DEFAULT now(),
    updated_at timestamp without time zone DEFAULT now()
);


--
-- Name: member_categories_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.member_categories_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: member_categories_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.member_categories_id_seq OWNED BY public.member_categories.id;


--
-- Name: members; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.members (
    id integer NOT NULL,
    site_id integer NOT NULL,
    member_type character varying(30) DEFAULT 'CLIENT'::character varying NOT NULL,
    full_name character varying(255) NOT NULL,
    father_name character varying(255),
    photo character varying(500),
    gender character varying(10),
    date_of_birth date,
    blood_group character varying(5),
    phone character varying(20),
    alt_phone character varying(20),
    email character varying(255),
    whatsapp character varying(20),
    address text,
    city character varying(100),
    state character varying(100),
    pincode character varying(10),
    aadhar_no character varying(20),
    pan_no character varying(15),
    voter_id character varying(30),
    bank_name character varying(100),
    account_no character varying(30),
    ifsc_code character varying(15),
    branch character varying(100),
    occupation character varying(100),
    company_name character varying(255),
    reference character varying(255),
    notes text,
    status character varying(20) DEFAULT 'ACTIVE'::character varying NOT NULL,
    created_by integer,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    mother_name character varying(255),
    spouse_name character varying(255),
    nationality character varying(50) DEFAULT 'INDIAN'::character varying,
    religion character varying(50),
    caste character varying(100),
    marital_status character varying(20),
    anniversary_date date,
    qualification character varying(100),
    passport_no character varying(20),
    driving_license_no character varying(30),
    gst_no character varying(20),
    tin_no character varying(20),
    emergency_contact_name character varying(255),
    emergency_contact_phone character varying(20),
    emergency_contact_relation character varying(50),
    nominee_name character varying(255),
    nominee_relation character varying(50),
    nominee_phone character varying(20),
    employee_id character varying(50),
    designation character varying(100),
    department character varying(100),
    date_of_joining date,
    salary numeric(15,2),
    employment_type character varying(30),
    resume_url character varying(500),
    marksheet_10th_url character varying(500),
    marksheet_12th_url character varying(500),
    degree_certificate_url character varying(500),
    experience_certificate_url character varying(500),
    offer_letter_url character varying(500),
    other_certificate_url character varying(500),
    aadhar_front_url character varying(500),
    aadhar_back_url character varying(500),
    pan_card_url character varying(500),
    voter_id_url character varying(500),
    passport_url character varying(500),
    driving_license_url character varying(500),
    cheque_url character varying(500),
    other_kyc_url character varying(500),
    land_area character varying(100),
    crop_type character varying(200),
    farm_location character varying(200),
    irrigation_type character varying(100),
    farming_experience character varying(50),
    license_number character varying(100),
    commission_rate character varying(50),
    operating_areas text,
    business_name character varying(200),
    service_type character varying(200),
    payment_terms character varying(200),
    team character varying(50),
    referred_by_user_id integer,
    co_applicant_name character varying(255),
    co_applicant_relation character varying(50),
    co_applicant_dob date,
    co_applicant_gender character varying(20),
    co_applicant_phone character varying(20),
    co_applicant_email character varying(255),
    co_applicant_aadhar character varying(20),
    co_applicant_pan character varying(20),
    co_applicant_address text,
    permanent_address text,
    CONSTRAINT members_gender_check CHECK (((gender)::text = ANY ((ARRAY['MALE'::character varying, 'FEMALE'::character varying, 'OTHER'::character varying])::text[]))),
    CONSTRAINT members_member_type_check CHECK (((member_type)::text = ANY ((ARRAY['CLIENT'::character varying, 'FARMER'::character varying, 'MEMBER'::character varying, 'BROKER'::character varying, 'PARTNER'::character varying, 'VENDOR'::character varying, 'EMPLOYEE'::character varying, 'OTHER'::character varying])::text[]))),
    CONSTRAINT members_status_check CHECK (((status)::text = ANY ((ARRAY['ACTIVE'::character varying, 'INACTIVE'::character varying, 'BLOCKED'::character varying])::text[])))
);


--
-- Name: members_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.members_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: members_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.members_id_seq OWNED BY public.members.id;


--
-- Name: messages; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.messages (
    id integer NOT NULL,
    conversation_id integer,
    sender_id integer,
    message_text text,
    attachment_url text,
    is_read boolean DEFAULT false,
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP
);


--
-- Name: messages_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.messages_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: messages_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.messages_id_seq OWNED BY public.messages.id;


--
-- Name: ocr_results; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ocr_results (
    id integer NOT NULL,
    document_id integer NOT NULL,
    raw_text jsonb,
    extracted_fields jsonb,
    confidence_overall numeric(6,3),
    confidence_map jsonb,
    engine character varying(40),
    processed_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP
);


--
-- Name: ocr_results_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.ocr_results_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: ocr_results_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.ocr_results_id_seq OWNED BY public.ocr_results.id;


--
-- Name: payment_qrs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.payment_qrs (
    id integer NOT NULL,
    site_id integer NOT NULL,
    upi_account_id integer NOT NULL,
    amount numeric(14,2) NOT NULL,
    note character varying(120),
    txn_ref character varying(40) NOT NULL,
    status character varying(20) DEFAULT 'pending'::character varying NOT NULL,
    received_at timestamp with time zone,
    created_by integer,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT payment_qrs_amount_check CHECK ((amount > (0)::numeric))
);


--
-- Name: payment_qrs_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.payment_qrs_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: payment_qrs_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.payment_qrs_id_seq OWNED BY public.payment_qrs.id;


--
-- Name: plot_commission_payments; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.plot_commission_payments (
    id integer NOT NULL,
    site_id integer,
    plot_commission_id integer,
    date date DEFAULT CURRENT_DATE NOT NULL,
    amount numeric(12,2) DEFAULT 0 NOT NULL,
    balance_after_payment numeric(12,2) DEFAULT 0 NOT NULL,
    payment_mode character varying(20) DEFAULT 'CASH'::character varying,
    bank_name character varying(100),
    transaction_id character varying(100),
    remarks text,
    status character varying(20) DEFAULT 'pending'::character varying,
    voucher_number character varying(50),
    voucher_url text,
    created_by integer,
    approved_by integer,
    approved_at timestamp without time zone,
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    updated_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    assigned_admin_id integer,
    cheque_status character varying(20) DEFAULT NULL::character varying,
    cheque_no character varying(50) DEFAULT NULL::character varying,
    customer_signature_url text,
    authority_signature_url text,
    mapped_member_id integer,
    mapped_user_id integer
);


--
-- Name: plot_commission_payments_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.plot_commission_payments_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: plot_commission_payments_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.plot_commission_payments_id_seq OWNED BY public.plot_commission_payments.id;


--
-- Name: plot_commissions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.plot_commissions (
    id integer NOT NULL,
    site_id integer NOT NULL,
    date date DEFAULT CURRENT_DATE NOT NULL,
    particular character varying(255) NOT NULL,
    plot_no character varying(50),
    amount numeric(15,2) DEFAULT 0 NOT NULL,
    by_note character varying(500),
    remarks text,
    created_by integer,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    plot_size character varying(50),
    plot_rate character varying(50),
    father_name character varying(255),
    voucher_url character varying(1000),
    status character varying(20) DEFAULT 'pending'::character varying NOT NULL,
    approved_by integer,
    approved_at timestamp with time zone,
    assigned_admin_id integer,
    cheque_status character varying(20) DEFAULT NULL::character varying,
    cheque_no character varying(50) DEFAULT NULL::character varying
);


--
-- Name: plot_commissions_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.plot_commissions_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: plot_commissions_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.plot_commissions_id_seq OWNED BY public.plot_commissions.id;


--
-- Name: plot_commissions_v2; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.plot_commissions_v2 (
    id integer NOT NULL,
    site_id integer,
    plot_id integer,
    agent_id integer,
    total_commission numeric(12,2) DEFAULT 0 NOT NULL,
    remarks text,
    status character varying(20) DEFAULT 'Pending'::character varying,
    created_by integer,
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    updated_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP
);


--
-- Name: plot_commissions_v2_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.plot_commissions_v2_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: plot_commissions_v2_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.plot_commissions_v2_id_seq OWNED BY public.plot_commissions_v2.id;


--
-- Name: plot_installment_payments; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.plot_installment_payments (
    id integer NOT NULL,
    installment_id integer NOT NULL,
    plot_id integer NOT NULL,
    amount numeric(15,2) DEFAULT 0 NOT NULL,
    payment_date date DEFAULT CURRENT_DATE NOT NULL,
    payment_mode character varying(50),
    reference character varying(255),
    notes text,
    created_by integer,
    created_at timestamp with time zone DEFAULT now(),
    cheque_status character varying(20) DEFAULT NULL::character varying,
    cheque_no character varying(50) DEFAULT NULL::character varying
);


--
-- Name: plot_installment_payments_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.plot_installment_payments_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: plot_installment_payments_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.plot_installment_payments_id_seq OWNED BY public.plot_installment_payments.id;


--
-- Name: plot_installments; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.plot_installments (
    id integer NOT NULL,
    plot_id integer NOT NULL,
    installment_name character varying(255),
    amount numeric(15,2) DEFAULT 0 NOT NULL,
    due_date date NOT NULL,
    status character varying(20) DEFAULT 'pending'::character varying NOT NULL,
    paid_amount numeric(15,2) DEFAULT 0 NOT NULL,
    interest_amount numeric(15,2) DEFAULT 0 NOT NULL,
    sort_order integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    CONSTRAINT plot_installments_status_check CHECK (((status)::text = ANY ((ARRAY['pending'::character varying, 'partially_paid'::character varying, 'paid'::character varying, 'overdue'::character varying])::text[])))
);


--
-- Name: plot_installments_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.plot_installments_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: plot_installments_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.plot_installments_id_seq OWNED BY public.plot_installments.id;


--
-- Name: plot_payments; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.plot_payments (
    id integer NOT NULL,
    plot_id integer NOT NULL,
    site_id integer NOT NULL,
    date date DEFAULT CURRENT_DATE NOT NULL,
    payment_from character varying(100),
    bank_details character varying(255),
    narration text,
    received_by character varying(255),
    amount numeric(15,2) DEFAULT 0 NOT NULL,
    created_by integer,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    payment_type character varying(20) DEFAULT 'CASH'::character varying,
    voucher_url character varying(1000),
    status character varying(20) DEFAULT 'pending'::character varying NOT NULL,
    approved_by integer,
    approved_at timestamp with time zone,
    assigned_admin_id integer,
    bank_name character varying(150),
    branch character varying(150),
    cheque_status character varying(20) DEFAULT NULL::character varying,
    cheque_no character varying(50) DEFAULT NULL::character varying,
    buyer_name character varying(255),
    booked_by character varying(255),
    customer_signature_url text,
    authority_signature_url text,
    mapped_member_id integer,
    mapped_user_id integer,
    CONSTRAINT plot_payments_payment_type_check CHECK (((payment_type)::text = ANY ((ARRAY['CASH'::character varying, 'BANK'::character varying, 'CHEQUE'::character varying])::text[])))
);


--
-- Name: plot_payments_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.plot_payments_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: plot_payments_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.plot_payments_id_seq OWNED BY public.plot_payments.id;


--
-- Name: plot_registries; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.plot_registries (
    id integer NOT NULL,
    site_id integer NOT NULL,
    plot_no character varying(50) NOT NULL,
    customer_name character varying(255),
    size_meter numeric(10,2),
    size_sqyard numeric(10,2),
    registry_date date,
    farmer_name character varying(255),
    registry_payment numeric(15,2) DEFAULT 0,
    notes text,
    created_by integer,
    created_at timestamp without time zone DEFAULT now(),
    updated_at timestamp without time zone DEFAULT now(),
    assigned_admin_id integer,
    plot_id integer,
    circle_rate numeric DEFAULT 0,
    firm_name character varying(255),
    seller_name character varying(255),
    created_entry_date date,
    bank_amount numeric DEFAULT 0,
    noc_no character varying(80),
    noc_date date,
    noc_place character varying(150),
    noc_notes text,
    noc_generated_at timestamp without time zone,
    noc_approved_at timestamp without time zone,
    noc_approved_by integer
);


--
-- Name: plot_registries_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.plot_registries_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: plot_registries_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.plot_registries_id_seq OWNED BY public.plot_registries.id;


--
-- Name: plot_registry_payments; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.plot_registry_payments (
    id integer NOT NULL,
    registry_id integer NOT NULL,
    site_id integer NOT NULL,
    payment_date date,
    amount numeric(15,2) DEFAULT 0,
    payment_mode character varying(50),
    tally_date date,
    tally_amount numeric(15,2),
    notes text,
    created_by integer,
    created_at timestamp without time zone DEFAULT now(),
    updated_at timestamp without time zone DEFAULT now(),
    assigned_admin_id integer,
    source_plot_payment_id integer,
    cheque_status character varying(20) DEFAULT NULL::character varying,
    cheque_no character varying(50) DEFAULT NULL::character varying,
    include_in_noc boolean DEFAULT true NOT NULL,
    customer_signature_url text,
    authority_signature_url text
);


--
-- Name: plot_registry_payments_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.plot_registry_payments_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: plot_registry_payments_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.plot_registry_payments_id_seq OWNED BY public.plot_registry_payments.id;


--
-- Name: plots; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.plots (
    id integer NOT NULL,
    site_id integer NOT NULL,
    plot_no character varying(20) NOT NULL,
    block character varying(10),
    buyer_name character varying(255),
    plot_size numeric(10,2),
    plot_rate numeric(15,2),
    sale_price numeric(15,2) DEFAULT 0 NOT NULL,
    booking_by character varying(255),
    booking_date date,
    status character varying(50) DEFAULT 'BOOKED'::character varying,
    notes text,
    created_by integer,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    registry_area numeric(10,2) DEFAULT 0,
    circle_rate numeric(15,2) DEFAULT 0,
    to_receive_bank numeric(15,2) DEFAULT 0,
    first_installment numeric(15,2) DEFAULT 0,
    plc_charges numeric(15,2) DEFAULT 0,
    team character varying(10),
    installments_enabled boolean DEFAULT false NOT NULL,
    interest_enabled boolean DEFAULT false NOT NULL,
    interest_rate numeric(8,4) DEFAULT 0,
    interest_type character varying(20) DEFAULT 'per_month'::character varying,
    assigned_admin_id integer,
    commission_enabled boolean DEFAULT false NOT NULL,
    commission_type character varying(20) DEFAULT 'PERCENTAGE'::character varying NOT NULL,
    commission_value numeric(15,2) DEFAULT 0 NOT NULL,
    plot_size_mtr numeric(10,2),
    commission_rate numeric(15,2) DEFAULT 0,
    plot_commission numeric(15,2) DEFAULT 0,
    original_plot_rate numeric(15,2) DEFAULT 0,
    discount_rate numeric(15,2) DEFAULT 0,
    penalty_enabled boolean DEFAULT false NOT NULL,
    penalty_rate numeric(10,4) DEFAULT 0,
    penalty_type character varying(20) DEFAULT 'per_day'::character varying,
    free_to_sale_days integer DEFAULT 0,
    plot_tag character varying(20),
    CONSTRAINT chk_plots_commission_type CHECK (((commission_type)::text = ANY ((ARRAY['PERCENTAGE'::character varying, 'FIXED'::character varying])::text[]))),
    CONSTRAINT plots_interest_type_check CHECK (((interest_type)::text = ANY ((ARRAY['per_day'::character varying, 'per_month'::character varying, 'per_quarter'::character varying, 'per_year'::character varying])::text[])))
);


--
-- Name: plots_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.plots_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: plots_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.plots_id_seq OWNED BY public.plots.id;


--
-- Name: project_settings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.project_settings (
    id integer NOT NULL,
    site_id integer,
    company_legal_name character varying(255),
    company_brand_name character varying(255),
    company_address text,
    company_city character varying(160),
    company_phone character varying(60),
    company_email character varying(160),
    company_gstin character varying(40),
    company_website character varying(160),
    payable_to character varying(160),
    logo_url character varying(500),
    bank_name character varying(160),
    bank_account_no character varying(60),
    bank_ifsc character varying(40),
    bank_branch character varying(160),
    payment_terms text,
    milestones jsonb DEFAULT '[]'::jsonb,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    draw_required_amount numeric(15,2),
    draw_scheme_name character varying(150)
);


--
-- Name: project_settings_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.project_settings_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: project_settings_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.project_settings_id_seq OWNED BY public.project_settings.id;


--
-- Name: registry_document_handovers; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.registry_document_handovers (
    id integer NOT NULL,
    registry_id integer NOT NULL,
    site_id integer,
    given_to character varying(255) NOT NULL,
    notes text,
    photo_url text,
    given_by integer,
    given_at timestamp without time zone DEFAULT now() NOT NULL,
    created_at timestamp without time zone DEFAULT now() NOT NULL
);


--
-- Name: registry_document_handovers_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.registry_document_handovers_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: registry_document_handovers_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.registry_document_handovers_id_seq OWNED BY public.registry_document_handovers.id;


--
-- Name: sites; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.sites (
    id integer NOT NULL,
    name character varying(255) NOT NULL,
    code character varying(50),
    address text,
    city character varying(100),
    state character varying(100),
    description text,
    status character varying(20) DEFAULT 'active'::character varying NOT NULL,
    created_by integer,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    CONSTRAINT sites_status_check CHECK (((status)::text = ANY ((ARRAY['active'::character varying, 'inactive'::character varying, 'completed'::character varying])::text[])))
);


--
-- Name: sites_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.sites_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: sites_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.sites_id_seq OWNED BY public.sites.id;


--
-- Name: sms_reminder_log; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.sms_reminder_log (
    id integer NOT NULL,
    site_id integer NOT NULL,
    plot_id integer,
    dedupe_key text NOT NULL,
    phone character varying(20) NOT NULL,
    reminder_type character varying(20) NOT NULL,
    message text NOT NULL,
    source character varying(10) DEFAULT 'auto'::character varying NOT NULL,
    status character varying(20) DEFAULT 'queued'::character varying NOT NULL,
    error text,
    queued_by integer,
    created_at timestamp without time zone DEFAULT now() NOT NULL
);


--
-- Name: sms_reminder_log_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.sms_reminder_log_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: sms_reminder_log_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.sms_reminder_log_id_seq OWNED BY public.sms_reminder_log.id;


--
-- Name: team_members; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.team_members (
    team_id integer NOT NULL,
    user_id integer NOT NULL,
    is_head boolean DEFAULT false NOT NULL,
    joined_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: teams; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.teams (
    id integer NOT NULL,
    name text NOT NULL,
    site_id integer,
    status text DEFAULT 'ACTIVE'::text NOT NULL,
    created_by integer,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: teams_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.teams_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: teams_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.teams_id_seq OWNED BY public.teams.id;


--
-- Name: upi_accounts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.upi_accounts (
    id integer NOT NULL,
    site_id integer NOT NULL,
    label character varying(100) NOT NULL,
    payee_name character varying(100) NOT NULL,
    vpa character varying(100) NOT NULL,
    bank_name character varying(100),
    account_no character varying(50),
    ifsc character varying(20),
    is_active boolean DEFAULT true NOT NULL,
    created_by integer,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: upi_accounts_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.upi_accounts_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: upi_accounts_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.upi_accounts_id_seq OWNED BY public.upi_accounts.id;


--
-- Name: user_approval_modules; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.user_approval_modules (
    id integer NOT NULL,
    user_id integer NOT NULL,
    module character varying(50) NOT NULL,
    created_at timestamp without time zone DEFAULT now()
);


--
-- Name: user_approval_modules_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.user_approval_modules_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: user_approval_modules_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.user_approval_modules_id_seq OWNED BY public.user_approval_modules.id;


--
-- Name: user_home_layouts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.user_home_layouts (
    user_id integer NOT NULL,
    layout jsonb DEFAULT '[]'::jsonb NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: user_permissions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.user_permissions (
    id integer NOT NULL,
    user_id integer NOT NULL,
    module character varying(50) NOT NULL,
    can_read boolean DEFAULT true,
    can_write boolean DEFAULT true,
    can_update boolean DEFAULT true,
    can_delete boolean DEFAULT false,
    created_at timestamp without time zone DEFAULT now(),
    updated_at timestamp without time zone DEFAULT now()
);


--
-- Name: user_permissions_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.user_permissions_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: user_permissions_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.user_permissions_id_seq OWNED BY public.user_permissions.id;


--
-- Name: user_sessions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.user_sessions (
    id integer NOT NULL,
    user_id integer,
    login_time timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    logout_time timestamp with time zone,
    ip_address character varying(45)
);


--
-- Name: user_sessions_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.user_sessions_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: user_sessions_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.user_sessions_id_seq OWNED BY public.user_sessions.id;


--
-- Name: user_sites; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.user_sites (
    id integer NOT NULL,
    user_id integer NOT NULL,
    site_id integer NOT NULL,
    assigned_at timestamp with time zone DEFAULT now()
);


--
-- Name: user_sites_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.user_sites_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: user_sites_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.user_sites_id_seq OWNED BY public.user_sites.id;


--
-- Name: users; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.users (
    id integer NOT NULL,
    name character varying(255) NOT NULL,
    email character varying(255) NOT NULL,
    password character varying(255) NOT NULL,
    phone character varying(20),
    photo character varying(500),
    role character varying(20) DEFAULT 'sub_admin'::character varying NOT NULL,
    created_by integer,
    is_active boolean DEFAULT true,
    refresh_token character varying(500),
    token_version integer DEFAULT 1,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    parent_user_id integer,
    referral_code text,
    designation text,
    agent_status text DEFAULT 'ACTIVE'::text NOT NULL,
    team_id integer,
    can_register_agents boolean DEFAULT false NOT NULL,
    CONSTRAINT users_role_check CHECK (((role)::text = ANY ((ARRAY['super_admin'::character varying, 'admin'::character varying, 'sub_admin'::character varying, 'agent'::character varying])::text[])))
);


--
-- Name: users_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.users_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: users_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.users_id_seq OWNED BY public.users.id;


--
-- Name: vendor_commitments; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.vendor_commitments (
    id integer NOT NULL,
    site_id integer NOT NULL,
    vendor_member_id integer,
    vendor_name character varying(200) NOT NULL,
    head_id integer,
    head_name character varying(120),
    work_title character varying(220) NOT NULL,
    contract_amount numeric(14,2) DEFAULT 0 NOT NULL,
    start_date date,
    due_date date,
    note text,
    status character varying(20) DEFAULT 'open'::character varying NOT NULL,
    created_by integer,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    assigned_admin_id integer,
    CONSTRAINT vendor_commitments_contract_amount_check CHECK ((contract_amount >= (0)::numeric)),
    CONSTRAINT vendor_commitments_status_check CHECK (((status)::text = ANY ((ARRAY['open'::character varying, 'closed'::character varying, 'cancelled'::character varying])::text[])))
);


--
-- Name: vendor_commitments_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.vendor_commitments_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: vendor_commitments_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.vendor_commitments_id_seq OWNED BY public.vendor_commitments.id;


--
-- Name: vendor_heads; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.vendor_heads (
    id integer NOT NULL,
    site_id integer NOT NULL,
    name character varying(120) NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    created_by integer,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP
);


--
-- Name: vendor_heads_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.vendor_heads_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: vendor_heads_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.vendor_heads_id_seq OWNED BY public.vendor_heads.id;


--
-- Name: vendor_inventory_deliveries; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.vendor_inventory_deliveries (
    id integer NOT NULL,
    order_id integer NOT NULL,
    site_id integer NOT NULL,
    delivery_date date NOT NULL,
    qty numeric(14,3) NOT NULL,
    note text,
    created_by integer,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT vendor_inventory_deliveries_qty_check CHECK ((qty > (0)::numeric))
);


--
-- Name: vendor_inventory_deliveries_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.vendor_inventory_deliveries_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: vendor_inventory_deliveries_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.vendor_inventory_deliveries_id_seq OWNED BY public.vendor_inventory_deliveries.id;


--
-- Name: vendor_inventory_orders; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.vendor_inventory_orders (
    id integer NOT NULL,
    site_id integer NOT NULL,
    vendor_member_id integer,
    vendor_name character varying(200) NOT NULL,
    item_name character varying(200) NOT NULL,
    item_category character varying(120),
    unit character varying(40) DEFAULT 'pcs'::character varying NOT NULL,
    qty_ordered numeric(14,3) DEFAULT 0 NOT NULL,
    qty_received numeric(14,3) DEFAULT 0 NOT NULL,
    rate numeric(14,4) DEFAULT 0 NOT NULL,
    discount_pct numeric(6,3) DEFAULT 0 NOT NULL,
    discount_amount numeric(14,2) DEFAULT 0 NOT NULL,
    gross_amount numeric(14,2) GENERATED ALWAYS AS (round((qty_received * rate), 2)) STORED,
    net_amount numeric(14,2) GENERATED ALWAYS AS (round(((qty_received * rate) - COALESCE(
CASE
    WHEN (discount_pct > (0)::numeric) THEN round((((qty_received * rate) * discount_pct) / (100)::numeric), 2)
    ELSE discount_amount
END, (0)::numeric)), 2)) STORED,
    total_paid numeric(14,2) DEFAULT 0 NOT NULL,
    order_date date NOT NULL,
    expected_date date,
    note text,
    status character varying(20) DEFAULT 'open'::character varying NOT NULL,
    created_by integer,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    commitment_id integer,
    CONSTRAINT vendor_inventory_orders_discount_amount_check CHECK ((discount_amount >= (0)::numeric)),
    CONSTRAINT vendor_inventory_orders_discount_pct_check CHECK (((discount_pct >= (0)::numeric) AND (discount_pct <= (100)::numeric))),
    CONSTRAINT vendor_inventory_orders_qty_ordered_check CHECK ((qty_ordered >= (0)::numeric)),
    CONSTRAINT vendor_inventory_orders_qty_received_check CHECK ((qty_received >= (0)::numeric)),
    CONSTRAINT vendor_inventory_orders_rate_check CHECK ((rate >= (0)::numeric)),
    CONSTRAINT vendor_inventory_orders_status_check CHECK (((status)::text = ANY ((ARRAY['open'::character varying, 'partial'::character varying, 'completed'::character varying, 'cancelled'::character varying])::text[])))
);


--
-- Name: vendor_inventory_orders_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.vendor_inventory_orders_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: vendor_inventory_orders_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.vendor_inventory_orders_id_seq OWNED BY public.vendor_inventory_orders.id;


--
-- Name: vendor_inventory_payments; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.vendor_inventory_payments (
    id integer NOT NULL,
    order_id integer NOT NULL,
    site_id integer NOT NULL,
    payment_date date NOT NULL,
    amount numeric(14,2) NOT NULL,
    payment_mode character varying(20) DEFAULT 'cash'::character varying NOT NULL,
    reference_no character varying(120),
    cheque_no character varying(50),
    note text,
    voucher_url text,
    created_by integer,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT vendor_inventory_payments_amount_check CHECK ((amount > (0)::numeric)),
    CONSTRAINT vendor_inventory_payments_payment_mode_check CHECK (((payment_mode)::text = ANY ((ARRAY['cash'::character varying, 'bank'::character varying, 'upi'::character varying, 'cheque'::character varying, 'neft'::character varying, 'rtgs'::character varying, 'imps'::character varying, 'other'::character varying])::text[])))
);


--
-- Name: vendor_inventory_payments_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.vendor_inventory_payments_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: vendor_inventory_payments_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.vendor_inventory_payments_id_seq OWNED BY public.vendor_inventory_payments.id;


--
-- Name: vendor_payments; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.vendor_payments (
    id integer NOT NULL,
    commitment_id integer NOT NULL,
    site_id integer NOT NULL,
    payment_date date NOT NULL,
    amount numeric(14,2) NOT NULL,
    payment_mode character varying(20) DEFAULT 'cash'::character varying NOT NULL,
    reference_no character varying(120),
    note text,
    voucher_url text,
    created_by integer,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    status character varying(20) DEFAULT 'pending'::character varying NOT NULL,
    approved_by integer,
    approved_at timestamp with time zone,
    assigned_admin_id integer,
    cheque_status character varying(20) DEFAULT NULL::character varying,
    cheque_no character varying(50) DEFAULT NULL::character varying,
    customer_signature_url text,
    authority_signature_url text,
    mapped_member_id integer,
    mapped_user_id integer,
    CONSTRAINT vendor_payments_amount_check CHECK ((amount > (0)::numeric)),
    CONSTRAINT vendor_payments_payment_mode_check CHECK (((payment_mode)::text = ANY ((ARRAY['cash'::character varying, 'bank'::character varying, 'upi'::character varying, 'cheque'::character varying, 'neft'::character varying, 'rtgs'::character varying, 'imps'::character varying, 'other'::character varying])::text[]))),
    CONSTRAINT vendor_payments_status_check CHECK (((status)::text = ANY ((ARRAY['pending'::character varying, 'approved'::character varying, 'rejected'::character varying])::text[])))
);


--
-- Name: vendor_payments_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.vendor_payments_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: vendor_payments_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.vendor_payments_id_seq OWNED BY public.vendor_payments.id;


--
-- Name: agent_activity_log id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_activity_log ALTER COLUMN id SET DEFAULT nextval('public.agent_activity_log_id_seq'::regclass);


--
-- Name: agent_ledger_entries id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_ledger_entries ALTER COLUMN id SET DEFAULT nextval('public.agent_ledger_entries_id_seq'::regclass);


--
-- Name: application_settings id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.application_settings ALTER COLUMN id SET DEFAULT nextval('public.application_settings_id_seq'::regclass);


--
-- Name: bookings id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bookings ALTER COLUMN id SET DEFAULT nextval('public.bookings_id_seq'::regclass);


--
-- Name: cash_flow_entries id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cash_flow_entries ALTER COLUMN id SET DEFAULT nextval('public.cash_flow_entries_id_seq'::regclass);


--
-- Name: cash_flow_months id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cash_flow_months ALTER COLUMN id SET DEFAULT nextval('public.cash_flow_months_id_seq'::regclass);


--
-- Name: construction_material_request_items id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.construction_material_request_items ALTER COLUMN id SET DEFAULT nextval('public.construction_material_request_items_id_seq'::regclass);


--
-- Name: construction_material_requests id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.construction_material_requests ALTER COLUMN id SET DEFAULT nextval('public.construction_material_requests_id_seq'::regclass);


--
-- Name: construction_projects id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.construction_projects ALTER COLUMN id SET DEFAULT nextval('public.construction_projects_id_seq'::regclass);


--
-- Name: construction_tasks id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.construction_tasks ALTER COLUMN id SET DEFAULT nextval('public.construction_tasks_id_seq'::regclass);


--
-- Name: conversations id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.conversations ALTER COLUMN id SET DEFAULT nextval('public.conversations_id_seq'::regclass);


--
-- Name: dashboard_component_permissions id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.dashboard_component_permissions ALTER COLUMN id SET DEFAULT nextval('public.dashboard_component_permissions_id_seq'::regclass);


--
-- Name: day_book id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.day_book ALTER COLUMN id SET DEFAULT nextval('public.day_book_id_seq'::regclass);


--
-- Name: day_book_daily_balance id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.day_book_daily_balance ALTER COLUMN id SET DEFAULT nextval('public.day_book_daily_balance_id_seq'::regclass);


--
-- Name: document_imprest id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.document_imprest ALTER COLUMN id SET DEFAULT nextval('public.document_imprest_id_seq'::regclass);


--
-- Name: documents id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.documents ALTER COLUMN id SET DEFAULT nextval('public.documents_id_seq'::regclass);


--
-- Name: draw_events id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.draw_events ALTER COLUMN id SET DEFAULT nextval('public.draw_events_id_seq'::regclass);


--
-- Name: draw_payments id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.draw_payments ALTER COLUMN id SET DEFAULT nextval('public.draw_payments_id_seq'::regclass);


--
-- Name: draw_registrations id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.draw_registrations ALTER COLUMN id SET DEFAULT nextval('public.draw_registrations_id_seq'::regclass);


--
-- Name: edit_requests id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.edit_requests ALTER COLUMN id SET DEFAULT nextval('public.edit_requests_id_seq'::regclass);


--
-- Name: excel_files id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.excel_files ALTER COLUMN id SET DEFAULT nextval('public.excel_files_id_seq'::regclass);


--
-- Name: expense_categories id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.expense_categories ALTER COLUMN id SET DEFAULT nextval('public.expense_categories_id_seq'::regclass);


--
-- Name: expenses id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.expenses ALTER COLUMN id SET DEFAULT nextval('public.expenses_id_seq'::regclass);


--
-- Name: farmer_payments id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.farmer_payments ALTER COLUMN id SET DEFAULT nextval('public.farmer_payments_id_seq'::regclass);


--
-- Name: farmers id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.farmers ALTER COLUMN id SET DEFAULT nextval('public.farmers_id_seq'::regclass);


--
-- Name: file_folders id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.file_folders ALTER COLUMN id SET DEFAULT nextval('public.file_folders_id_seq'::regclass);


--
-- Name: firm_transactions id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.firm_transactions ALTER COLUMN id SET DEFAULT nextval('public.firm_transactions_id_seq'::regclass);


--
-- Name: firms id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.firms ALTER COLUMN id SET DEFAULT nextval('public.firms_id_seq'::regclass);


--
-- Name: imprest_allocations id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.imprest_allocations ALTER COLUMN id SET DEFAULT nextval('public.imprest_allocations_id_seq'::regclass);


--
-- Name: imprest_expense_requests id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.imprest_expense_requests ALTER COLUMN id SET DEFAULT nextval('public.imprest_expense_requests_id_seq'::regclass);


--
-- Name: imprest_ledger id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.imprest_ledger ALTER COLUMN id SET DEFAULT nextval('public.imprest_ledger_id_seq'::regclass);


--
-- Name: imprest_returns id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.imprest_returns ALTER COLUMN id SET DEFAULT nextval('public.imprest_returns_id_seq'::regclass);


--
-- Name: inventory_materials id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.inventory_materials ALTER COLUMN id SET DEFAULT nextval('public.inventory_materials_id_seq'::regclass);


--
-- Name: inventory_movements id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.inventory_movements ALTER COLUMN id SET DEFAULT nextval('public.inventory_movements_id_seq'::regclass);


--
-- Name: kyc_cases id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.kyc_cases ALTER COLUMN id SET DEFAULT nextval('public.kyc_cases_id_seq'::regclass);


--
-- Name: login_otps id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.login_otps ALTER COLUMN id SET DEFAULT nextval('public.login_otps_id_seq'::regclass);


--
-- Name: member_categories id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.member_categories ALTER COLUMN id SET DEFAULT nextval('public.member_categories_id_seq'::regclass);


--
-- Name: members id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.members ALTER COLUMN id SET DEFAULT nextval('public.members_id_seq'::regclass);


--
-- Name: messages id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.messages ALTER COLUMN id SET DEFAULT nextval('public.messages_id_seq'::regclass);


--
-- Name: ocr_results id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ocr_results ALTER COLUMN id SET DEFAULT nextval('public.ocr_results_id_seq'::regclass);


--
-- Name: payment_qrs id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payment_qrs ALTER COLUMN id SET DEFAULT nextval('public.payment_qrs_id_seq'::regclass);


--
-- Name: plot_commission_payments id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.plot_commission_payments ALTER COLUMN id SET DEFAULT nextval('public.plot_commission_payments_id_seq'::regclass);


--
-- Name: plot_commissions id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.plot_commissions ALTER COLUMN id SET DEFAULT nextval('public.plot_commissions_id_seq'::regclass);


--
-- Name: plot_commissions_v2 id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.plot_commissions_v2 ALTER COLUMN id SET DEFAULT nextval('public.plot_commissions_v2_id_seq'::regclass);


--
-- Name: plot_installment_payments id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.plot_installment_payments ALTER COLUMN id SET DEFAULT nextval('public.plot_installment_payments_id_seq'::regclass);


--
-- Name: plot_installments id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.plot_installments ALTER COLUMN id SET DEFAULT nextval('public.plot_installments_id_seq'::regclass);


--
-- Name: plot_payments id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.plot_payments ALTER COLUMN id SET DEFAULT nextval('public.plot_payments_id_seq'::regclass);


--
-- Name: plot_registries id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.plot_registries ALTER COLUMN id SET DEFAULT nextval('public.plot_registries_id_seq'::regclass);


--
-- Name: plot_registry_payments id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.plot_registry_payments ALTER COLUMN id SET DEFAULT nextval('public.plot_registry_payments_id_seq'::regclass);


--
-- Name: plots id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.plots ALTER COLUMN id SET DEFAULT nextval('public.plots_id_seq'::regclass);


--
-- Name: project_settings id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.project_settings ALTER COLUMN id SET DEFAULT nextval('public.project_settings_id_seq'::regclass);


--
-- Name: registry_document_handovers id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.registry_document_handovers ALTER COLUMN id SET DEFAULT nextval('public.registry_document_handovers_id_seq'::regclass);


--
-- Name: sites id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sites ALTER COLUMN id SET DEFAULT nextval('public.sites_id_seq'::regclass);


--
-- Name: sms_reminder_log id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sms_reminder_log ALTER COLUMN id SET DEFAULT nextval('public.sms_reminder_log_id_seq'::regclass);


--
-- Name: teams id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.teams ALTER COLUMN id SET DEFAULT nextval('public.teams_id_seq'::regclass);


--
-- Name: upi_accounts id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.upi_accounts ALTER COLUMN id SET DEFAULT nextval('public.upi_accounts_id_seq'::regclass);


--
-- Name: user_approval_modules id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_approval_modules ALTER COLUMN id SET DEFAULT nextval('public.user_approval_modules_id_seq'::regclass);


--
-- Name: user_permissions id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_permissions ALTER COLUMN id SET DEFAULT nextval('public.user_permissions_id_seq'::regclass);


--
-- Name: user_sessions id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_sessions ALTER COLUMN id SET DEFAULT nextval('public.user_sessions_id_seq'::regclass);


--
-- Name: user_sites id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_sites ALTER COLUMN id SET DEFAULT nextval('public.user_sites_id_seq'::regclass);


--
-- Name: users id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users ALTER COLUMN id SET DEFAULT nextval('public.users_id_seq'::regclass);


--
-- Name: vendor_commitments id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vendor_commitments ALTER COLUMN id SET DEFAULT nextval('public.vendor_commitments_id_seq'::regclass);


--
-- Name: vendor_heads id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vendor_heads ALTER COLUMN id SET DEFAULT nextval('public.vendor_heads_id_seq'::regclass);


--
-- Name: vendor_inventory_deliveries id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vendor_inventory_deliveries ALTER COLUMN id SET DEFAULT nextval('public.vendor_inventory_deliveries_id_seq'::regclass);


--
-- Name: vendor_inventory_orders id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vendor_inventory_orders ALTER COLUMN id SET DEFAULT nextval('public.vendor_inventory_orders_id_seq'::regclass);


--
-- Name: vendor_inventory_payments id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vendor_inventory_payments ALTER COLUMN id SET DEFAULT nextval('public.vendor_inventory_payments_id_seq'::regclass);


--
-- Name: vendor_payments id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vendor_payments ALTER COLUMN id SET DEFAULT nextval('public.vendor_payments_id_seq'::regclass);


--
-- Name: agent_activity_log agent_activity_log_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_activity_log
    ADD CONSTRAINT agent_activity_log_pkey PRIMARY KEY (id);


--
-- Name: agent_ledger_entries agent_ledger_entries_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_ledger_entries
    ADD CONSTRAINT agent_ledger_entries_pkey PRIMARY KEY (id);


--
-- Name: application_settings application_settings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.application_settings
    ADD CONSTRAINT application_settings_pkey PRIMARY KEY (id);


--
-- Name: application_settings application_settings_site_id_setting_key_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.application_settings
    ADD CONSTRAINT application_settings_site_id_setting_key_key UNIQUE (site_id, setting_key);


--
-- Name: bookings bookings_booking_no_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bookings
    ADD CONSTRAINT bookings_booking_no_key UNIQUE (booking_no);


--
-- Name: bookings bookings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bookings
    ADD CONSTRAINT bookings_pkey PRIMARY KEY (id);


--
-- Name: cash_flow_entries cash_flow_entries_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cash_flow_entries
    ADD CONSTRAINT cash_flow_entries_pkey PRIMARY KEY (id);


--
-- Name: cash_flow_months cash_flow_months_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cash_flow_months
    ADD CONSTRAINT cash_flow_months_pkey PRIMARY KEY (id);


--
-- Name: cash_flow_months cash_flow_months_site_month_year_name_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cash_flow_months
    ADD CONSTRAINT cash_flow_months_site_month_year_name_key UNIQUE (site_id, month, year, ledger_name);


--
-- Name: construction_material_request_items construction_material_request_items_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.construction_material_request_items
    ADD CONSTRAINT construction_material_request_items_pkey PRIMARY KEY (id);


--
-- Name: construction_material_requests construction_material_requests_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.construction_material_requests
    ADD CONSTRAINT construction_material_requests_pkey PRIMARY KEY (id);


--
-- Name: construction_projects construction_projects_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.construction_projects
    ADD CONSTRAINT construction_projects_pkey PRIMARY KEY (id);


--
-- Name: construction_tasks construction_tasks_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.construction_tasks
    ADD CONSTRAINT construction_tasks_pkey PRIMARY KEY (id);


--
-- Name: conversations conversations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.conversations
    ADD CONSTRAINT conversations_pkey PRIMARY KEY (id);


--
-- Name: conversations conversations_user1_id_user2_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.conversations
    ADD CONSTRAINT conversations_user1_id_user2_id_key UNIQUE (user1_id, user2_id);


--
-- Name: dashboard_component_permissions dashboard_component_permissions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.dashboard_component_permissions
    ADD CONSTRAINT dashboard_component_permissions_pkey PRIMARY KEY (id);


--
-- Name: dashboard_component_permissions dashboard_component_permissions_user_id_component_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.dashboard_component_permissions
    ADD CONSTRAINT dashboard_component_permissions_user_id_component_key UNIQUE (user_id, component);


--
-- Name: day_book_daily_balance day_book_daily_balance_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.day_book_daily_balance
    ADD CONSTRAINT day_book_daily_balance_pkey PRIMARY KEY (id);


--
-- Name: day_book_daily_balance day_book_daily_balance_site_id_date_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.day_book_daily_balance
    ADD CONSTRAINT day_book_daily_balance_site_id_date_key UNIQUE (site_id, date);


--
-- Name: day_book day_book_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.day_book
    ADD CONSTRAINT day_book_pkey PRIMARY KEY (id);


--
-- Name: document_imprest document_imprest_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.document_imprest
    ADD CONSTRAINT document_imprest_pkey PRIMARY KEY (id);


--
-- Name: documents documents_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.documents
    ADD CONSTRAINT documents_pkey PRIMARY KEY (id);


--
-- Name: draw_events draw_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.draw_events
    ADD CONSTRAINT draw_events_pkey PRIMARY KEY (id);


--
-- Name: draw_payments draw_payments_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.draw_payments
    ADD CONSTRAINT draw_payments_pkey PRIMARY KEY (id);


--
-- Name: draw_payments draw_payments_receipt_no_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.draw_payments
    ADD CONSTRAINT draw_payments_receipt_no_key UNIQUE (receipt_no);


--
-- Name: draw_registrations draw_registrations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.draw_registrations
    ADD CONSTRAINT draw_registrations_pkey PRIMARY KEY (id);


--
-- Name: draw_registrations draw_registrations_qr_token_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.draw_registrations
    ADD CONSTRAINT draw_registrations_qr_token_key UNIQUE (qr_token);


--
-- Name: draw_registrations draw_registrations_registration_no_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.draw_registrations
    ADD CONSTRAINT draw_registrations_registration_no_key UNIQUE (registration_no);


--
-- Name: draw_registrations draw_registrations_slip_no_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.draw_registrations
    ADD CONSTRAINT draw_registrations_slip_no_key UNIQUE (slip_no);


--
-- Name: edit_requests edit_requests_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.edit_requests
    ADD CONSTRAINT edit_requests_pkey PRIMARY KEY (id);


--
-- Name: excel_files excel_files_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.excel_files
    ADD CONSTRAINT excel_files_pkey PRIMARY KEY (id);


--
-- Name: expense_categories expense_categories_name_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.expense_categories
    ADD CONSTRAINT expense_categories_name_key UNIQUE (name);


--
-- Name: expense_categories expense_categories_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.expense_categories
    ADD CONSTRAINT expense_categories_pkey PRIMARY KEY (id);


--
-- Name: expenses expenses_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.expenses
    ADD CONSTRAINT expenses_pkey PRIMARY KEY (id);


--
-- Name: farmer_payments farmer_payments_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.farmer_payments
    ADD CONSTRAINT farmer_payments_pkey PRIMARY KEY (id);


--
-- Name: farmers farmers_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.farmers
    ADD CONSTRAINT farmers_pkey PRIMARY KEY (id);


--
-- Name: file_folders file_folders_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.file_folders
    ADD CONSTRAINT file_folders_pkey PRIMARY KEY (id);


--
-- Name: firm_transactions firm_transactions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.firm_transactions
    ADD CONSTRAINT firm_transactions_pkey PRIMARY KEY (id);


--
-- Name: firms firms_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.firms
    ADD CONSTRAINT firms_pkey PRIMARY KEY (id);


--
-- Name: firms firms_site_id_name_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.firms
    ADD CONSTRAINT firms_site_id_name_key UNIQUE (site_id, name);


--
-- Name: imprest_allocations imprest_allocations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.imprest_allocations
    ADD CONSTRAINT imprest_allocations_pkey PRIMARY KEY (id);


--
-- Name: imprest_expense_requests imprest_expense_requests_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.imprest_expense_requests
    ADD CONSTRAINT imprest_expense_requests_pkey PRIMARY KEY (id);


--
-- Name: imprest_ledger imprest_ledger_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.imprest_ledger
    ADD CONSTRAINT imprest_ledger_pkey PRIMARY KEY (id);


--
-- Name: imprest_returns imprest_returns_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.imprest_returns
    ADD CONSTRAINT imprest_returns_pkey PRIMARY KEY (id);


--
-- Name: inventory_materials inventory_materials_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.inventory_materials
    ADD CONSTRAINT inventory_materials_pkey PRIMARY KEY (id);


--
-- Name: inventory_movements inventory_movements_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.inventory_movements
    ADD CONSTRAINT inventory_movements_pkey PRIMARY KEY (id);


--
-- Name: kyc_cases kyc_cases_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.kyc_cases
    ADD CONSTRAINT kyc_cases_pkey PRIMARY KEY (id);


--
-- Name: kyc_cases kyc_cases_qr_token_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.kyc_cases
    ADD CONSTRAINT kyc_cases_qr_token_key UNIQUE (qr_token);


--
-- Name: login_otps login_otps_pending_token_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.login_otps
    ADD CONSTRAINT login_otps_pending_token_key UNIQUE (pending_token);


--
-- Name: login_otps login_otps_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.login_otps
    ADD CONSTRAINT login_otps_pkey PRIMARY KEY (id);


--
-- Name: member_categories member_categories_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.member_categories
    ADD CONSTRAINT member_categories_pkey PRIMARY KEY (id);


--
-- Name: member_categories member_categories_slug_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.member_categories
    ADD CONSTRAINT member_categories_slug_key UNIQUE (slug);


--
-- Name: members members_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.members
    ADD CONSTRAINT members_pkey PRIMARY KEY (id);


--
-- Name: messages messages_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.messages
    ADD CONSTRAINT messages_pkey PRIMARY KEY (id);


--
-- Name: ocr_results ocr_results_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ocr_results
    ADD CONSTRAINT ocr_results_pkey PRIMARY KEY (id);


--
-- Name: payment_qrs payment_qrs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payment_qrs
    ADD CONSTRAINT payment_qrs_pkey PRIMARY KEY (id);


--
-- Name: plot_commission_payments plot_commission_payments_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.plot_commission_payments
    ADD CONSTRAINT plot_commission_payments_pkey PRIMARY KEY (id);


--
-- Name: plot_commission_payments plot_commission_payments_voucher_number_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.plot_commission_payments
    ADD CONSTRAINT plot_commission_payments_voucher_number_key UNIQUE (voucher_number);


--
-- Name: plot_commissions plot_commissions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.plot_commissions
    ADD CONSTRAINT plot_commissions_pkey PRIMARY KEY (id);


--
-- Name: plot_commissions_v2 plot_commissions_v2_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.plot_commissions_v2
    ADD CONSTRAINT plot_commissions_v2_pkey PRIMARY KEY (id);


--
-- Name: plot_installment_payments plot_installment_payments_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.plot_installment_payments
    ADD CONSTRAINT plot_installment_payments_pkey PRIMARY KEY (id);


--
-- Name: plot_installments plot_installments_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.plot_installments
    ADD CONSTRAINT plot_installments_pkey PRIMARY KEY (id);


--
-- Name: plot_payments plot_payments_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.plot_payments
    ADD CONSTRAINT plot_payments_pkey PRIMARY KEY (id);


--
-- Name: plot_registries plot_registries_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.plot_registries
    ADD CONSTRAINT plot_registries_pkey PRIMARY KEY (id);


--
-- Name: plot_registries plot_registries_site_id_plot_no_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.plot_registries
    ADD CONSTRAINT plot_registries_site_id_plot_no_key UNIQUE (site_id, plot_no);


--
-- Name: plot_registry_payments plot_registry_payments_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.plot_registry_payments
    ADD CONSTRAINT plot_registry_payments_pkey PRIMARY KEY (id);


--
-- Name: plots plots_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.plots
    ADD CONSTRAINT plots_pkey PRIMARY KEY (id);


--
-- Name: project_settings project_settings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.project_settings
    ADD CONSTRAINT project_settings_pkey PRIMARY KEY (id);


--
-- Name: project_settings project_settings_site_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.project_settings
    ADD CONSTRAINT project_settings_site_id_key UNIQUE (site_id);


--
-- Name: registry_document_handovers registry_document_handovers_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.registry_document_handovers
    ADD CONSTRAINT registry_document_handovers_pkey PRIMARY KEY (id);


--
-- Name: sites sites_code_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sites
    ADD CONSTRAINT sites_code_key UNIQUE (code);


--
-- Name: sites sites_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sites
    ADD CONSTRAINT sites_pkey PRIMARY KEY (id);


--
-- Name: sms_reminder_log sms_reminder_log_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sms_reminder_log
    ADD CONSTRAINT sms_reminder_log_pkey PRIMARY KEY (id);


--
-- Name: sms_reminder_log sms_reminder_log_site_id_dedupe_key_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sms_reminder_log
    ADD CONSTRAINT sms_reminder_log_site_id_dedupe_key_key UNIQUE (site_id, dedupe_key);


--
-- Name: team_members team_members_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.team_members
    ADD CONSTRAINT team_members_pkey PRIMARY KEY (team_id, user_id);


--
-- Name: teams teams_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.teams
    ADD CONSTRAINT teams_pkey PRIMARY KEY (id);


--
-- Name: upi_accounts upi_accounts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.upi_accounts
    ADD CONSTRAINT upi_accounts_pkey PRIMARY KEY (id);


--
-- Name: user_approval_modules user_approval_modules_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_approval_modules
    ADD CONSTRAINT user_approval_modules_pkey PRIMARY KEY (id);


--
-- Name: user_approval_modules user_approval_modules_user_id_module_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_approval_modules
    ADD CONSTRAINT user_approval_modules_user_id_module_key UNIQUE (user_id, module);


--
-- Name: user_home_layouts user_home_layouts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_home_layouts
    ADD CONSTRAINT user_home_layouts_pkey PRIMARY KEY (user_id);


--
-- Name: user_permissions user_permissions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_permissions
    ADD CONSTRAINT user_permissions_pkey PRIMARY KEY (id);


--
-- Name: user_permissions user_permissions_user_id_module_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_permissions
    ADD CONSTRAINT user_permissions_user_id_module_key UNIQUE (user_id, module);


--
-- Name: user_sessions user_sessions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_sessions
    ADD CONSTRAINT user_sessions_pkey PRIMARY KEY (id);


--
-- Name: user_sites user_sites_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_sites
    ADD CONSTRAINT user_sites_pkey PRIMARY KEY (id);


--
-- Name: user_sites user_sites_user_id_site_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_sites
    ADD CONSTRAINT user_sites_user_id_site_id_key UNIQUE (user_id, site_id);


--
-- Name: users users_email_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_email_key UNIQUE (email);


--
-- Name: users users_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_pkey PRIMARY KEY (id);


--
-- Name: vendor_commitments vendor_commitments_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vendor_commitments
    ADD CONSTRAINT vendor_commitments_pkey PRIMARY KEY (id);


--
-- Name: vendor_heads vendor_heads_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vendor_heads
    ADD CONSTRAINT vendor_heads_pkey PRIMARY KEY (id);


--
-- Name: vendor_inventory_deliveries vendor_inventory_deliveries_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vendor_inventory_deliveries
    ADD CONSTRAINT vendor_inventory_deliveries_pkey PRIMARY KEY (id);


--
-- Name: vendor_inventory_orders vendor_inventory_orders_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vendor_inventory_orders
    ADD CONSTRAINT vendor_inventory_orders_pkey PRIMARY KEY (id);


--
-- Name: vendor_inventory_payments vendor_inventory_payments_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vendor_inventory_payments
    ADD CONSTRAINT vendor_inventory_payments_pkey PRIMARY KEY (id);


--
-- Name: vendor_payments vendor_payments_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vendor_payments
    ADD CONSTRAINT vendor_payments_pkey PRIMARY KEY (id);


--
-- Name: agent_activity_target_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX agent_activity_target_idx ON public.agent_activity_log USING btree (target_user_id, created_at DESC);


--
-- Name: agent_ledger_type_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX agent_ledger_type_idx ON public.agent_ledger_entries USING btree (entry_type, status);


--
-- Name: agent_ledger_user_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX agent_ledger_user_idx ON public.agent_ledger_entries USING btree (user_id, created_at DESC);


--
-- Name: bookings_agent_user_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX bookings_agent_user_idx ON public.bookings USING btree (agent_user_id);


--
-- Name: bookings_team_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX bookings_team_idx ON public.bookings USING btree (team_id);


--
-- Name: idx_application_settings_site; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_application_settings_site ON public.application_settings USING btree (site_id);


--
-- Name: idx_bookings_agent; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_bookings_agent ON public.bookings USING btree (booking_agent_id);


--
-- Name: idx_bookings_client; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_bookings_client ON public.bookings USING btree (client_member_id);


--
-- Name: idx_bookings_kyc_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_bookings_kyc_status ON public.bookings USING btree (kyc_status);


--
-- Name: idx_bookings_plot_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_bookings_plot_id ON public.bookings USING btree (plot_id);


--
-- Name: idx_bookings_site_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_bookings_site_id ON public.bookings USING btree (site_id);


--
-- Name: idx_bookings_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_bookings_status ON public.bookings USING btree (status);


--
-- Name: idx_bookings_token_payment; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_bookings_token_payment ON public.bookings USING btree (token_payment_id);


--
-- Name: idx_cash_flow_entries_assigned_admin_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_cash_flow_entries_assigned_admin_id ON public.cash_flow_entries USING btree (assigned_admin_id);


--
-- Name: idx_cash_flow_entries_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_cash_flow_entries_status ON public.cash_flow_entries USING btree (status);


--
-- Name: idx_cf_entries_site_date; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_cf_entries_site_date ON public.cash_flow_entries USING btree (site_id, date);


--
-- Name: idx_cfe_active_month; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_cfe_active_month ON public.cash_flow_entries USING btree (cash_flow_month_id) WHERE (((cheque_status IS NULL) OR ((cheque_status)::text <> ALL ((ARRAY['BOUNCED'::character varying, 'RETURNED'::character varying])::text[]))) AND ((status IS NULL) OR ((status)::text <> 'rejected'::text)));


--
-- Name: idx_cfe_balance_approved_site_mode_date; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_cfe_balance_approved_site_mode_date ON public.cash_flow_entries USING btree (site_id, cash_type, date DESC) WHERE ((lower((COALESCE(status, 'approved'::character varying))::text) = 'approved'::text) AND (upper((COALESCE(cheque_status, ''::character varying))::text) <> ALL (ARRAY['BOUNCED'::text, 'RETURNED'::text])));


--
-- Name: idx_cfe_balance_site_date; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_cfe_balance_site_date ON public.cash_flow_entries USING btree (site_id, date DESC) INCLUDE (debit, credit, cash_type, source_module, source_id, status, cheque_status);


--
-- Name: idx_cfe_balance_source; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_cfe_balance_source ON public.cash_flow_entries USING btree (site_id, source_module, date DESC);


--
-- Name: idx_cfe_date; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_cfe_date ON public.cash_flow_entries USING btree (date);


--
-- Name: idx_cfe_firm_active; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_cfe_firm_active ON public.cash_flow_entries USING btree (from_firm_id, to_firm_id) WHERE ((is_firm_transaction = true) AND ((cheque_status IS NULL) OR ((cheque_status)::text <> ALL ((ARRAY['BOUNCED'::character varying, 'RETURNED'::character varying])::text[]))) AND ((status IS NULL) OR ((status)::text <> 'rejected'::text)));


--
-- Name: idx_cfe_from_firm_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_cfe_from_firm_id ON public.cash_flow_entries USING btree (from_firm_id);


--
-- Name: idx_cfe_is_firm_transaction; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_cfe_is_firm_transaction ON public.cash_flow_entries USING btree (is_firm_transaction);


--
-- Name: idx_cfe_month; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_cfe_month ON public.cash_flow_entries USING btree (cash_flow_month_id);


--
-- Name: idx_cfe_month_cash_type; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_cfe_month_cash_type ON public.cash_flow_entries USING btree (cash_flow_month_id, cash_type);


--
-- Name: idx_cfe_month_date; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_cfe_month_date ON public.cash_flow_entries USING btree (cash_flow_month_id, date, created_at);


--
-- Name: idx_cfe_site; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_cfe_site ON public.cash_flow_entries USING btree (site_id);


--
-- Name: idx_cfe_site_particular; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_cfe_site_particular ON public.cash_flow_entries USING btree (site_id, particular);


--
-- Name: idx_cfe_to_firm_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_cfe_to_firm_id ON public.cash_flow_entries USING btree (to_firm_id);


--
-- Name: idx_cfe_unified_debit; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_cfe_unified_debit ON public.cash_flow_entries USING btree (site_id, date DESC) WHERE ((debit > (0)::numeric) AND ((cheque_status IS NULL) OR ((cheque_status)::text <> ALL ((ARRAY['BOUNCED'::character varying, 'RETURNED'::character varying])::text[]))) AND ((status IS NULL) OR ((status)::text <> 'rejected'::text)));


--
-- Name: idx_cfm_ledger_name; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_cfm_ledger_name ON public.cash_flow_months USING btree (ledger_name);


--
-- Name: idx_cfm_ledger_type; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_cfm_ledger_type ON public.cash_flow_months USING btree (ledger_type);


--
-- Name: idx_cfm_linked_member_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_cfm_linked_member_id ON public.cash_flow_months USING btree (linked_member_id) WHERE (linked_member_id IS NOT NULL);


--
-- Name: idx_cfm_linked_user_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_cfm_linked_user_id ON public.cash_flow_months USING btree (linked_user_id) WHERE (linked_user_id IS NOT NULL);


--
-- Name: idx_cfm_period; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_cfm_period ON public.cash_flow_months USING btree (year, month);


--
-- Name: idx_cfm_site; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_cfm_site ON public.cash_flow_months USING btree (site_id);


--
-- Name: idx_cfm_site_ledger_period; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_cfm_site_ledger_period ON public.cash_flow_months USING btree (site_id, ledger_name, year DESC, month DESC);


--
-- Name: idx_cmr_project; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_cmr_project ON public.construction_material_requests USING btree (project_id);


--
-- Name: idx_cmr_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_cmr_status ON public.construction_material_requests USING btree (status);


--
-- Name: idx_cmri_material; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_cmri_material ON public.construction_material_request_items USING btree (material_id);


--
-- Name: idx_cmri_request; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_cmri_request ON public.construction_material_request_items USING btree (request_id);


--
-- Name: idx_construction_projects_site; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_construction_projects_site ON public.construction_projects USING btree (site_id);


--
-- Name: idx_construction_projects_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_construction_projects_status ON public.construction_projects USING btree (status);


--
-- Name: idx_construction_tasks_project; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_construction_tasks_project ON public.construction_tasks USING btree (project_id);


--
-- Name: idx_day_book_assigned_admin_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_day_book_assigned_admin_id ON public.day_book USING btree (assigned_admin_id);


--
-- Name: idx_day_book_cash_flow_entry_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_day_book_cash_flow_entry_id ON public.day_book USING btree (cash_flow_entry_id);


--
-- Name: idx_day_book_commission_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_day_book_commission_id ON public.day_book USING btree (commission_id);


--
-- Name: idx_day_book_date; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_day_book_date ON public.day_book USING btree (date);


--
-- Name: idx_day_book_expense_unified; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_day_book_expense_unified ON public.day_book USING btree (site_id, date DESC) WHERE (((entry_type)::text = 'EXPENSE'::text) AND (farmer_payment_id IS NULL) AND (commission_id IS NULL) AND (vendor_payment_id IS NULL) AND ((cheque_status IS NULL) OR ((cheque_status)::text <> ALL ((ARRAY['BOUNCED'::character varying, 'RETURNED'::character varying])::text[]))) AND ((status)::text <> 'rejected'::text));


--
-- Name: idx_day_book_farmer_payment; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_day_book_farmer_payment ON public.day_book USING btree (farmer_payment_id);


--
-- Name: idx_day_book_farmer_payment_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_day_book_farmer_payment_id ON public.day_book USING btree (farmer_payment_id) WHERE (farmer_payment_id IS NOT NULL);


--
-- Name: idx_day_book_firm_transaction_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_day_book_firm_transaction_id ON public.day_book USING btree (firm_transaction_id);


--
-- Name: idx_day_book_imprest_alloc; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_day_book_imprest_alloc ON public.day_book USING btree (imprest_allocation_id);


--
-- Name: idx_day_book_mapped_member_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_day_book_mapped_member_id ON public.day_book USING btree (mapped_member_id) WHERE (mapped_member_id IS NOT NULL);


--
-- Name: idx_day_book_mapped_user_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_day_book_mapped_user_id ON public.day_book USING btree (mapped_user_id) WHERE (mapped_user_id IS NOT NULL);


--
-- Name: idx_day_book_plot_payment_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_day_book_plot_payment_id ON public.day_book USING btree (plot_payment_id);


--
-- Name: idx_day_book_site; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_day_book_site ON public.day_book USING btree (site_id);


--
-- Name: idx_day_book_site_date; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_day_book_site_date ON public.day_book USING btree (site_id, date);


--
-- Name: idx_day_book_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_day_book_status ON public.day_book USING btree (status);


--
-- Name: idx_day_book_type; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_day_book_type ON public.day_book USING btree (entry_type);


--
-- Name: idx_day_book_vendor_payment_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_day_book_vendor_payment_id ON public.day_book USING btree (vendor_payment_id);


--
-- Name: idx_daybook_site_date; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_daybook_site_date ON public.day_book USING btree (site_id, date DESC);


--
-- Name: idx_daybook_site_date_exact; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_daybook_site_date_exact ON public.day_book USING btree (site_id, date);


--
-- Name: idx_daybook_site_type; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_daybook_site_type ON public.day_book USING btree (site_id, entry_type);


--
-- Name: idx_daybook_site_type_date; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_daybook_site_type_date ON public.day_book USING btree (site_id, entry_type, date DESC);


--
-- Name: idx_dbdb_site_date; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_dbdb_site_date ON public.day_book_daily_balance USING btree (site_id, date DESC);


--
-- Name: idx_dcp_user_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_dcp_user_id ON public.dashboard_component_permissions USING btree (user_id);


--
-- Name: idx_document_imprest_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_document_imprest_created ON public.document_imprest USING btree (created_at DESC);


--
-- Name: idx_document_imprest_site; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_document_imprest_site ON public.document_imprest USING btree (site_id);


--
-- Name: idx_document_imprest_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_document_imprest_status ON public.document_imprest USING btree (status);


--
-- Name: idx_documents_case; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_documents_case ON public.documents USING btree (kyc_case_id);


--
-- Name: idx_documents_case_member_field; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_documents_case_member_field ON public.documents USING btree (kyc_case_id, member_document_field, id DESC) WHERE (member_document_field IS NOT NULL);


--
-- Name: idx_documents_category; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_documents_category ON public.documents USING btree (category);


--
-- Name: idx_documents_dms_site_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_documents_dms_site_created ON public.documents USING btree (site_id, created_at DESC) WHERE ((uploaded_source)::text = 'DMS'::text);


--
-- Name: idx_documents_doc_date; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_documents_doc_date ON public.documents USING btree (doc_date);


--
-- Name: idx_documents_expiry; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_documents_expiry ON public.documents USING btree (expiry_date);


--
-- Name: idx_documents_ocr_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_documents_ocr_status ON public.documents USING btree (ocr_status);


--
-- Name: idx_documents_ocr_trgm; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_documents_ocr_trgm ON public.documents USING gin (ocr_text public.gin_trgm_ops);


--
-- Name: idx_documents_plot; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_documents_plot ON public.documents USING btree (plot_id);


--
-- Name: idx_documents_search_tsv; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_documents_search_tsv ON public.documents USING gin (search_tsv);


--
-- Name: idx_documents_source; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_documents_source ON public.documents USING btree (uploaded_source);


--
-- Name: idx_draw_events_reg; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_draw_events_reg ON public.draw_events USING btree (draw_registration_id);


--
-- Name: idx_draw_payments_reg; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_draw_payments_reg ON public.draw_payments USING btree (draw_registration_id);


--
-- Name: idx_draw_reg_agent; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_draw_reg_agent ON public.draw_registrations USING btree (agent_user_id);


--
-- Name: idx_draw_reg_client; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_draw_reg_client ON public.draw_registrations USING btree (client_member_id);


--
-- Name: idx_draw_reg_kyc; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_draw_reg_kyc ON public.draw_registrations USING btree (kyc_case_id);


--
-- Name: idx_draw_reg_site; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_draw_reg_site ON public.draw_registrations USING btree (site_id);


--
-- Name: idx_draw_reg_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_draw_reg_status ON public.draw_registrations USING btree (status);


--
-- Name: idx_edit_requests_module; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_edit_requests_module ON public.edit_requests USING btree (module, record_id);


--
-- Name: idx_edit_requests_requested_by; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_edit_requests_requested_by ON public.edit_requests USING btree (requested_by);


--
-- Name: idx_edit_requests_site; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_edit_requests_site ON public.edit_requests USING btree (site_id);


--
-- Name: idx_edit_requests_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_edit_requests_status ON public.edit_requests USING btree (status);


--
-- Name: idx_excel_files_created_by; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_excel_files_created_by ON public.excel_files USING btree (created_by);


--
-- Name: idx_excel_files_folder; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_excel_files_folder ON public.excel_files USING btree (folder_id);


--
-- Name: idx_excel_files_site; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_excel_files_site ON public.excel_files USING btree (site_id);


--
-- Name: idx_excel_files_updated_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_excel_files_updated_at ON public.excel_files USING btree (updated_at);


--
-- Name: idx_exp_active_site; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_exp_active_site ON public.expenses USING btree (site_id, date DESC) WHERE (((cheque_status IS NULL) OR ((cheque_status)::text <> ALL ((ARRAY['BOUNCED'::character varying, 'RETURNED'::character varying])::text[]))) AND ((status)::text <> 'rejected'::text));


--
-- Name: idx_exp_category; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_exp_category ON public.expenses USING btree (category);


--
-- Name: idx_exp_date; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_exp_date ON public.expenses USING btree (date);


--
-- Name: idx_exp_mode; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_exp_mode ON public.expenses USING btree (payment_mode);


--
-- Name: idx_exp_site; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_exp_site ON public.expenses USING btree (site_id);


--
-- Name: idx_exp_site_category_active; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_exp_site_category_active ON public.expenses USING btree (site_id, category) WHERE ((category IS NOT NULL) AND ((category)::text <> ''::text));


--
-- Name: idx_exp_site_date; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_exp_site_date ON public.expenses USING btree (site_id, date);


--
-- Name: idx_exp_site_from_entity; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_exp_site_from_entity ON public.expenses USING btree (site_id, from_entity) WHERE ((from_entity IS NOT NULL) AND ((from_entity)::text <> ''::text));


--
-- Name: idx_exp_site_payment_mode; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_exp_site_payment_mode ON public.expenses USING btree (site_id, payment_mode) WHERE ((payment_mode IS NOT NULL) AND ((payment_mode)::text <> ''::text));


--
-- Name: idx_exp_site_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_exp_site_status ON public.expenses USING btree (site_id, status, date DESC);


--
-- Name: idx_exp_site_to_entity; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_exp_site_to_entity ON public.expenses USING btree (site_id, to_entity) WHERE ((to_entity IS NOT NULL) AND ((to_entity)::text <> ''::text));


--
-- Name: idx_exp_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_exp_status ON public.expenses USING btree (status);


--
-- Name: idx_expenses_assigned_admin_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_expenses_assigned_admin_id ON public.expenses USING btree (assigned_admin_id);


--
-- Name: idx_expenses_mapped_member_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_expenses_mapped_member_id ON public.expenses USING btree (mapped_member_id) WHERE (mapped_member_id IS NOT NULL);


--
-- Name: idx_expenses_mapped_user_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_expenses_mapped_user_id ON public.expenses USING btree (mapped_user_id) WHERE (mapped_user_id IS NOT NULL);


--
-- Name: idx_expenses_site_category; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_expenses_site_category ON public.expenses USING btree (site_id, category);


--
-- Name: idx_expenses_site_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_expenses_site_created ON public.expenses USING btree (site_id, created_at DESC);


--
-- Name: idx_expenses_site_date; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_expenses_site_date ON public.expenses USING btree (site_id, date DESC);


--
-- Name: idx_expenses_site_mode; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_expenses_site_mode ON public.expenses USING btree (site_id, payment_mode);


--
-- Name: idx_expenses_site_to; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_expenses_site_to ON public.expenses USING btree (site_id, to_entity);


--
-- Name: idx_farmer_payments_active; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_farmer_payments_active ON public.farmer_payments USING btree (farmer_id) WHERE ((cheque_status IS NULL) OR ((cheque_status)::text <> ALL ((ARRAY['BOUNCED'::character varying, 'RETURNED'::character varying])::text[])));


--
-- Name: idx_farmer_payments_assigned_admin_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_farmer_payments_assigned_admin_id ON public.farmer_payments USING btree (assigned_admin_id);


--
-- Name: idx_farmer_payments_date; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_farmer_payments_date ON public.farmer_payments USING btree (date);


--
-- Name: idx_farmer_payments_farmer; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_farmer_payments_farmer ON public.farmer_payments USING btree (farmer_id);


--
-- Name: idx_farmer_payments_farmer_date; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_farmer_payments_farmer_date ON public.farmer_payments USING btree (farmer_id, date);


--
-- Name: idx_farmer_payments_mapped_member_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_farmer_payments_mapped_member_id ON public.farmer_payments USING btree (mapped_member_id) WHERE (mapped_member_id IS NOT NULL);


--
-- Name: idx_farmer_payments_mapped_user_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_farmer_payments_mapped_user_id ON public.farmer_payments USING btree (mapped_user_id) WHERE (mapped_user_id IS NOT NULL);


--
-- Name: idx_farmer_payments_site_date; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_farmer_payments_site_date ON public.farmer_payments USING btree (farmer_id, date);


--
-- Name: idx_farmer_payments_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_farmer_payments_status ON public.farmer_payments USING btree (status);


--
-- Name: idx_farmers_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_farmers_created ON public.farmers USING btree (created_by);


--
-- Name: idx_farmers_site; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_farmers_site ON public.farmers USING btree (site_id);


--
-- Name: idx_farmers_site_created_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_farmers_site_created_at ON public.farmers USING btree (site_id, created_at DESC);


--
-- Name: idx_farmers_site_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_farmers_site_status ON public.farmers USING btree (site_id, status);


--
-- Name: idx_farmers_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_farmers_status ON public.farmers USING btree (status);


--
-- Name: idx_file_folders_created_by; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_file_folders_created_by ON public.file_folders USING btree (created_by);


--
-- Name: idx_file_folders_parent; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_file_folders_parent ON public.file_folders USING btree (parent_id);


--
-- Name: idx_file_folders_site; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_file_folders_site ON public.file_folders USING btree (site_id);


--
-- Name: idx_firm_transactions_assigned_admin_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_firm_transactions_assigned_admin_id ON public.firm_transactions USING btree (assigned_admin_id);


--
-- Name: idx_firm_transactions_mapped_member_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_firm_transactions_mapped_member_id ON public.firm_transactions USING btree (mapped_member_id) WHERE (mapped_member_id IS NOT NULL);


--
-- Name: idx_firm_transactions_mapped_user_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_firm_transactions_mapped_user_id ON public.firm_transactions USING btree (mapped_user_id) WHERE (mapped_user_id IS NOT NULL);


--
-- Name: idx_firm_transactions_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_firm_transactions_status ON public.firm_transactions USING btree (status);


--
-- Name: idx_firm_txn_site_date; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_firm_txn_site_date ON public.firm_transactions USING btree (site_id, date);


--
-- Name: idx_firms_site; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_firms_site ON public.firms USING btree (site_id);


--
-- Name: idx_firms_site_name_upper; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_firms_site_name_upper ON public.firms USING btree (site_id, upper((name)::text));


--
-- Name: idx_fp_active_for_unified; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_fp_active_for_unified ON public.farmer_payments USING btree (farmer_id, date DESC) WHERE (((cheque_status IS NULL) OR ((cheque_status)::text <> ALL ((ARRAY['BOUNCED'::character varying, 'RETURNED'::character varying])::text[]))) AND ((status)::text <> 'rejected'::text));


--
-- Name: idx_ft_active_firm; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_ft_active_firm ON public.firm_transactions USING btree (firm_id) WHERE ((cheque_status IS NULL) OR ((cheque_status)::text <> ALL ((ARRAY['BOUNCED'::character varying, 'RETURNED'::character varying])::text[])));


--
-- Name: idx_ft_cash_flow_entry_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_ft_cash_flow_entry_id ON public.firm_transactions USING btree (cash_flow_entry_id);


--
-- Name: idx_ft_date; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_ft_date ON public.firm_transactions USING btree (date);


--
-- Name: idx_ft_firm; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_ft_firm ON public.firm_transactions USING btree (firm_id);


--
-- Name: idx_ft_firm_date; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_ft_firm_date ON public.firm_transactions USING btree (firm_id, date, created_at);


--
-- Name: idx_ft_is_firm_to_firm_transfer; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_ft_is_firm_to_firm_transfer ON public.firm_transactions USING btree (is_firm_to_firm_transfer);


--
-- Name: idx_ft_payment_mode; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_ft_payment_mode ON public.firm_transactions USING btree (payment_mode);


--
-- Name: idx_ft_remark; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_ft_remark ON public.firm_transactions USING btree (remark);


--
-- Name: idx_ft_site; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_ft_site ON public.firm_transactions USING btree (site_id);


--
-- Name: idx_ft_site_date; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_ft_site_date ON public.firm_transactions USING btree (site_id, date DESC, created_at DESC);


--
-- Name: idx_ft_site_name; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_ft_site_name ON public.firm_transactions USING btree (site_id, name) WHERE ((name IS NOT NULL) AND ((name)::text <> ''::text));


--
-- Name: idx_ft_site_purpose; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_ft_site_purpose ON public.firm_transactions USING btree (site_id, purpose) WHERE ((purpose IS NOT NULL) AND ((purpose)::text <> ''::text));


--
-- Name: idx_ft_site_remark; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_ft_site_remark ON public.firm_transactions USING btree (site_id, remark) WHERE ((remark IS NOT NULL) AND ((remark)::text <> ''::text));


--
-- Name: idx_ft_transfer_group_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_ft_transfer_group_id ON public.firm_transactions USING btree (transfer_group_id);


--
-- Name: idx_ft_transfer_to_firm_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_ft_transfer_to_firm_id ON public.firm_transactions USING btree (transfer_to_firm_id);


--
-- Name: idx_ia_admin; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_ia_admin ON public.imprest_allocations USING btree (admin_id);


--
-- Name: idx_ia_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_ia_status ON public.imprest_allocations USING btree (status);


--
-- Name: idx_ia_sub_admin; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_ia_sub_admin ON public.imprest_allocations USING btree (sub_admin_id);


--
-- Name: idx_ier_site; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_ier_site ON public.imprest_expense_requests USING btree (site_id);


--
-- Name: idx_ier_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_ier_status ON public.imprest_expense_requests USING btree (status);


--
-- Name: idx_ier_sub_admin; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_ier_sub_admin ON public.imprest_expense_requests USING btree (sub_admin_id);


--
-- Name: idx_il_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_il_created ON public.imprest_ledger USING btree (created_at);


--
-- Name: idx_il_type; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_il_type ON public.imprest_ledger USING btree (type);


--
-- Name: idx_il_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_il_user ON public.imprest_ledger USING btree (user_id);


--
-- Name: idx_imprest_allocations_assigned_admin_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_imprest_allocations_assigned_admin_id ON public.imprest_allocations USING btree (assigned_admin_id);


--
-- Name: idx_imprest_expense_requests_assigned_admin_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_imprest_expense_requests_assigned_admin_id ON public.imprest_expense_requests USING btree (assigned_admin_id);


--
-- Name: idx_inv_mov_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_inv_mov_created ON public.inventory_movements USING btree (created_at);


--
-- Name: idx_inv_mov_material; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_inv_mov_material ON public.inventory_movements USING btree (material_id);


--
-- Name: idx_inv_mov_project; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_inv_mov_project ON public.inventory_movements USING btree (project_id) WHERE (project_id IS NOT NULL);


--
-- Name: idx_inv_mov_site; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_inv_mov_site ON public.inventory_movements USING btree (site_id);


--
-- Name: idx_inventory_materials_site; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_inventory_materials_site ON public.inventory_materials USING btree (site_id);


--
-- Name: idx_ir_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_ir_status ON public.imprest_returns USING btree (status);


--
-- Name: idx_ir_sub_admin; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_ir_sub_admin ON public.imprest_returns USING btree (sub_admin_id);


--
-- Name: idx_kyc_cases_booking; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_kyc_cases_booking ON public.kyc_cases USING btree (booking_id);


--
-- Name: idx_kyc_cases_created_by; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_kyc_cases_created_by ON public.kyc_cases USING btree (created_by);


--
-- Name: idx_kyc_cases_member; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_kyc_cases_member ON public.kyc_cases USING btree (client_member_id);


--
-- Name: idx_kyc_cases_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_kyc_cases_status ON public.kyc_cases USING btree (status);


--
-- Name: idx_login_otps_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_login_otps_user ON public.login_otps USING btree (user_id);


--
-- Name: idx_member_categories_slug; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_member_categories_slug ON public.member_categories USING btree (slug);


--
-- Name: idx_members_name; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_members_name ON public.members USING btree (site_id, full_name);


--
-- Name: idx_members_phone; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_members_phone ON public.members USING btree (phone);


--
-- Name: idx_members_referred_by; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_members_referred_by ON public.members USING btree (referred_by_user_id);


--
-- Name: idx_members_site; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_members_site ON public.members USING btree (site_id);


--
-- Name: idx_members_site_created_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_members_site_created_at ON public.members USING btree (site_id, created_at DESC);


--
-- Name: idx_members_site_full_name_upper; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_members_site_full_name_upper ON public.members USING btree (site_id, upper((full_name)::text));


--
-- Name: idx_members_site_phone_lookup; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_members_site_phone_lookup ON public.members USING btree (site_id, phone) WHERE (phone IS NOT NULL);


--
-- Name: idx_members_site_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_members_site_status ON public.members USING btree (site_id, status);


--
-- Name: idx_members_site_type_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_members_site_type_status ON public.members USING btree (site_id, member_type, status);


--
-- Name: idx_members_type; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_members_type ON public.members USING btree (member_type);


--
-- Name: idx_ocr_results_document; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_ocr_results_document ON public.ocr_results USING btree (document_id);


--
-- Name: idx_payment_qrs_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_payment_qrs_created ON public.payment_qrs USING btree (created_at DESC);


--
-- Name: idx_payment_qrs_site_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_payment_qrs_site_status ON public.payment_qrs USING btree (site_id, status);


--
-- Name: idx_pcp_active_approved; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_pcp_active_approved ON public.plot_commission_payments USING btree (plot_commission_id) WHERE (((status)::text = 'approved'::text) AND ((cheque_status IS NULL) OR ((cheque_status)::text <> ALL ((ARRAY['BOUNCED'::character varying, 'RETURNED'::character varying])::text[]))));


--
-- Name: idx_pcp_active_for_unified; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_pcp_active_for_unified ON public.plot_commission_payments USING btree (site_id, date DESC) WHERE (((cheque_status IS NULL) OR ((cheque_status)::text <> ALL ((ARRAY['BOUNCED'::character varying, 'RETURNED'::character varying])::text[]))) AND ((status)::text <> 'rejected'::text));


--
-- Name: idx_pcp_master_date; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_pcp_master_date ON public.plot_commission_payments USING btree (plot_commission_id, date DESC, created_at DESC);


--
-- Name: idx_pcp_master_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_pcp_master_id ON public.plot_commission_payments USING btree (plot_commission_id);


--
-- Name: idx_pcp_master_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_pcp_master_status ON public.plot_commission_payments USING btree (plot_commission_id, status);


--
-- Name: idx_pcp_site_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_pcp_site_id ON public.plot_commission_payments USING btree (site_id);


--
-- Name: idx_pcp_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_pcp_status ON public.plot_commission_payments USING btree (status);


--
-- Name: idx_pcv2_agent_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_pcv2_agent_id ON public.plot_commissions_v2 USING btree (agent_id);


--
-- Name: idx_pcv2_plot_agent; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_pcv2_plot_agent ON public.plot_commissions_v2 USING btree (plot_id, agent_id);


--
-- Name: idx_pcv2_plot_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_pcv2_plot_id ON public.plot_commissions_v2 USING btree (plot_id);


--
-- Name: idx_pcv2_plot_site; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_pcv2_plot_site ON public.plot_commissions_v2 USING btree (plot_id, site_id);


--
-- Name: idx_pcv2_site_created_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_pcv2_site_created_at ON public.plot_commissions_v2 USING btree (site_id, created_at DESC);


--
-- Name: idx_pcv2_site_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_pcv2_site_id ON public.plot_commissions_v2 USING btree (site_id);


--
-- Name: idx_pi_due_date; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_pi_due_date ON public.plot_installments USING btree (due_date);


--
-- Name: idx_pi_plot; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_pi_plot ON public.plot_installments USING btree (plot_id);


--
-- Name: idx_pi_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_pi_status ON public.plot_installments USING btree (status);


--
-- Name: idx_pip_installment; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_pip_installment ON public.plot_installment_payments USING btree (installment_id);


--
-- Name: idx_pip_plot; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_pip_plot ON public.plot_installment_payments USING btree (plot_id);


--
-- Name: idx_plot_commission_payments_assigned_admin_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_plot_commission_payments_assigned_admin_id ON public.plot_commission_payments USING btree (assigned_admin_id);


--
-- Name: idx_plot_commission_payments_mapped_member_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_plot_commission_payments_mapped_member_id ON public.plot_commission_payments USING btree (mapped_member_id) WHERE (mapped_member_id IS NOT NULL);


--
-- Name: idx_plot_commission_payments_mapped_user_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_plot_commission_payments_mapped_user_id ON public.plot_commission_payments USING btree (mapped_user_id) WHERE (mapped_user_id IS NOT NULL);


--
-- Name: idx_plot_commissions_assigned_admin_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_plot_commissions_assigned_admin_id ON public.plot_commissions USING btree (assigned_admin_id);


--
-- Name: idx_plot_commissions_date; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_plot_commissions_date ON public.plot_commissions USING btree (date);


--
-- Name: idx_plot_commissions_plot; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_plot_commissions_plot ON public.plot_commissions USING btree (plot_no);


--
-- Name: idx_plot_commissions_site; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_plot_commissions_site ON public.plot_commissions USING btree (site_id);


--
-- Name: idx_plot_commissions_site_date; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_plot_commissions_site_date ON public.plot_commissions USING btree (site_id, date);


--
-- Name: idx_plot_commissions_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_plot_commissions_status ON public.plot_commissions USING btree (status);


--
-- Name: idx_plot_installments_plot; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_plot_installments_plot ON public.plot_installments USING btree (plot_id, sort_order, due_date);


--
-- Name: idx_plot_payments_assigned_admin_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_plot_payments_assigned_admin_id ON public.plot_payments USING btree (assigned_admin_id);


--
-- Name: idx_plot_payments_mapped_member_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_plot_payments_mapped_member_id ON public.plot_payments USING btree (mapped_member_id) WHERE (mapped_member_id IS NOT NULL);


--
-- Name: idx_plot_payments_mapped_user_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_plot_payments_mapped_user_id ON public.plot_payments USING btree (mapped_user_id) WHERE (mapped_user_id IS NOT NULL);


--
-- Name: idx_plot_payments_site_date; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_plot_payments_site_date ON public.plot_payments USING btree (site_id, date);


--
-- Name: idx_plot_payments_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_plot_payments_status ON public.plot_payments USING btree (status);


--
-- Name: idx_plot_registries_assigned_admin_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_plot_registries_assigned_admin_id ON public.plot_registries USING btree (assigned_admin_id);


--
-- Name: idx_plot_registries_plot; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_plot_registries_plot ON public.plot_registries USING btree (site_id, plot_no);


--
-- Name: idx_plot_registries_site; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_plot_registries_site ON public.plot_registries USING btree (site_id);


--
-- Name: idx_plot_registry_payments_assigned_admin_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_plot_registry_payments_assigned_admin_id ON public.plot_registry_payments USING btree (assigned_admin_id);


--
-- Name: idx_plot_registry_payments_registry; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_plot_registry_payments_registry ON public.plot_registry_payments USING btree (registry_id);


--
-- Name: idx_plot_registry_payments_site; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_plot_registry_payments_site ON public.plot_registry_payments USING btree (site_id);


--
-- Name: idx_plots_assigned_admin_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_plots_assigned_admin_id ON public.plots USING btree (assigned_admin_id);


--
-- Name: idx_plots_fts_candidates; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_plots_fts_candidates ON public.plots USING btree (site_id) WHERE ((installments_enabled = true) AND (free_to_sale_days > 0) AND ((status)::text <> ALL ((ARRAY['UNDER CANCELLATION'::character varying, 'CANCELLED'::character varying, 'RESALE'::character varying, 'TRANSFERRED'::character varying, 'COMPANY'::character varying])::text[])));


--
-- Name: idx_plots_plot_no; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_plots_plot_no ON public.plots USING btree (plot_no);


--
-- Name: idx_plots_site; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_plots_site ON public.plots USING btree (site_id);


--
-- Name: idx_plots_site_plot_no_upper; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_plots_site_plot_no_upper ON public.plots USING btree (site_id, upper((plot_no)::text));


--
-- Name: idx_plots_site_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_plots_site_status ON public.plots USING btree (site_id, status);


--
-- Name: idx_plots_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_plots_status ON public.plots USING btree (status);


--
-- Name: idx_pp_active_plot; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_pp_active_plot ON public.plot_payments USING btree (plot_id) WHERE ((cheque_status IS NULL) OR ((cheque_status)::text <> ALL ((ARRAY['BOUNCED'::character varying, 'RETURNED'::character varying])::text[])));


--
-- Name: idx_pp_date; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_pp_date ON public.plot_payments USING btree (date);


--
-- Name: idx_pp_plot; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_pp_plot ON public.plot_payments USING btree (plot_id);


--
-- Name: idx_pp_plot_date; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_pp_plot_date ON public.plot_payments USING btree (plot_id, date, created_at);


--
-- Name: idx_pp_plot_type; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_pp_plot_type ON public.plot_payments USING btree (plot_id, payment_type);


--
-- Name: idx_pp_site; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_pp_site ON public.plot_payments USING btree (site_id);


--
-- Name: idx_pp_site_booked_by; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_pp_site_booked_by ON public.plot_payments USING btree (site_id, booked_by) WHERE ((booked_by IS NOT NULL) AND ((booked_by)::text <> ''::text));


--
-- Name: idx_pp_site_payment_from; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_pp_site_payment_from ON public.plot_payments USING btree (site_id, payment_from) WHERE ((payment_from IS NOT NULL) AND ((payment_from)::text <> ''::text));


--
-- Name: idx_pp_site_received_by; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_pp_site_received_by ON public.plot_payments USING btree (site_id, received_by) WHERE ((received_by IS NOT NULL) AND ((received_by)::text <> ''::text));


--
-- Name: idx_pr_site_created_entry_date; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_pr_site_created_entry_date ON public.plot_registries USING btree (site_id, created_entry_date DESC);


--
-- Name: idx_pr_site_customer; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_pr_site_customer ON public.plot_registries USING btree (site_id, customer_name) WHERE ((customer_name IS NOT NULL) AND ((customer_name)::text <> ''::text));


--
-- Name: idx_pr_site_farmer; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_pr_site_farmer ON public.plot_registries USING btree (site_id, farmer_name) WHERE ((farmer_name IS NOT NULL) AND ((farmer_name)::text <> ''::text));


--
-- Name: idx_pr_site_plot_no_upper; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_pr_site_plot_no_upper ON public.plot_registries USING btree (site_id, upper((plot_no)::text));


--
-- Name: idx_prp_registry_date; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_prp_registry_date ON public.plot_registry_payments USING btree (registry_id, payment_date, created_at);


--
-- Name: idx_prp_site_mode; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_prp_site_mode ON public.plot_registry_payments USING btree (site_id, payment_mode) WHERE ((payment_mode IS NOT NULL) AND ((payment_mode)::text <> ''::text));


--
-- Name: idx_prp_source_plot_payment; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_prp_source_plot_payment ON public.plot_registry_payments USING btree (source_plot_payment_id) WHERE (source_plot_payment_id IS NOT NULL);


--
-- Name: idx_registry_handovers_registry; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_registry_handovers_registry ON public.registry_document_handovers USING btree (registry_id);


--
-- Name: idx_sites_created_by; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_sites_created_by ON public.sites USING btree (created_by);


--
-- Name: idx_sites_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_sites_status ON public.sites USING btree (status);


--
-- Name: idx_sms_reminder_log_site_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_sms_reminder_log_site_created ON public.sms_reminder_log USING btree (site_id, created_at DESC);


--
-- Name: idx_upi_accounts_site; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_upi_accounts_site ON public.upi_accounts USING btree (site_id, is_active);


--
-- Name: idx_user_sessions_login_time; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_user_sessions_login_time ON public.user_sessions USING btree (login_time);


--
-- Name: idx_user_sessions_user_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_user_sessions_user_id ON public.user_sessions USING btree (user_id);


--
-- Name: idx_user_sites_site; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_user_sites_site ON public.user_sites USING btree (site_id);


--
-- Name: idx_user_sites_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_user_sites_user ON public.user_sites USING btree (user_id);


--
-- Name: idx_users_created_by; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_users_created_by ON public.users USING btree (created_by);


--
-- Name: idx_users_email; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_users_email ON public.users USING btree (email);


--
-- Name: idx_users_role; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_users_role ON public.users USING btree (role);


--
-- Name: idx_vc_site_created_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_vc_site_created_at ON public.vendor_commitments USING btree (site_id, created_at DESC);


--
-- Name: idx_vc_site_head; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_vc_site_head ON public.vendor_commitments USING btree (site_id, head_id);


--
-- Name: idx_vc_site_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_vc_site_status ON public.vendor_commitments USING btree (site_id, status);


--
-- Name: idx_vendor_commitments_assigned_admin_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_vendor_commitments_assigned_admin_id ON public.vendor_commitments USING btree (assigned_admin_id);


--
-- Name: idx_vendor_commitments_site_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_vendor_commitments_site_id ON public.vendor_commitments USING btree (site_id);


--
-- Name: idx_vendor_commitments_vendor_member_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_vendor_commitments_vendor_member_id ON public.vendor_commitments USING btree (vendor_member_id);


--
-- Name: idx_vendor_payments_assigned_admin_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_vendor_payments_assigned_admin_id ON public.vendor_payments USING btree (assigned_admin_id);


--
-- Name: idx_vendor_payments_commitment_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_vendor_payments_commitment_id ON public.vendor_payments USING btree (commitment_id);


--
-- Name: idx_vendor_payments_date; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_vendor_payments_date ON public.vendor_payments USING btree (payment_date);


--
-- Name: idx_vendor_payments_mapped_member_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_vendor_payments_mapped_member_id ON public.vendor_payments USING btree (mapped_member_id) WHERE (mapped_member_id IS NOT NULL);


--
-- Name: idx_vendor_payments_mapped_user_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_vendor_payments_mapped_user_id ON public.vendor_payments USING btree (mapped_user_id) WHERE (mapped_user_id IS NOT NULL);


--
-- Name: idx_vendor_payments_site_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_vendor_payments_site_id ON public.vendor_payments USING btree (site_id);


--
-- Name: idx_vendor_payments_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_vendor_payments_status ON public.vendor_payments USING btree (status);


--
-- Name: idx_vid_order_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_vid_order_id ON public.vendor_inventory_deliveries USING btree (order_id);


--
-- Name: idx_vio_commitment_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_vio_commitment_id ON public.vendor_inventory_orders USING btree (commitment_id);


--
-- Name: idx_vio_commitment_site; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_vio_commitment_site ON public.vendor_inventory_orders USING btree (commitment_id, site_id);


--
-- Name: idx_vio_order_date; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_vio_order_date ON public.vendor_inventory_orders USING btree (order_date DESC);


--
-- Name: idx_vio_site_category; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_vio_site_category ON public.vendor_inventory_orders USING btree (site_id, lower((item_category)::text));


--
-- Name: idx_vio_site_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_vio_site_id ON public.vendor_inventory_orders USING btree (site_id);


--
-- Name: idx_vio_site_status_date; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_vio_site_status_date ON public.vendor_inventory_orders USING btree (site_id, status, order_date DESC);


--
-- Name: idx_vio_vendor_member_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_vio_vendor_member_id ON public.vendor_inventory_orders USING btree (vendor_member_id);


--
-- Name: idx_vipay_order_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_vipay_order_id ON public.vendor_inventory_payments USING btree (order_id);


--
-- Name: idx_vipay_site_date; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_vipay_site_date ON public.vendor_inventory_payments USING btree (site_id, payment_date DESC);


--
-- Name: idx_vp_active_for_unified; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_vp_active_for_unified ON public.vendor_payments USING btree (site_id, payment_date DESC) WHERE (((cheque_status IS NULL) OR ((cheque_status)::text <> ALL ((ARRAY['BOUNCED'::character varying, 'RETURNED'::character varying])::text[]))) AND ((status)::text <> 'rejected'::text));


--
-- Name: idx_vp_commitment_active; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_vp_commitment_active ON public.vendor_payments USING btree (commitment_id) WHERE ((cheque_status IS NULL) OR ((cheque_status)::text <> ALL ((ARRAY['BOUNCED'::character varying, 'RETURNED'::character varying])::text[])));


--
-- Name: idx_vp_site_date; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_vp_site_date ON public.vendor_payments USING btree (site_id, payment_date DESC);


--
-- Name: team_members_user_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX team_members_user_idx ON public.team_members USING btree (user_id);


--
-- Name: uq_cfe_source_module_source_id; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uq_cfe_source_module_source_id ON public.cash_flow_entries USING btree (source_module, source_id);


--
-- Name: uq_draw_reg_allotted_plot; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uq_draw_reg_allotted_plot ON public.draw_registrations USING btree (allotted_plot_id) WHERE ((status)::text = 'ALLOTTED'::text);


--
-- Name: uq_inventory_materials_site_name; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uq_inventory_materials_site_name ON public.inventory_materials USING btree (site_id, upper((name)::text));


--
-- Name: uq_prp_source_plot_payment; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uq_prp_source_plot_payment ON public.plot_registry_payments USING btree (source_plot_payment_id) WHERE (source_plot_payment_id IS NOT NULL);


--
-- Name: uq_vendor_heads_site_name; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uq_vendor_heads_site_name ON public.vendor_heads USING btree (site_id, name);


--
-- Name: users_parent_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX users_parent_idx ON public.users USING btree (parent_user_id);


--
-- Name: users_referral_code_uq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX users_referral_code_uq ON public.users USING btree (referral_code) WHERE (referral_code IS NOT NULL);


--
-- Name: users_team_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX users_team_idx ON public.users USING btree (team_id);


--
-- Name: cash_flow_entries trg_cash_flow_entries_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_cash_flow_entries_updated_at BEFORE UPDATE ON public.cash_flow_entries FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();


--
-- Name: cash_flow_months trg_cash_flow_months_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_cash_flow_months_updated_at BEFORE UPDATE ON public.cash_flow_months FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();


--
-- Name: day_book trg_day_book_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_day_book_updated_at BEFORE UPDATE ON public.day_book FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();


--
-- Name: excel_files trg_excel_files_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_excel_files_updated_at BEFORE UPDATE ON public.excel_files FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();


--
-- Name: expenses trg_expenses_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_expenses_updated_at BEFORE UPDATE ON public.expenses FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();


--
-- Name: farmer_payments trg_farmer_payments_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_farmer_payments_updated_at BEFORE UPDATE ON public.farmer_payments FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();


--
-- Name: farmers trg_farmers_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_farmers_updated_at BEFORE UPDATE ON public.farmers FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();


--
-- Name: firm_transactions trg_firm_transactions_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_firm_transactions_updated_at BEFORE UPDATE ON public.firm_transactions FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();


--
-- Name: firms trg_firms_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_firms_updated_at BEFORE UPDATE ON public.firms FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();


--
-- Name: imprest_allocations trg_imprest_allocations_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_imprest_allocations_updated_at BEFORE UPDATE ON public.imprest_allocations FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();


--
-- Name: imprest_expense_requests trg_imprest_expense_requests_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_imprest_expense_requests_updated_at BEFORE UPDATE ON public.imprest_expense_requests FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();


--
-- Name: imprest_returns trg_imprest_returns_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_imprest_returns_updated_at BEFORE UPDATE ON public.imprest_returns FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();


--
-- Name: plot_payments trg_linked_plot_payment_move_scope; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_linked_plot_payment_move_scope BEFORE DELETE OR UPDATE OF site_id, plot_id ON public.plot_payments FOR EACH ROW EXECUTE FUNCTION public.enforce_linked_plot_payment_move_scope();


--
-- Name: plot_commissions trg_plot_commissions_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_plot_commissions_updated_at BEFORE UPDATE ON public.plot_commissions FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();


--
-- Name: plot_installments trg_plot_installments_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_plot_installments_updated_at BEFORE UPDATE ON public.plot_installments FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();


--
-- Name: plot_payments trg_plot_payments_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_plot_payments_updated_at BEFORE UPDATE ON public.plot_payments FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();


--
-- Name: plots trg_plot_registry_reference_guard; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_plot_registry_reference_guard BEFORE DELETE OR UPDATE OF site_id, plot_no ON public.plots FOR EACH ROW EXECUTE FUNCTION public.prevent_referenced_plot_identity_change();


--
-- Name: plots trg_plots_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_plots_updated_at BEFORE UPDATE ON public.plots FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();


--
-- Name: plot_registries trg_registry_00_reference_scope; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_registry_00_reference_scope BEFORE INSERT OR UPDATE OF site_id, plot_id, plot_no ON public.plot_registries FOR EACH ROW EXECUTE FUNCTION public.enforce_registry_plot_reference_scope();


--
-- Name: plot_registries trg_registry_10_plot_change_scope; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_registry_10_plot_change_scope BEFORE UPDATE OF site_id, plot_id, plot_no ON public.plot_registries FOR EACH ROW EXECUTE FUNCTION public.enforce_registry_plot_change_scope();


--
-- Name: plot_registry_payments trg_registry_payment_plot_scope; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_registry_payment_plot_scope BEFORE INSERT OR UPDATE OF registry_id, source_plot_payment_id, site_id ON public.plot_registry_payments FOR EACH ROW EXECUTE FUNCTION public.enforce_registry_payment_plot_scope();


--
-- Name: sites trg_sites_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_sites_updated_at BEFORE UPDATE ON public.sites FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();


--
-- Name: day_book trg_sync_cfe_day_book; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_sync_cfe_day_book AFTER INSERT OR DELETE OR UPDATE ON public.day_book FOR EACH ROW EXECUTE FUNCTION public.sync_cashflow_from_modules();


--
-- Name: expenses trg_sync_cfe_expenses; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_sync_cfe_expenses AFTER INSERT OR DELETE OR UPDATE ON public.expenses FOR EACH ROW EXECUTE FUNCTION public.sync_cashflow_from_modules();


--
-- Name: farmer_payments trg_sync_cfe_farmer_payments; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_sync_cfe_farmer_payments AFTER INSERT OR DELETE OR UPDATE ON public.farmer_payments FOR EACH ROW EXECUTE FUNCTION public.sync_cashflow_from_modules();


--
-- Name: firm_transactions trg_sync_cfe_firm_transactions; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_sync_cfe_firm_transactions AFTER INSERT OR DELETE OR UPDATE ON public.firm_transactions FOR EACH ROW EXECUTE FUNCTION public.sync_cashflow_from_modules();


--
-- Name: plot_commission_payments trg_sync_cfe_plot_commission_payments; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_sync_cfe_plot_commission_payments AFTER INSERT OR DELETE OR UPDATE ON public.plot_commission_payments FOR EACH ROW EXECUTE FUNCTION public.sync_cashflow_from_modules();


--
-- Name: plot_commissions trg_sync_cfe_plot_commissions; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_sync_cfe_plot_commissions AFTER INSERT OR DELETE OR UPDATE ON public.plot_commissions FOR EACH ROW EXECUTE FUNCTION public.sync_cashflow_from_modules();


--
-- Name: plot_installment_payments trg_sync_cfe_plot_installment_payments; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_sync_cfe_plot_installment_payments AFTER INSERT OR DELETE OR UPDATE ON public.plot_installment_payments FOR EACH ROW EXECUTE FUNCTION public.sync_cashflow_from_modules();


--
-- Name: plot_payments trg_sync_cfe_plot_payments; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_sync_cfe_plot_payments AFTER INSERT OR DELETE OR UPDATE ON public.plot_payments FOR EACH ROW EXECUTE FUNCTION public.sync_cashflow_from_modules();


--
-- Name: plot_registry_payments trg_sync_cfe_plot_registry_payments; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_sync_cfe_plot_registry_payments AFTER INSERT OR DELETE OR UPDATE ON public.plot_registry_payments FOR EACH ROW EXECUTE FUNCTION public.sync_cashflow_from_modules();


--
-- Name: day_book trg_sync_cfe_status_day_book; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_sync_cfe_status_day_book AFTER INSERT OR UPDATE ON public.day_book FOR EACH ROW EXECUTE FUNCTION public.sync_cashflow_status_from_source();


--
-- Name: expenses trg_sync_cfe_status_expenses; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_sync_cfe_status_expenses AFTER INSERT OR UPDATE ON public.expenses FOR EACH ROW EXECUTE FUNCTION public.sync_cashflow_status_from_source();


--
-- Name: firm_transactions trg_sync_cfe_status_firm_transactions; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_sync_cfe_status_firm_transactions AFTER INSERT OR UPDATE ON public.firm_transactions FOR EACH ROW EXECUTE FUNCTION public.sync_cashflow_status_from_source();


--
-- Name: plot_payments trg_sync_cfe_status_plot_payments; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_sync_cfe_status_plot_payments AFTER INSERT OR UPDATE ON public.plot_payments FOR EACH ROW EXECUTE FUNCTION public.sync_cashflow_status_from_source();


--
-- Name: vendor_payments trg_sync_cfe_status_vendor_payments; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_sync_cfe_status_vendor_payments AFTER INSERT OR UPDATE ON public.vendor_payments FOR EACH ROW EXECUTE FUNCTION public.sync_cashflow_status_from_source();


--
-- Name: vendor_payments trg_sync_cfe_vendor_payments; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_sync_cfe_vendor_payments AFTER INSERT OR DELETE OR UPDATE ON public.vendor_payments FOR EACH ROW EXECUTE FUNCTION public.sync_cashflow_from_modules();


--
-- Name: vendor_payments trg_sync_daybook_vendor_payments; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_sync_daybook_vendor_payments AFTER INSERT OR UPDATE ON public.vendor_payments FOR EACH ROW EXECUTE FUNCTION public.sync_daybook_from_vendor_payments();


--
-- Name: vendor_inventory_deliveries trg_sync_inv_delivery; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_sync_inv_delivery AFTER INSERT OR DELETE OR UPDATE ON public.vendor_inventory_deliveries FOR EACH ROW EXECUTE FUNCTION public.sync_vendor_inventory_order();


--
-- Name: vendor_inventory_payments trg_sync_inv_payment; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_sync_inv_payment AFTER INSERT OR DELETE OR UPDATE ON public.vendor_inventory_payments FOR EACH ROW EXECUTE FUNCTION public.sync_vendor_inventory_order();


--
-- Name: users trg_users_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_users_updated_at BEFORE UPDATE ON public.users FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();


--
-- Name: members update_members_modtime; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER update_members_modtime BEFORE UPDATE ON public.members FOR EACH ROW EXECUTE FUNCTION public.update_modified_column();


--
-- Name: plot_registries update_plot_registries_modtime; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER update_plot_registries_modtime BEFORE UPDATE ON public.plot_registries FOR EACH ROW EXECUTE FUNCTION public.update_modified_column();


--
-- Name: plot_registry_payments update_plot_registry_payments_modtime; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER update_plot_registry_payments_modtime BEFORE UPDATE ON public.plot_registry_payments FOR EACH ROW EXECUTE FUNCTION public.update_modified_column();


--
-- Name: agent_ledger_entries agent_ledger_entries_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_ledger_entries
    ADD CONSTRAINT agent_ledger_entries_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: application_settings application_settings_site_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.application_settings
    ADD CONSTRAINT application_settings_site_id_fkey FOREIGN KEY (site_id) REFERENCES public.sites(id) ON DELETE CASCADE;


--
-- Name: application_settings application_settings_updated_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.application_settings
    ADD CONSTRAINT application_settings_updated_by_fkey FOREIGN KEY (updated_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: bookings bookings_agent_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bookings
    ADD CONSTRAINT bookings_agent_user_id_fkey FOREIGN KEY (agent_user_id) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: bookings bookings_booking_agent_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bookings
    ADD CONSTRAINT bookings_booking_agent_id_fkey FOREIGN KEY (booking_agent_id) REFERENCES public.members(id) ON DELETE SET NULL;


--
-- Name: bookings bookings_client_member_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bookings
    ADD CONSTRAINT bookings_client_member_id_fkey FOREIGN KEY (client_member_id) REFERENCES public.members(id) ON DELETE RESTRICT;


--
-- Name: bookings bookings_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bookings
    ADD CONSTRAINT bookings_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: bookings bookings_plot_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bookings
    ADD CONSTRAINT bookings_plot_id_fkey FOREIGN KEY (plot_id) REFERENCES public.plots(id) ON DELETE SET NULL;


--
-- Name: bookings bookings_site_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bookings
    ADD CONSTRAINT bookings_site_id_fkey FOREIGN KEY (site_id) REFERENCES public.sites(id) ON DELETE RESTRICT;


--
-- Name: bookings bookings_team_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bookings
    ADD CONSTRAINT bookings_team_id_fkey FOREIGN KEY (team_id) REFERENCES public.teams(id) ON DELETE SET NULL;


--
-- Name: bookings bookings_token_payment_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bookings
    ADD CONSTRAINT bookings_token_payment_id_fkey FOREIGN KEY (token_payment_id) REFERENCES public.plot_payments(id) ON DELETE SET NULL;


--
-- Name: cash_flow_entries cash_flow_entries_approved_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cash_flow_entries
    ADD CONSTRAINT cash_flow_entries_approved_by_fkey FOREIGN KEY (approved_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: cash_flow_entries cash_flow_entries_assigned_admin_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cash_flow_entries
    ADD CONSTRAINT cash_flow_entries_assigned_admin_id_fkey FOREIGN KEY (assigned_admin_id) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: cash_flow_entries cash_flow_entries_cash_flow_month_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cash_flow_entries
    ADD CONSTRAINT cash_flow_entries_cash_flow_month_id_fkey FOREIGN KEY (cash_flow_month_id) REFERENCES public.cash_flow_months(id) ON DELETE CASCADE;


--
-- Name: cash_flow_entries cash_flow_entries_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cash_flow_entries
    ADD CONSTRAINT cash_flow_entries_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: cash_flow_entries cash_flow_entries_from_firm_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cash_flow_entries
    ADD CONSTRAINT cash_flow_entries_from_firm_id_fkey FOREIGN KEY (from_firm_id) REFERENCES public.firms(id) ON DELETE SET NULL;


--
-- Name: cash_flow_entries cash_flow_entries_site_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cash_flow_entries
    ADD CONSTRAINT cash_flow_entries_site_id_fkey FOREIGN KEY (site_id) REFERENCES public.sites(id) ON DELETE CASCADE;


--
-- Name: cash_flow_entries cash_flow_entries_to_firm_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cash_flow_entries
    ADD CONSTRAINT cash_flow_entries_to_firm_id_fkey FOREIGN KEY (to_firm_id) REFERENCES public.firms(id) ON DELETE SET NULL;


--
-- Name: cash_flow_months cash_flow_months_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cash_flow_months
    ADD CONSTRAINT cash_flow_months_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: cash_flow_months cash_flow_months_linked_member_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cash_flow_months
    ADD CONSTRAINT cash_flow_months_linked_member_id_fkey FOREIGN KEY (linked_member_id) REFERENCES public.members(id) ON DELETE SET NULL;


--
-- Name: cash_flow_months cash_flow_months_linked_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cash_flow_months
    ADD CONSTRAINT cash_flow_months_linked_user_id_fkey FOREIGN KEY (linked_user_id) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: cash_flow_months cash_flow_months_site_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cash_flow_months
    ADD CONSTRAINT cash_flow_months_site_id_fkey FOREIGN KEY (site_id) REFERENCES public.sites(id) ON DELETE CASCADE;


--
-- Name: construction_material_request_items construction_material_request_items_material_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.construction_material_request_items
    ADD CONSTRAINT construction_material_request_items_material_id_fkey FOREIGN KEY (material_id) REFERENCES public.inventory_materials(id) ON DELETE RESTRICT;


--
-- Name: construction_material_request_items construction_material_request_items_request_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.construction_material_request_items
    ADD CONSTRAINT construction_material_request_items_request_id_fkey FOREIGN KEY (request_id) REFERENCES public.construction_material_requests(id) ON DELETE CASCADE;


--
-- Name: construction_material_requests construction_material_requests_project_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.construction_material_requests
    ADD CONSTRAINT construction_material_requests_project_id_fkey FOREIGN KEY (project_id) REFERENCES public.construction_projects(id) ON DELETE CASCADE;


--
-- Name: construction_material_requests construction_material_requests_requested_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.construction_material_requests
    ADD CONSTRAINT construction_material_requests_requested_by_fkey FOREIGN KEY (requested_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: construction_material_requests construction_material_requests_site_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.construction_material_requests
    ADD CONSTRAINT construction_material_requests_site_id_fkey FOREIGN KEY (site_id) REFERENCES public.sites(id) ON DELETE CASCADE;


--
-- Name: construction_material_requests construction_material_requests_task_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.construction_material_requests
    ADD CONSTRAINT construction_material_requests_task_id_fkey FOREIGN KEY (task_id) REFERENCES public.construction_tasks(id) ON DELETE SET NULL;


--
-- Name: construction_projects construction_projects_assigned_admin_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.construction_projects
    ADD CONSTRAINT construction_projects_assigned_admin_id_fkey FOREIGN KEY (assigned_admin_id) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: construction_projects construction_projects_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.construction_projects
    ADD CONSTRAINT construction_projects_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: construction_projects construction_projects_site_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.construction_projects
    ADD CONSTRAINT construction_projects_site_id_fkey FOREIGN KEY (site_id) REFERENCES public.sites(id) ON DELETE CASCADE;


--
-- Name: construction_tasks construction_tasks_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.construction_tasks
    ADD CONSTRAINT construction_tasks_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: construction_tasks construction_tasks_project_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.construction_tasks
    ADD CONSTRAINT construction_tasks_project_id_fkey FOREIGN KEY (project_id) REFERENCES public.construction_projects(id) ON DELETE CASCADE;


--
-- Name: conversations conversations_user1_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.conversations
    ADD CONSTRAINT conversations_user1_id_fkey FOREIGN KEY (user1_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: conversations conversations_user2_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.conversations
    ADD CONSTRAINT conversations_user2_id_fkey FOREIGN KEY (user2_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: dashboard_component_permissions dashboard_component_permissions_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.dashboard_component_permissions
    ADD CONSTRAINT dashboard_component_permissions_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: day_book day_book_approved_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.day_book
    ADD CONSTRAINT day_book_approved_by_fkey FOREIGN KEY (approved_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: day_book day_book_assigned_admin_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.day_book
    ADD CONSTRAINT day_book_assigned_admin_id_fkey FOREIGN KEY (assigned_admin_id) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: day_book day_book_assigned_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.day_book
    ADD CONSTRAINT day_book_assigned_user_id_fkey FOREIGN KEY (assigned_user_id) REFERENCES public.members(id) ON DELETE SET NULL;


--
-- Name: day_book day_book_cash_flow_entry_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.day_book
    ADD CONSTRAINT day_book_cash_flow_entry_id_fkey FOREIGN KEY (cash_flow_entry_id) REFERENCES public.cash_flow_entries(id) ON DELETE SET NULL;


--
-- Name: day_book day_book_commission_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.day_book
    ADD CONSTRAINT day_book_commission_id_fkey FOREIGN KEY (commission_id) REFERENCES public.plot_commissions(id) ON DELETE SET NULL;


--
-- Name: day_book day_book_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.day_book
    ADD CONSTRAINT day_book_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: day_book_daily_balance day_book_daily_balance_site_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.day_book_daily_balance
    ADD CONSTRAINT day_book_daily_balance_site_id_fkey FOREIGN KEY (site_id) REFERENCES public.sites(id) ON DELETE CASCADE;


--
-- Name: day_book day_book_farmer_payment_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.day_book
    ADD CONSTRAINT day_book_farmer_payment_id_fkey FOREIGN KEY (farmer_payment_id) REFERENCES public.farmer_payments(id) ON DELETE SET NULL;


--
-- Name: day_book day_book_firm_transaction_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.day_book
    ADD CONSTRAINT day_book_firm_transaction_id_fkey FOREIGN KEY (firm_transaction_id) REFERENCES public.firm_transactions(id) ON DELETE SET NULL;


--
-- Name: day_book day_book_imprest_allocation_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.day_book
    ADD CONSTRAINT day_book_imprest_allocation_id_fkey FOREIGN KEY (imprest_allocation_id) REFERENCES public.imprest_allocations(id) ON DELETE SET NULL;


--
-- Name: day_book day_book_mapped_member_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.day_book
    ADD CONSTRAINT day_book_mapped_member_id_fkey FOREIGN KEY (mapped_member_id) REFERENCES public.members(id) ON DELETE SET NULL;


--
-- Name: day_book day_book_mapped_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.day_book
    ADD CONSTRAINT day_book_mapped_user_id_fkey FOREIGN KEY (mapped_user_id) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: day_book day_book_plot_payment_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.day_book
    ADD CONSTRAINT day_book_plot_payment_id_fkey FOREIGN KEY (plot_payment_id) REFERENCES public.plot_payments(id) ON DELETE SET NULL;


--
-- Name: day_book day_book_site_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.day_book
    ADD CONSTRAINT day_book_site_id_fkey FOREIGN KEY (site_id) REFERENCES public.sites(id) ON DELETE CASCADE;


--
-- Name: day_book day_book_vendor_payment_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.day_book
    ADD CONSTRAINT day_book_vendor_payment_id_fkey FOREIGN KEY (vendor_payment_id) REFERENCES public.vendor_payments(id) ON DELETE SET NULL;


--
-- Name: document_imprest document_imprest_issued_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.document_imprest
    ADD CONSTRAINT document_imprest_issued_by_fkey FOREIGN KEY (issued_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: document_imprest document_imprest_receiver_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.document_imprest
    ADD CONSTRAINT document_imprest_receiver_user_id_fkey FOREIGN KEY (receiver_user_id) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: document_imprest document_imprest_return_received_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.document_imprest
    ADD CONSTRAINT document_imprest_return_received_by_fkey FOREIGN KEY (return_received_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: document_imprest document_imprest_site_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.document_imprest
    ADD CONSTRAINT document_imprest_site_id_fkey FOREIGN KEY (site_id) REFERENCES public.sites(id) ON DELETE SET NULL;


--
-- Name: documents documents_client_member_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.documents
    ADD CONSTRAINT documents_client_member_id_fkey FOREIGN KEY (client_member_id) REFERENCES public.members(id) ON DELETE SET NULL;


--
-- Name: documents documents_kyc_case_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.documents
    ADD CONSTRAINT documents_kyc_case_id_fkey FOREIGN KEY (kyc_case_id) REFERENCES public.kyc_cases(id) ON DELETE CASCADE;


--
-- Name: documents documents_plot_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.documents
    ADD CONSTRAINT documents_plot_id_fkey FOREIGN KEY (plot_id) REFERENCES public.plots(id) ON DELETE SET NULL;


--
-- Name: documents documents_site_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.documents
    ADD CONSTRAINT documents_site_id_fkey FOREIGN KEY (site_id) REFERENCES public.sites(id) ON DELETE SET NULL;


--
-- Name: documents documents_uploaded_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.documents
    ADD CONSTRAINT documents_uploaded_by_fkey FOREIGN KEY (uploaded_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: draw_events draw_events_actor_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.draw_events
    ADD CONSTRAINT draw_events_actor_user_id_fkey FOREIGN KEY (actor_user_id) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: draw_events draw_events_draw_registration_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.draw_events
    ADD CONSTRAINT draw_events_draw_registration_id_fkey FOREIGN KEY (draw_registration_id) REFERENCES public.draw_registrations(id) ON DELETE CASCADE;


--
-- Name: draw_payments draw_payments_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.draw_payments
    ADD CONSTRAINT draw_payments_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: draw_payments draw_payments_draw_registration_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.draw_payments
    ADD CONSTRAINT draw_payments_draw_registration_id_fkey FOREIGN KEY (draw_registration_id) REFERENCES public.draw_registrations(id) ON DELETE CASCADE;


--
-- Name: draw_registrations draw_registrations_agent_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.draw_registrations
    ADD CONSTRAINT draw_registrations_agent_user_id_fkey FOREIGN KEY (agent_user_id) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: draw_registrations draw_registrations_allotted_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.draw_registrations
    ADD CONSTRAINT draw_registrations_allotted_by_fkey FOREIGN KEY (allotted_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: draw_registrations draw_registrations_allotted_plot_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.draw_registrations
    ADD CONSTRAINT draw_registrations_allotted_plot_id_fkey FOREIGN KEY (allotted_plot_id) REFERENCES public.plots(id) ON DELETE SET NULL;


--
-- Name: draw_registrations draw_registrations_booking_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.draw_registrations
    ADD CONSTRAINT draw_registrations_booking_id_fkey FOREIGN KEY (booking_id) REFERENCES public.bookings(id) ON DELETE SET NULL;


--
-- Name: draw_registrations draw_registrations_client_member_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.draw_registrations
    ADD CONSTRAINT draw_registrations_client_member_id_fkey FOREIGN KEY (client_member_id) REFERENCES public.members(id) ON DELETE RESTRICT;


--
-- Name: draw_registrations draw_registrations_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.draw_registrations
    ADD CONSTRAINT draw_registrations_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: draw_registrations draw_registrations_kyc_case_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.draw_registrations
    ADD CONSTRAINT draw_registrations_kyc_case_id_fkey FOREIGN KEY (kyc_case_id) REFERENCES public.kyc_cases(id) ON DELETE SET NULL;


--
-- Name: draw_registrations draw_registrations_site_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.draw_registrations
    ADD CONSTRAINT draw_registrations_site_id_fkey FOREIGN KEY (site_id) REFERENCES public.sites(id) ON DELETE RESTRICT;


--
-- Name: draw_registrations draw_registrations_slip_issued_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.draw_registrations
    ADD CONSTRAINT draw_registrations_slip_issued_by_fkey FOREIGN KEY (slip_issued_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: draw_registrations draw_registrations_winner_marked_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.draw_registrations
    ADD CONSTRAINT draw_registrations_winner_marked_by_fkey FOREIGN KEY (winner_marked_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: edit_requests edit_requests_requested_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.edit_requests
    ADD CONSTRAINT edit_requests_requested_by_fkey FOREIGN KEY (requested_by) REFERENCES public.users(id);


--
-- Name: edit_requests edit_requests_reviewed_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.edit_requests
    ADD CONSTRAINT edit_requests_reviewed_by_fkey FOREIGN KEY (reviewed_by) REFERENCES public.users(id);


--
-- Name: edit_requests edit_requests_site_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.edit_requests
    ADD CONSTRAINT edit_requests_site_id_fkey FOREIGN KEY (site_id) REFERENCES public.sites(id);


--
-- Name: excel_files excel_files_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.excel_files
    ADD CONSTRAINT excel_files_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: excel_files excel_files_folder_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.excel_files
    ADD CONSTRAINT excel_files_folder_id_fkey FOREIGN KEY (folder_id) REFERENCES public.file_folders(id) ON DELETE SET NULL;


--
-- Name: excel_files excel_files_site_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.excel_files
    ADD CONSTRAINT excel_files_site_id_fkey FOREIGN KEY (site_id) REFERENCES public.sites(id) ON DELETE CASCADE;


--
-- Name: excel_files excel_files_updated_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.excel_files
    ADD CONSTRAINT excel_files_updated_by_fkey FOREIGN KEY (updated_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: expenses expenses_approved_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.expenses
    ADD CONSTRAINT expenses_approved_by_fkey FOREIGN KEY (approved_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: expenses expenses_assigned_admin_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.expenses
    ADD CONSTRAINT expenses_assigned_admin_id_fkey FOREIGN KEY (assigned_admin_id) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: expenses expenses_assigned_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.expenses
    ADD CONSTRAINT expenses_assigned_user_id_fkey FOREIGN KEY (assigned_user_id) REFERENCES public.members(id) ON DELETE SET NULL;


--
-- Name: expenses expenses_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.expenses
    ADD CONSTRAINT expenses_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: expenses expenses_mapped_member_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.expenses
    ADD CONSTRAINT expenses_mapped_member_id_fkey FOREIGN KEY (mapped_member_id) REFERENCES public.members(id) ON DELETE SET NULL;


--
-- Name: expenses expenses_mapped_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.expenses
    ADD CONSTRAINT expenses_mapped_user_id_fkey FOREIGN KEY (mapped_user_id) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: expenses expenses_site_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.expenses
    ADD CONSTRAINT expenses_site_id_fkey FOREIGN KEY (site_id) REFERENCES public.sites(id) ON DELETE CASCADE;


--
-- Name: farmer_payments farmer_payments_approved_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.farmer_payments
    ADD CONSTRAINT farmer_payments_approved_by_fkey FOREIGN KEY (approved_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: farmer_payments farmer_payments_assigned_admin_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.farmer_payments
    ADD CONSTRAINT farmer_payments_assigned_admin_id_fkey FOREIGN KEY (assigned_admin_id) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: farmer_payments farmer_payments_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.farmer_payments
    ADD CONSTRAINT farmer_payments_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id);


--
-- Name: farmer_payments farmer_payments_farmer_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.farmer_payments
    ADD CONSTRAINT farmer_payments_farmer_id_fkey FOREIGN KEY (farmer_id) REFERENCES public.farmers(id) ON DELETE CASCADE;


--
-- Name: farmer_payments farmer_payments_mapped_member_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.farmer_payments
    ADD CONSTRAINT farmer_payments_mapped_member_id_fkey FOREIGN KEY (mapped_member_id) REFERENCES public.members(id) ON DELETE SET NULL;


--
-- Name: farmer_payments farmer_payments_mapped_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.farmer_payments
    ADD CONSTRAINT farmer_payments_mapped_user_id_fkey FOREIGN KEY (mapped_user_id) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: farmers farmers_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.farmers
    ADD CONSTRAINT farmers_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: farmers farmers_member_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.farmers
    ADD CONSTRAINT farmers_member_id_fkey FOREIGN KEY (member_id) REFERENCES public.members(id) ON DELETE SET NULL;


--
-- Name: farmers farmers_site_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.farmers
    ADD CONSTRAINT farmers_site_id_fkey FOREIGN KEY (site_id) REFERENCES public.sites(id) ON DELETE CASCADE;


--
-- Name: file_folders file_folders_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.file_folders
    ADD CONSTRAINT file_folders_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: file_folders file_folders_parent_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.file_folders
    ADD CONSTRAINT file_folders_parent_id_fkey FOREIGN KEY (parent_id) REFERENCES public.file_folders(id) ON DELETE CASCADE;


--
-- Name: file_folders file_folders_site_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.file_folders
    ADD CONSTRAINT file_folders_site_id_fkey FOREIGN KEY (site_id) REFERENCES public.sites(id) ON DELETE CASCADE;


--
-- Name: firm_transactions firm_transactions_approved_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.firm_transactions
    ADD CONSTRAINT firm_transactions_approved_by_fkey FOREIGN KEY (approved_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: firm_transactions firm_transactions_assigned_admin_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.firm_transactions
    ADD CONSTRAINT firm_transactions_assigned_admin_id_fkey FOREIGN KEY (assigned_admin_id) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: firm_transactions firm_transactions_cash_flow_entry_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.firm_transactions
    ADD CONSTRAINT firm_transactions_cash_flow_entry_id_fkey FOREIGN KEY (cash_flow_entry_id) REFERENCES public.cash_flow_entries(id) ON DELETE SET NULL;


--
-- Name: firm_transactions firm_transactions_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.firm_transactions
    ADD CONSTRAINT firm_transactions_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: firm_transactions firm_transactions_firm_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.firm_transactions
    ADD CONSTRAINT firm_transactions_firm_id_fkey FOREIGN KEY (firm_id) REFERENCES public.firms(id) ON DELETE CASCADE;


--
-- Name: firm_transactions firm_transactions_mapped_member_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.firm_transactions
    ADD CONSTRAINT firm_transactions_mapped_member_id_fkey FOREIGN KEY (mapped_member_id) REFERENCES public.members(id) ON DELETE SET NULL;


--
-- Name: firm_transactions firm_transactions_mapped_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.firm_transactions
    ADD CONSTRAINT firm_transactions_mapped_user_id_fkey FOREIGN KEY (mapped_user_id) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: firm_transactions firm_transactions_site_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.firm_transactions
    ADD CONSTRAINT firm_transactions_site_id_fkey FOREIGN KEY (site_id) REFERENCES public.sites(id) ON DELETE CASCADE;


--
-- Name: firm_transactions firm_transactions_transfer_to_firm_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.firm_transactions
    ADD CONSTRAINT firm_transactions_transfer_to_firm_id_fkey FOREIGN KEY (transfer_to_firm_id) REFERENCES public.firms(id) ON DELETE SET NULL;


--
-- Name: firm_transactions firm_transactions_transfer_to_site_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.firm_transactions
    ADD CONSTRAINT firm_transactions_transfer_to_site_id_fkey FOREIGN KEY (transfer_to_site_id) REFERENCES public.sites(id) ON DELETE SET NULL;


--
-- Name: firms firms_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.firms
    ADD CONSTRAINT firms_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: firms firms_site_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.firms
    ADD CONSTRAINT firms_site_id_fkey FOREIGN KEY (site_id) REFERENCES public.sites(id) ON DELETE CASCADE;


--
-- Name: imprest_allocations imprest_allocations_admin_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.imprest_allocations
    ADD CONSTRAINT imprest_allocations_admin_id_fkey FOREIGN KEY (admin_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: imprest_allocations imprest_allocations_assigned_admin_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.imprest_allocations
    ADD CONSTRAINT imprest_allocations_assigned_admin_id_fkey FOREIGN KEY (assigned_admin_id) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: imprest_allocations imprest_allocations_site_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.imprest_allocations
    ADD CONSTRAINT imprest_allocations_site_id_fkey FOREIGN KEY (site_id) REFERENCES public.sites(id);


--
-- Name: imprest_allocations imprest_allocations_sub_admin_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.imprest_allocations
    ADD CONSTRAINT imprest_allocations_sub_admin_id_fkey FOREIGN KEY (sub_admin_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: imprest_expense_requests imprest_expense_requests_assigned_admin_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.imprest_expense_requests
    ADD CONSTRAINT imprest_expense_requests_assigned_admin_id_fkey FOREIGN KEY (assigned_admin_id) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: imprest_expense_requests imprest_expense_requests_reviewed_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.imprest_expense_requests
    ADD CONSTRAINT imprest_expense_requests_reviewed_by_fkey FOREIGN KEY (reviewed_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: imprest_expense_requests imprest_expense_requests_site_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.imprest_expense_requests
    ADD CONSTRAINT imprest_expense_requests_site_id_fkey FOREIGN KEY (site_id) REFERENCES public.sites(id) ON DELETE CASCADE;


--
-- Name: imprest_expense_requests imprest_expense_requests_sub_admin_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.imprest_expense_requests
    ADD CONSTRAINT imprest_expense_requests_sub_admin_id_fkey FOREIGN KEY (sub_admin_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: imprest_ledger imprest_ledger_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.imprest_ledger
    ADD CONSTRAINT imprest_ledger_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: imprest_ledger imprest_ledger_site_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.imprest_ledger
    ADD CONSTRAINT imprest_ledger_site_id_fkey FOREIGN KEY (site_id) REFERENCES public.sites(id);


--
-- Name: imprest_ledger imprest_ledger_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.imprest_ledger
    ADD CONSTRAINT imprest_ledger_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: imprest_returns imprest_returns_assigned_admin_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.imprest_returns
    ADD CONSTRAINT imprest_returns_assigned_admin_id_fkey FOREIGN KEY (assigned_admin_id) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: imprest_returns imprest_returns_reviewed_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.imprest_returns
    ADD CONSTRAINT imprest_returns_reviewed_by_fkey FOREIGN KEY (reviewed_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: imprest_returns imprest_returns_site_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.imprest_returns
    ADD CONSTRAINT imprest_returns_site_id_fkey FOREIGN KEY (site_id) REFERENCES public.sites(id) ON DELETE SET NULL;


--
-- Name: imprest_returns imprest_returns_sub_admin_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.imprest_returns
    ADD CONSTRAINT imprest_returns_sub_admin_id_fkey FOREIGN KEY (sub_admin_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: inventory_materials inventory_materials_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.inventory_materials
    ADD CONSTRAINT inventory_materials_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: inventory_materials inventory_materials_site_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.inventory_materials
    ADD CONSTRAINT inventory_materials_site_id_fkey FOREIGN KEY (site_id) REFERENCES public.sites(id) ON DELETE CASCADE;


--
-- Name: inventory_movements inventory_movements_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.inventory_movements
    ADD CONSTRAINT inventory_movements_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: inventory_movements inventory_movements_material_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.inventory_movements
    ADD CONSTRAINT inventory_movements_material_id_fkey FOREIGN KEY (material_id) REFERENCES public.inventory_materials(id) ON DELETE CASCADE;


--
-- Name: inventory_movements inventory_movements_project_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.inventory_movements
    ADD CONSTRAINT inventory_movements_project_id_fkey FOREIGN KEY (project_id) REFERENCES public.construction_projects(id) ON DELETE SET NULL;


--
-- Name: inventory_movements inventory_movements_request_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.inventory_movements
    ADD CONSTRAINT inventory_movements_request_id_fkey FOREIGN KEY (request_id) REFERENCES public.construction_material_requests(id) ON DELETE SET NULL;


--
-- Name: inventory_movements inventory_movements_site_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.inventory_movements
    ADD CONSTRAINT inventory_movements_site_id_fkey FOREIGN KEY (site_id) REFERENCES public.sites(id) ON DELETE CASCADE;


--
-- Name: inventory_movements inventory_movements_task_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.inventory_movements
    ADD CONSTRAINT inventory_movements_task_id_fkey FOREIGN KEY (task_id) REFERENCES public.construction_tasks(id) ON DELETE SET NULL;


--
-- Name: kyc_cases kyc_cases_booking_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.kyc_cases
    ADD CONSTRAINT kyc_cases_booking_id_fkey FOREIGN KEY (booking_id) REFERENCES public.bookings(id) ON DELETE CASCADE;


--
-- Name: kyc_cases kyc_cases_client_member_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.kyc_cases
    ADD CONSTRAINT kyc_cases_client_member_id_fkey FOREIGN KEY (client_member_id) REFERENCES public.members(id) ON DELETE SET NULL;


--
-- Name: kyc_cases kyc_cases_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.kyc_cases
    ADD CONSTRAINT kyc_cases_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: kyc_cases kyc_cases_site_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.kyc_cases
    ADD CONSTRAINT kyc_cases_site_id_fkey FOREIGN KEY (site_id) REFERENCES public.sites(id) ON DELETE SET NULL;


--
-- Name: kyc_cases kyc_cases_verified_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.kyc_cases
    ADD CONSTRAINT kyc_cases_verified_by_fkey FOREIGN KEY (verified_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: login_otps login_otps_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.login_otps
    ADD CONSTRAINT login_otps_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: members members_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.members
    ADD CONSTRAINT members_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: members members_referred_by_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.members
    ADD CONSTRAINT members_referred_by_user_id_fkey FOREIGN KEY (referred_by_user_id) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: members members_site_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.members
    ADD CONSTRAINT members_site_id_fkey FOREIGN KEY (site_id) REFERENCES public.sites(id) ON DELETE CASCADE;


--
-- Name: messages messages_conversation_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.messages
    ADD CONSTRAINT messages_conversation_id_fkey FOREIGN KEY (conversation_id) REFERENCES public.conversations(id) ON DELETE CASCADE;


--
-- Name: messages messages_sender_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.messages
    ADD CONSTRAINT messages_sender_id_fkey FOREIGN KEY (sender_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: ocr_results ocr_results_document_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ocr_results
    ADD CONSTRAINT ocr_results_document_id_fkey FOREIGN KEY (document_id) REFERENCES public.documents(id) ON DELETE CASCADE;


--
-- Name: payment_qrs payment_qrs_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payment_qrs
    ADD CONSTRAINT payment_qrs_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id);


--
-- Name: payment_qrs payment_qrs_site_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payment_qrs
    ADD CONSTRAINT payment_qrs_site_id_fkey FOREIGN KEY (site_id) REFERENCES public.sites(id);


--
-- Name: payment_qrs payment_qrs_upi_account_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payment_qrs
    ADD CONSTRAINT payment_qrs_upi_account_id_fkey FOREIGN KEY (upi_account_id) REFERENCES public.upi_accounts(id);


--
-- Name: plot_commission_payments plot_commission_payments_approved_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.plot_commission_payments
    ADD CONSTRAINT plot_commission_payments_approved_by_fkey FOREIGN KEY (approved_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: plot_commission_payments plot_commission_payments_assigned_admin_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.plot_commission_payments
    ADD CONSTRAINT plot_commission_payments_assigned_admin_id_fkey FOREIGN KEY (assigned_admin_id) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: plot_commission_payments plot_commission_payments_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.plot_commission_payments
    ADD CONSTRAINT plot_commission_payments_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: plot_commission_payments plot_commission_payments_mapped_member_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.plot_commission_payments
    ADD CONSTRAINT plot_commission_payments_mapped_member_id_fkey FOREIGN KEY (mapped_member_id) REFERENCES public.members(id) ON DELETE SET NULL;


--
-- Name: plot_commission_payments plot_commission_payments_mapped_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.plot_commission_payments
    ADD CONSTRAINT plot_commission_payments_mapped_user_id_fkey FOREIGN KEY (mapped_user_id) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: plot_commission_payments plot_commission_payments_plot_commission_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.plot_commission_payments
    ADD CONSTRAINT plot_commission_payments_plot_commission_id_fkey FOREIGN KEY (plot_commission_id) REFERENCES public.plot_commissions_v2(id) ON DELETE CASCADE;


--
-- Name: plot_commission_payments plot_commission_payments_site_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.plot_commission_payments
    ADD CONSTRAINT plot_commission_payments_site_id_fkey FOREIGN KEY (site_id) REFERENCES public.sites(id) ON DELETE CASCADE;


--
-- Name: plot_commissions plot_commissions_approved_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.plot_commissions
    ADD CONSTRAINT plot_commissions_approved_by_fkey FOREIGN KEY (approved_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: plot_commissions plot_commissions_assigned_admin_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.plot_commissions
    ADD CONSTRAINT plot_commissions_assigned_admin_id_fkey FOREIGN KEY (assigned_admin_id) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: plot_commissions plot_commissions_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.plot_commissions
    ADD CONSTRAINT plot_commissions_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: plot_commissions plot_commissions_site_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.plot_commissions
    ADD CONSTRAINT plot_commissions_site_id_fkey FOREIGN KEY (site_id) REFERENCES public.sites(id) ON DELETE CASCADE;


--
-- Name: plot_commissions_v2 plot_commissions_v2_agent_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.plot_commissions_v2
    ADD CONSTRAINT plot_commissions_v2_agent_id_fkey FOREIGN KEY (agent_id) REFERENCES public.members(id);


--
-- Name: plot_commissions_v2 plot_commissions_v2_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.plot_commissions_v2
    ADD CONSTRAINT plot_commissions_v2_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: plot_commissions_v2 plot_commissions_v2_plot_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.plot_commissions_v2
    ADD CONSTRAINT plot_commissions_v2_plot_id_fkey FOREIGN KEY (plot_id) REFERENCES public.plots(id) ON DELETE RESTRICT;


--
-- Name: plot_commissions_v2 plot_commissions_v2_site_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.plot_commissions_v2
    ADD CONSTRAINT plot_commissions_v2_site_id_fkey FOREIGN KEY (site_id) REFERENCES public.sites(id) ON DELETE CASCADE;


--
-- Name: plot_installment_payments plot_installment_payments_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.plot_installment_payments
    ADD CONSTRAINT plot_installment_payments_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: plot_installment_payments plot_installment_payments_installment_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.plot_installment_payments
    ADD CONSTRAINT plot_installment_payments_installment_id_fkey FOREIGN KEY (installment_id) REFERENCES public.plot_installments(id) ON DELETE CASCADE;


--
-- Name: plot_installment_payments plot_installment_payments_plot_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.plot_installment_payments
    ADD CONSTRAINT plot_installment_payments_plot_id_fkey FOREIGN KEY (plot_id) REFERENCES public.plots(id) ON DELETE CASCADE;


--
-- Name: plot_installments plot_installments_plot_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.plot_installments
    ADD CONSTRAINT plot_installments_plot_id_fkey FOREIGN KEY (plot_id) REFERENCES public.plots(id) ON DELETE CASCADE;


--
-- Name: plot_payments plot_payments_approved_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.plot_payments
    ADD CONSTRAINT plot_payments_approved_by_fkey FOREIGN KEY (approved_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: plot_payments plot_payments_assigned_admin_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.plot_payments
    ADD CONSTRAINT plot_payments_assigned_admin_id_fkey FOREIGN KEY (assigned_admin_id) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: plot_payments plot_payments_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.plot_payments
    ADD CONSTRAINT plot_payments_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: plot_payments plot_payments_mapped_member_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.plot_payments
    ADD CONSTRAINT plot_payments_mapped_member_id_fkey FOREIGN KEY (mapped_member_id) REFERENCES public.members(id) ON DELETE SET NULL;


--
-- Name: plot_payments plot_payments_mapped_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.plot_payments
    ADD CONSTRAINT plot_payments_mapped_user_id_fkey FOREIGN KEY (mapped_user_id) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: plot_payments plot_payments_plot_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.plot_payments
    ADD CONSTRAINT plot_payments_plot_id_fkey FOREIGN KEY (plot_id) REFERENCES public.plots(id) ON DELETE CASCADE;


--
-- Name: plot_payments plot_payments_site_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.plot_payments
    ADD CONSTRAINT plot_payments_site_id_fkey FOREIGN KEY (site_id) REFERENCES public.sites(id) ON DELETE CASCADE;


--
-- Name: plot_registries plot_registries_assigned_admin_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.plot_registries
    ADD CONSTRAINT plot_registries_assigned_admin_id_fkey FOREIGN KEY (assigned_admin_id) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: plot_registries plot_registries_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.plot_registries
    ADD CONSTRAINT plot_registries_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id);


--
-- Name: plot_registries plot_registries_noc_approved_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.plot_registries
    ADD CONSTRAINT plot_registries_noc_approved_by_fkey FOREIGN KEY (noc_approved_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: plot_registries plot_registries_plot_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.plot_registries
    ADD CONSTRAINT plot_registries_plot_id_fkey FOREIGN KEY (plot_id) REFERENCES public.plots(id) ON DELETE RESTRICT;


--
-- Name: plot_registries plot_registries_site_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.plot_registries
    ADD CONSTRAINT plot_registries_site_id_fkey FOREIGN KEY (site_id) REFERENCES public.sites(id) ON DELETE CASCADE;


--
-- Name: plot_registry_payments plot_registry_payments_assigned_admin_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.plot_registry_payments
    ADD CONSTRAINT plot_registry_payments_assigned_admin_id_fkey FOREIGN KEY (assigned_admin_id) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: plot_registry_payments plot_registry_payments_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.plot_registry_payments
    ADD CONSTRAINT plot_registry_payments_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id);


--
-- Name: plot_registry_payments plot_registry_payments_registry_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.plot_registry_payments
    ADD CONSTRAINT plot_registry_payments_registry_id_fkey FOREIGN KEY (registry_id) REFERENCES public.plot_registries(id) ON DELETE CASCADE;


--
-- Name: plot_registry_payments plot_registry_payments_site_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.plot_registry_payments
    ADD CONSTRAINT plot_registry_payments_site_id_fkey FOREIGN KEY (site_id) REFERENCES public.sites(id) ON DELETE CASCADE;


--
-- Name: plot_registry_payments plot_registry_payments_source_plot_payment_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.plot_registry_payments
    ADD CONSTRAINT plot_registry_payments_source_plot_payment_id_fkey FOREIGN KEY (source_plot_payment_id) REFERENCES public.plot_payments(id) ON DELETE SET NULL;


--
-- Name: plots plots_assigned_admin_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.plots
    ADD CONSTRAINT plots_assigned_admin_id_fkey FOREIGN KEY (assigned_admin_id) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: plots plots_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.plots
    ADD CONSTRAINT plots_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: plots plots_site_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.plots
    ADD CONSTRAINT plots_site_id_fkey FOREIGN KEY (site_id) REFERENCES public.sites(id) ON DELETE CASCADE;


--
-- Name: project_settings project_settings_site_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.project_settings
    ADD CONSTRAINT project_settings_site_id_fkey FOREIGN KEY (site_id) REFERENCES public.sites(id) ON DELETE CASCADE;


--
-- Name: registry_document_handovers registry_document_handovers_given_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.registry_document_handovers
    ADD CONSTRAINT registry_document_handovers_given_by_fkey FOREIGN KEY (given_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: registry_document_handovers registry_document_handovers_registry_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.registry_document_handovers
    ADD CONSTRAINT registry_document_handovers_registry_id_fkey FOREIGN KEY (registry_id) REFERENCES public.plot_registries(id) ON DELETE CASCADE;


--
-- Name: registry_document_handovers registry_document_handovers_site_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.registry_document_handovers
    ADD CONSTRAINT registry_document_handovers_site_id_fkey FOREIGN KEY (site_id) REFERENCES public.sites(id) ON DELETE CASCADE;


--
-- Name: sites sites_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sites
    ADD CONSTRAINT sites_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: sms_reminder_log sms_reminder_log_plot_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sms_reminder_log
    ADD CONSTRAINT sms_reminder_log_plot_id_fkey FOREIGN KEY (plot_id) REFERENCES public.plots(id) ON DELETE SET NULL;


--
-- Name: sms_reminder_log sms_reminder_log_queued_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sms_reminder_log
    ADD CONSTRAINT sms_reminder_log_queued_by_fkey FOREIGN KEY (queued_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: sms_reminder_log sms_reminder_log_site_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sms_reminder_log
    ADD CONSTRAINT sms_reminder_log_site_id_fkey FOREIGN KEY (site_id) REFERENCES public.sites(id) ON DELETE CASCADE;


--
-- Name: team_members team_members_team_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.team_members
    ADD CONSTRAINT team_members_team_id_fkey FOREIGN KEY (team_id) REFERENCES public.teams(id) ON DELETE CASCADE;


--
-- Name: team_members team_members_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.team_members
    ADD CONSTRAINT team_members_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: teams teams_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.teams
    ADD CONSTRAINT teams_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: teams teams_site_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.teams
    ADD CONSTRAINT teams_site_id_fkey FOREIGN KEY (site_id) REFERENCES public.sites(id) ON DELETE SET NULL;


--
-- Name: upi_accounts upi_accounts_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.upi_accounts
    ADD CONSTRAINT upi_accounts_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id);


--
-- Name: upi_accounts upi_accounts_site_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.upi_accounts
    ADD CONSTRAINT upi_accounts_site_id_fkey FOREIGN KEY (site_id) REFERENCES public.sites(id);


--
-- Name: user_approval_modules user_approval_modules_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_approval_modules
    ADD CONSTRAINT user_approval_modules_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: user_home_layouts user_home_layouts_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_home_layouts
    ADD CONSTRAINT user_home_layouts_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: user_permissions user_permissions_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_permissions
    ADD CONSTRAINT user_permissions_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: user_sessions user_sessions_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_sessions
    ADD CONSTRAINT user_sessions_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: user_sites user_sites_site_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_sites
    ADD CONSTRAINT user_sites_site_id_fkey FOREIGN KEY (site_id) REFERENCES public.sites(id) ON DELETE CASCADE;


--
-- Name: user_sites user_sites_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_sites
    ADD CONSTRAINT user_sites_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: users users_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: users users_parent_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_parent_user_id_fkey FOREIGN KEY (parent_user_id) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: vendor_commitments vendor_commitments_assigned_admin_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vendor_commitments
    ADD CONSTRAINT vendor_commitments_assigned_admin_id_fkey FOREIGN KEY (assigned_admin_id) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: vendor_commitments vendor_commitments_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vendor_commitments
    ADD CONSTRAINT vendor_commitments_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: vendor_commitments vendor_commitments_head_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vendor_commitments
    ADD CONSTRAINT vendor_commitments_head_id_fkey FOREIGN KEY (head_id) REFERENCES public.vendor_heads(id) ON DELETE SET NULL;


--
-- Name: vendor_commitments vendor_commitments_site_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vendor_commitments
    ADD CONSTRAINT vendor_commitments_site_id_fkey FOREIGN KEY (site_id) REFERENCES public.sites(id) ON DELETE CASCADE;


--
-- Name: vendor_commitments vendor_commitments_vendor_member_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vendor_commitments
    ADD CONSTRAINT vendor_commitments_vendor_member_id_fkey FOREIGN KEY (vendor_member_id) REFERENCES public.members(id) ON DELETE SET NULL;


--
-- Name: vendor_heads vendor_heads_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vendor_heads
    ADD CONSTRAINT vendor_heads_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: vendor_heads vendor_heads_site_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vendor_heads
    ADD CONSTRAINT vendor_heads_site_id_fkey FOREIGN KEY (site_id) REFERENCES public.sites(id) ON DELETE CASCADE;


--
-- Name: vendor_inventory_deliveries vendor_inventory_deliveries_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vendor_inventory_deliveries
    ADD CONSTRAINT vendor_inventory_deliveries_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: vendor_inventory_deliveries vendor_inventory_deliveries_order_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vendor_inventory_deliveries
    ADD CONSTRAINT vendor_inventory_deliveries_order_id_fkey FOREIGN KEY (order_id) REFERENCES public.vendor_inventory_orders(id) ON DELETE CASCADE;


--
-- Name: vendor_inventory_deliveries vendor_inventory_deliveries_site_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vendor_inventory_deliveries
    ADD CONSTRAINT vendor_inventory_deliveries_site_id_fkey FOREIGN KEY (site_id) REFERENCES public.sites(id) ON DELETE CASCADE;


--
-- Name: vendor_inventory_orders vendor_inventory_orders_commitment_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vendor_inventory_orders
    ADD CONSTRAINT vendor_inventory_orders_commitment_id_fkey FOREIGN KEY (commitment_id) REFERENCES public.vendor_commitments(id) ON DELETE SET NULL;


--
-- Name: vendor_inventory_orders vendor_inventory_orders_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vendor_inventory_orders
    ADD CONSTRAINT vendor_inventory_orders_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: vendor_inventory_orders vendor_inventory_orders_site_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vendor_inventory_orders
    ADD CONSTRAINT vendor_inventory_orders_site_id_fkey FOREIGN KEY (site_id) REFERENCES public.sites(id) ON DELETE CASCADE;


--
-- Name: vendor_inventory_orders vendor_inventory_orders_vendor_member_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vendor_inventory_orders
    ADD CONSTRAINT vendor_inventory_orders_vendor_member_id_fkey FOREIGN KEY (vendor_member_id) REFERENCES public.members(id) ON DELETE SET NULL;


--
-- Name: vendor_inventory_payments vendor_inventory_payments_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vendor_inventory_payments
    ADD CONSTRAINT vendor_inventory_payments_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: vendor_inventory_payments vendor_inventory_payments_order_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vendor_inventory_payments
    ADD CONSTRAINT vendor_inventory_payments_order_id_fkey FOREIGN KEY (order_id) REFERENCES public.vendor_inventory_orders(id) ON DELETE CASCADE;


--
-- Name: vendor_inventory_payments vendor_inventory_payments_site_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vendor_inventory_payments
    ADD CONSTRAINT vendor_inventory_payments_site_id_fkey FOREIGN KEY (site_id) REFERENCES public.sites(id) ON DELETE CASCADE;


--
-- Name: vendor_payments vendor_payments_approved_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vendor_payments
    ADD CONSTRAINT vendor_payments_approved_by_fkey FOREIGN KEY (approved_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: vendor_payments vendor_payments_assigned_admin_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vendor_payments
    ADD CONSTRAINT vendor_payments_assigned_admin_id_fkey FOREIGN KEY (assigned_admin_id) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: vendor_payments vendor_payments_commitment_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vendor_payments
    ADD CONSTRAINT vendor_payments_commitment_id_fkey FOREIGN KEY (commitment_id) REFERENCES public.vendor_commitments(id) ON DELETE CASCADE;


--
-- Name: vendor_payments vendor_payments_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vendor_payments
    ADD CONSTRAINT vendor_payments_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: vendor_payments vendor_payments_mapped_member_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vendor_payments
    ADD CONSTRAINT vendor_payments_mapped_member_id_fkey FOREIGN KEY (mapped_member_id) REFERENCES public.members(id) ON DELETE SET NULL;


--
-- Name: vendor_payments vendor_payments_mapped_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vendor_payments
    ADD CONSTRAINT vendor_payments_mapped_user_id_fkey FOREIGN KEY (mapped_user_id) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: vendor_payments vendor_payments_site_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vendor_payments
    ADD CONSTRAINT vendor_payments_site_id_fkey FOREIGN KEY (site_id) REFERENCES public.sites(id) ON DELETE CASCADE;


--
-- PostgreSQL database dump complete
--

\unrestrict NfdrKFzotKeTPhyQSiMenRUvqL1UJYaznIHHWO9arktnhlWEfh9RUNVWxyT3Xcd

