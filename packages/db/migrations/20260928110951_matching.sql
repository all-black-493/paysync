-- Allocations of active matches never exceed what an expected payment is due, checked at commit.
CREATE FUNCTION core.assert_allocation_within_due(p_expected_payment_id uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
  v_due bigint;
  v_allocated numeric;
BEGIN
  SELECT amount_due INTO v_due FROM core.expected_payment WHERE id = p_expected_payment_id;
  SELECT coalesce(sum(a.amount), 0) INTO v_allocated
  FROM core.allocation a JOIN core.match m ON m.id = a.match_id
  WHERE a.expected_payment_id = p_expected_payment_id AND m.status = 'active';
  IF v_allocated > v_due THEN
    RAISE EXCEPTION 'allocations to expected payment % total %, above its amount due %', p_expected_payment_id, v_allocated, v_due
      USING ERRCODE = '23514', CONSTRAINT = 'core_allocation_within_due';
  END IF;
END
$$;--> statement-breakpoint

CREATE FUNCTION core.allocation_within_due() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM core.assert_allocation_within_due(NEW.expected_payment_id);
  RETURN NULL;
END
$$;--> statement-breakpoint

CREATE FUNCTION core.expected_payment_due_covers_allocations() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM core.assert_allocation_within_due(NEW.id);
  RETURN NULL;
END
$$;--> statement-breakpoint

CREATE CONSTRAINT TRIGGER allocation_within_due AFTER INSERT ON core.allocation
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION core.allocation_within_due();--> statement-breakpoint

CREATE CONSTRAINT TRIGGER expected_payment_due_covers_allocations AFTER UPDATE OF amount_due ON core.expected_payment
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION core.expected_payment_due_covers_allocations();
