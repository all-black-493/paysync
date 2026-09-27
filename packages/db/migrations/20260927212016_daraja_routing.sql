GRANT SELECT, INSERT, UPDATE ON ingest.stk_request TO paysync_app;
GRANT SELECT, INSERT ON ingest.unrouted_event TO paysync_app;
GRANT SELECT, INSERT, UPDATE ON ingest.daraja_token TO paysync_app;

ALTER TABLE ingest.stk_request ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON ingest.stk_request
  USING (org_id = current_setting('app.org_id', true))
  WITH CHECK (org_id = current_setting('app.org_id', true));

CREATE TRIGGER touch_row BEFORE UPDATE ON ingest.stk_request
  FOR EACH ROW EXECUTE FUNCTION core.touch_row();

CREATE TRIGGER forbid_update_delete BEFORE UPDATE OR DELETE ON ingest.unrouted_event
  FOR EACH ROW EXECUTE FUNCTION core.forbid_mutation();
CREATE TRIGGER forbid_truncate BEFORE TRUNCATE ON ingest.unrouted_event
  FOR EACH STATEMENT EXECUTE FUNCTION core.forbid_mutation();

-- Callbacks arrive before any organization is known. These look up only the
-- routing key, so the app can open an org-scoped transaction for the rest.
CREATE FUNCTION ingest.route_shortcode(p_environment text, p_code text)
RETURNS TABLE (shortcode_id uuid, org_id text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $$
  SELECT id, org_id FROM core.shortcode WHERE environment = p_environment AND code = p_code
$$;

CREATE FUNCTION ingest.route_stk_checkout(p_checkout_request_id text)
RETURNS TABLE (stk_request_id uuid, org_id text, shortcode_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $$
  SELECT id, org_id, shortcode_id FROM ingest.stk_request WHERE checkout_request_id = p_checkout_request_id
$$;

REVOKE ALL ON FUNCTION ingest.route_shortcode(text, text), ingest.route_stk_checkout(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ingest.route_shortcode(text, text), ingest.route_stk_checkout(text) TO paysync_app;
