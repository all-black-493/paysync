CREATE TABLE "core"."balance_snapshot" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"org_id" text NOT NULL,
	"shortcode_id" uuid NOT NULL,
	"daraja_request_id" uuid NOT NULL,
	"utility" bigint NOT NULL,
	"working" bigint NOT NULL,
	"charges_paid" bigint NOT NULL,
	"accounts" jsonb NOT NULL,
	"currency" char(3) DEFAULT 'KES' NOT NULL,
	"reported_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "balance_snapshot_darajaRequestId_unique" UNIQUE("daraja_request_id"),
	CONSTRAINT "balance_snapshot_currency" CHECK ("core"."balance_snapshot"."currency" = 'KES')
);
--> statement-breakpoint
CREATE TABLE "ingest"."daraja_request" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"org_id" text NOT NULL,
	"shortcode_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"transaction_id" uuid,
	"receipt_number" text,
	"originator_conversation_id" text,
	"conversation_id" text,
	"status" text DEFAULT 'initiated' NOT NULL,
	"result_code" text,
	"result_desc" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "daraja_request_originatorConversationId_unique" UNIQUE("originator_conversation_id"),
	CONSTRAINT "daraja_request_conversationId_unique" UNIQUE("conversation_id"),
	CONSTRAINT "daraja_request_id_org_unique" UNIQUE("id","org_id"),
	CONSTRAINT "daraja_request_kind" CHECK (kind IN ('transaction_status', 'account_balance')),
	CONSTRAINT "daraja_request_status" CHECK (status IN ('initiated', 'accepted', 'completed', 'failed', 'timed_out'))
);
--> statement-breakpoint
CREATE TABLE "ingest"."pull_cursor" (
	"shortcode_id" uuid PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"pulled_until" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "core"."exception" DROP CONSTRAINT "exception_kind";--> statement-breakpoint
ALTER TABLE "core"."mpesa_transaction" DROP CONSTRAINT "mpesa_transaction_status";--> statement-breakpoint
ALTER TABLE "ingest"."unrouted_event" DROP CONSTRAINT "unrouted_event_reason";--> statement-breakpoint
ALTER TABLE "core"."exception" ADD COLUMN "dedupe_key" text;--> statement-breakpoint
ALTER TABLE "core"."mpesa_transaction" ADD COLUMN "verified_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "core"."mpesa_transaction" ADD COLUMN "verification_method" text;--> statement-breakpoint
ALTER TABLE "core"."mpesa_transaction" ADD COLUMN "verification_attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "core"."mpesa_transaction" ADD COLUMN "last_verification_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "core"."shortcode" ADD COLUMN "initiator_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "ingest"."stk_request" ADD COLUMN "query_attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "ingest"."stk_request" ADD COLUMN "last_queried_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "core"."balance_snapshot" ADD CONSTRAINT "balance_snapshot_org_id_organization_id_fk" FOREIGN KEY ("org_id") REFERENCES "auth"."organization"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."balance_snapshot" ADD CONSTRAINT "balance_snapshot_shortcode_fk" FOREIGN KEY ("shortcode_id","org_id") REFERENCES "core"."shortcode"("id","org_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ingest"."daraja_request" ADD CONSTRAINT "daraja_request_org_id_organization_id_fk" FOREIGN KEY ("org_id") REFERENCES "auth"."organization"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ingest"."daraja_request" ADD CONSTRAINT "daraja_request_shortcode_fk" FOREIGN KEY ("shortcode_id","org_id") REFERENCES "core"."shortcode"("id","org_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ingest"."daraja_request" ADD CONSTRAINT "daraja_request_transaction_fk" FOREIGN KEY ("transaction_id","org_id") REFERENCES "core"."mpesa_transaction"("id","org_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ingest"."pull_cursor" ADD CONSTRAINT "pull_cursor_org_id_organization_id_fk" FOREIGN KEY ("org_id") REFERENCES "auth"."organization"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ingest"."pull_cursor" ADD CONSTRAINT "pull_cursor_shortcode_fk" FOREIGN KEY ("shortcode_id","org_id") REFERENCES "core"."shortcode"("id","org_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "balance_snapshot_org_id_shortcode_id_reported_at_index" ON "core"."balance_snapshot" USING btree ("org_id","shortcode_id","reported_at");--> statement-breakpoint
CREATE INDEX "daraja_request_org_id_created_at_index" ON "ingest"."daraja_request" USING btree ("org_id","created_at");--> statement-breakpoint
CREATE INDEX "daraja_request_transaction_id_index" ON "ingest"."daraja_request" USING btree ("transaction_id");--> statement-breakpoint
ALTER TABLE "core"."exception" ADD CONSTRAINT "exception_dedupe_key_unique" UNIQUE("org_id","dedupe_key");--> statement-breakpoint
ALTER TABLE "core"."exception" ADD CONSTRAINT "exception_kind" CHECK (kind IN ('no_match', 'low_confidence', 'partial_payment', 'overpayment', 'duplicate', 'verification_failed', 'amount_mismatch', 'balance_variance', 'job_failed', 'missing_callback'));--> statement-breakpoint
ALTER TABLE "core"."mpesa_transaction" ADD CONSTRAINT "mpesa_transaction_verification_method" CHECK ("core"."mpesa_transaction"."verification_method" IS NULL OR verification_method IN ('stk_query', 'transaction_status', 'pull'));--> statement-breakpoint
-- Rows verified before M3 (seed data) get a verification time; version must move by one.
UPDATE core.mpesa_transaction SET verified_at = updated_at, version = version + 1 WHERE status IN ('verified', 'reversed');--> statement-breakpoint
ALTER TABLE "core"."mpesa_transaction" ADD CONSTRAINT "mpesa_transaction_verified_at" CHECK (("core"."mpesa_transaction"."status" IN ('pending_verification', 'verification_failed')) = ("core"."mpesa_transaction"."verified_at" IS NULL));--> statement-breakpoint
ALTER TABLE "core"."mpesa_transaction" ADD CONSTRAINT "mpesa_transaction_verification_method_verified" CHECK ("core"."mpesa_transaction"."verification_method" IS NULL OR "core"."mpesa_transaction"."verified_at" IS NOT NULL);--> statement-breakpoint
ALTER TABLE "core"."mpesa_transaction" ADD CONSTRAINT "mpesa_transaction_status" CHECK (status IN ('pending_verification', 'verified', 'verification_failed', 'reversed'));--> statement-breakpoint
ALTER TABLE "ingest"."unrouted_event" ADD CONSTRAINT "unrouted_event_reason" CHECK (reason IN ('unknown_shortcode', 'unknown_checkout', 'unknown_conversation', 'invalid_payload', 'malformed_json'));--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON ingest.daraja_request, ingest.pull_cursor TO paysync_app;--> statement-breakpoint
GRANT SELECT, INSERT ON core.balance_snapshot TO paysync_app;--> statement-breakpoint

ALTER TABLE ingest.daraja_request ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON ingest.daraja_request
  USING (org_id = current_setting('app.org_id', true))
  WITH CHECK (org_id = current_setting('app.org_id', true));--> statement-breakpoint
ALTER TABLE ingest.pull_cursor ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON ingest.pull_cursor
  USING (org_id = current_setting('app.org_id', true))
  WITH CHECK (org_id = current_setting('app.org_id', true));--> statement-breakpoint
ALTER TABLE core.balance_snapshot ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON core.balance_snapshot
  USING (org_id = current_setting('app.org_id', true))
  WITH CHECK (org_id = current_setting('app.org_id', true));--> statement-breakpoint

CREATE TRIGGER touch_row BEFORE UPDATE ON ingest.daraja_request
  FOR EACH ROW EXECUTE FUNCTION core.touch_row();--> statement-breakpoint
CREATE TRIGGER forbid_update_delete BEFORE UPDATE OR DELETE ON core.balance_snapshot
  FOR EACH ROW EXECUTE FUNCTION core.forbid_mutation();--> statement-breakpoint
CREATE TRIGGER forbid_truncate BEFORE TRUNCATE ON core.balance_snapshot
  FOR EACH STATEMENT EXECUTE FUNCTION core.forbid_mutation();--> statement-breakpoint

-- Result URL bodies arrive before any organization is known (see route_stk_checkout).
CREATE FUNCTION ingest.route_daraja_conversation(p_originator_conversation_id text, p_conversation_id text)
RETURNS TABLE (daraja_request_id uuid, org_id text, shortcode_id uuid, kind text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $$
  SELECT id, org_id, shortcode_id, kind FROM ingest.daraja_request
  WHERE originator_conversation_id = p_originator_conversation_id OR conversation_id = p_conversation_id
  ORDER BY created_at
  LIMIT 1
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION ingest.route_daraja_conversation(text, text) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION ingest.route_daraja_conversation(text, text) TO paysync_app;
