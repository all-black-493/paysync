-- Privileges: paysync_app never gets UPDATE/DELETE on append-only tables, and no DDL anywhere.
GRANT USAGE ON SCHEMA auth TO paysync_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA auth TO paysync_app;

GRANT SELECT, INSERT, UPDATE ON core.shortcode, core.expected_payment, core.mpesa_transaction, core.match, core.exception TO paysync_app;
GRANT SELECT, INSERT ON core.allocation TO paysync_app;
GRANT SELECT, INSERT ON ingest.inbound_event TO paysync_app;
GRANT SELECT, INSERT ON ledger.account, ledger.journal, ledger.entry TO paysync_app;
GRANT SELECT, INSERT ON audit.event TO paysync_app;
GRANT SELECT, INSERT ON agent.idempotency_record TO paysync_app;

-- Append-only tables also refuse UPDATE, DELETE and TRUNCATE by trigger, so a
-- mistaken grant or a superuser session cannot silently rewrite history.
CREATE FUNCTION core.forbid_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% on %.% is not allowed: the table is append-only', TG_OP, TG_TABLE_SCHEMA, TG_TABLE_NAME
    USING ERRCODE = 'PSA01', HINT = 'Record a compensating entry instead.';
END
$$;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'ingest.inbound_event', 'ledger.account', 'ledger.journal', 'ledger.entry',
    'audit.event', 'core.allocation', 'agent.idempotency_record'
  ] LOOP
    EXECUTE format('CREATE TRIGGER forbid_update_delete BEFORE UPDATE OR DELETE ON %s FOR EACH ROW EXECUTE FUNCTION core.forbid_mutation()', t);
    EXECUTE format('CREATE TRIGGER forbid_truncate BEFORE TRUNCATE ON %s FOR EACH STATEMENT EXECUTE FUNCTION core.forbid_mutation()', t);
  END LOOP;
END
$$;

-- Every journal must balance to zero with at least two lines, checked at commit.
-- SECURITY DEFINER so the check sees every line regardless of row-level security.
CREATE FUNCTION ledger.assert_journal_balanced(p_journal_id uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
  v_lines bigint;
  v_total numeric;
BEGIN
  SELECT count(*), coalesce(sum(amount), 0) INTO v_lines, v_total
  FROM ledger.entry WHERE journal_id = p_journal_id;
  IF v_lines < 2 OR v_total <> 0 THEN
    RAISE EXCEPTION 'journal % is unbalanced: % lines summing to %', p_journal_id, v_lines, v_total
      USING ERRCODE = '23514', CONSTRAINT = 'ledger_journal_balanced';
  END IF;
END
$$;

CREATE FUNCTION ledger.journal_balanced_on_journal() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM ledger.assert_journal_balanced(NEW.id);
  RETURN NULL;
END
$$;

CREATE FUNCTION ledger.journal_balanced_on_entry() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM ledger.assert_journal_balanced(NEW.journal_id);
  RETURN NULL;
END
$$;

CREATE CONSTRAINT TRIGGER journal_balanced AFTER INSERT ON ledger.journal
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION ledger.journal_balanced_on_journal();
CREATE CONSTRAINT TRIGGER journal_balanced AFTER INSERT ON ledger.entry
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION ledger.journal_balanced_on_entry();

-- Allocations of active matches never exceed the transaction amount, checked at commit.
CREATE FUNCTION core.assert_allocation_within_amount(p_transaction_id uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
  v_amount bigint;
  v_allocated numeric;
BEGIN
  SELECT amount INTO v_amount FROM core.mpesa_transaction WHERE id = p_transaction_id;
  SELECT coalesce(sum(a.amount), 0) INTO v_allocated
  FROM core.allocation a JOIN core.match m ON m.id = a.match_id
  WHERE a.transaction_id = p_transaction_id AND m.status = 'active';
  IF v_allocated > v_amount THEN
    RAISE EXCEPTION 'allocations for transaction % total %, above its amount %', p_transaction_id, v_allocated, v_amount
      USING ERRCODE = '23514', CONSTRAINT = 'core_allocation_within_amount';
  END IF;
END
$$;

CREATE FUNCTION core.allocation_within_amount() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM core.assert_allocation_within_amount(NEW.transaction_id);
  RETURN NULL;
END
$$;

CREATE CONSTRAINT TRIGGER allocation_within_amount AFTER INSERT ON core.allocation
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION core.allocation_within_amount();

-- An allocation must point at a match for the same transaction.
CREATE FUNCTION core.allocation_matches_transaction() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM core.match WHERE id = NEW.match_id AND transaction_id = NEW.transaction_id) THEN
    RAISE EXCEPTION 'allocation % belongs to a match for another transaction', NEW.id
      USING ERRCODE = '23514', CONSTRAINT = 'core_allocation_match_transaction';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER allocation_matches_transaction BEFORE INSERT ON core.allocation
  FOR EACH ROW EXECUTE FUNCTION core.allocation_matches_transaction();

-- Matches only ever move from active to unmatched; everything else about them is fixed.
CREATE FUNCTION core.match_transition() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id <> OLD.id OR NEW.org_id <> OLD.org_id OR NEW.transaction_id <> OLD.transaction_id
     OR NEW.method <> OLD.method OR NEW.confidence IS DISTINCT FROM OLD.confidence
     OR NEW.jev_probabilities IS DISTINCT FROM OLD.jev_probabilities
     OR NEW.actor_user_id IS DISTINCT FROM OLD.actor_user_id OR NEW.created_at <> OLD.created_at
     OR NOT (OLD.status = 'active' AND NEW.status = 'unmatched') THEN
    RAISE EXCEPTION 'match % can only change from active to unmatched', OLD.id
      USING ERRCODE = '23514', CONSTRAINT = 'core_match_transition';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER match_transition BEFORE UPDATE ON core.match
  FOR EACH ROW EXECUTE FUNCTION core.match_transition();
CREATE TRIGGER forbid_delete BEFORE DELETE ON core.match
  FOR EACH ROW EXECUTE FUNCTION core.forbid_mutation();

-- Optimistic concurrency: every update must bump version by exactly one.
CREATE FUNCTION core.touch_row() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.version <> OLD.version + 1 THEN
    RAISE EXCEPTION 'stale write to %.% %: version % -> %', TG_TABLE_SCHEMA, TG_TABLE_NAME, OLD.id, OLD.version, NEW.version
      USING ERRCODE = 'PSV01', HINT = 'Re-read the row and retry with its current version.';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END
$$;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['core.shortcode', 'core.expected_payment', 'core.mpesa_transaction', 'core.exception'] LOOP
    EXECUTE format('CREATE TRIGGER touch_row BEFORE UPDATE ON %s FOR EACH ROW EXECUTE FUNCTION core.touch_row()', t);
  END LOOP;
END
$$;

-- Tenant isolation. The app sets app.org_id per transaction; unset means no rows.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'core.shortcode', 'core.expected_payment', 'core.mpesa_transaction', 'core.match',
    'core.allocation', 'core.exception', 'ingest.inbound_event', 'ledger.account',
    'ledger.journal', 'ledger.entry', 'audit.event', 'agent.idempotency_record'
  ] LOOP
    EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %s USING (org_id = current_setting(''app.org_id'', true)) '
      'WITH CHECK (org_id = current_setting(''app.org_id'', true))', t);
  END LOOP;
END
$$;
