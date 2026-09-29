CREATE TABLE "agent"."approval" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"org_id" text NOT NULL,
	"pending_action_id" uuid NOT NULL,
	"approver_user_id" text NOT NULL,
	"decision" text NOT NULL,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "approval_pendingActionId_approverUserId_unique" UNIQUE("pending_action_id","approver_user_id"),
	CONSTRAINT "approval_decision" CHECK (decision IN ('approve', 'reject')),
	CONSTRAINT "approval_note_length" CHECK ("agent"."approval"."note" IS NULL OR char_length("agent"."approval"."note") <= 1000)
);
--> statement-breakpoint
CREATE TABLE "agent"."pending_action" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"org_id" text NOT NULL,
	"procedure" text NOT NULL,
	"risk" text NOT NULL,
	"money" boolean DEFAULT false NOT NULL,
	"input" jsonb NOT NULL,
	"summary" text NOT NULL,
	"preview" jsonb,
	"reasons" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"requested_by" text NOT NULL,
	"requester_kind" text NOT NULL,
	"surface" text NOT NULL,
	"agent_session_id" text,
	"idempotency_key" text NOT NULL,
	"approvals_required" integer NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"result" jsonb,
	"error" text,
	"expires_at" timestamp with time zone NOT NULL,
	"decided_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "pending_action_orgId_idempotencyKey_unique" UNIQUE("org_id","idempotency_key"),
	CONSTRAINT "pending_action_id_org_unique" UNIQUE("id","org_id"),
	CONSTRAINT "pending_action_status" CHECK (status IN ('pending', 'rejected', 'executed', 'failed', 'expired')),
	CONSTRAINT "pending_action_approvals_required" CHECK ("agent"."pending_action"."approvals_required" BETWEEN 1 AND 2),
	CONSTRAINT "pending_action_summary_length" CHECK (char_length("agent"."pending_action"."summary") BETWEEN 1 AND 500)
);
--> statement-breakpoint
CREATE TABLE "auth"."two_factor" (
	"id" text PRIMARY KEY NOT NULL,
	"secret" text NOT NULL,
	"backup_codes" text NOT NULL,
	"user_id" text NOT NULL,
	"verified" boolean DEFAULT true,
	"failed_verification_count" integer DEFAULT 0,
	"locked_until" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "core"."variance_write_off" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"org_id" text NOT NULL,
	"transaction_id" uuid NOT NULL,
	"amount" bigint NOT NULL,
	"currency" char(3) DEFAULT 'KES' NOT NULL,
	"reason" text NOT NULL,
	"pending_action_id" uuid,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "variance_write_off_amount_positive" CHECK ("core"."variance_write_off"."amount" > 0),
	CONSTRAINT "variance_write_off_currency" CHECK ("core"."variance_write_off"."currency" = 'KES'),
	CONSTRAINT "variance_write_off_reason_length" CHECK (char_length("core"."variance_write_off"."reason") BETWEEN 1 AND 500)
);
--> statement-breakpoint
ALTER TABLE "ingest"."daraja_request" DROP CONSTRAINT "daraja_request_kind";--> statement-breakpoint
ALTER TABLE "auth"."user" ADD COLUMN "two_factor_enabled" boolean DEFAULT false;--> statement-breakpoint
ALTER TABLE "agent"."approval" ADD CONSTRAINT "approval_org_id_organization_id_fk" FOREIGN KEY ("org_id") REFERENCES "auth"."organization"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent"."approval" ADD CONSTRAINT "approval_pending_action_fk" FOREIGN KEY ("pending_action_id","org_id") REFERENCES "agent"."pending_action"("id","org_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent"."pending_action" ADD CONSTRAINT "pending_action_org_id_organization_id_fk" FOREIGN KEY ("org_id") REFERENCES "auth"."organization"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth"."two_factor" ADD CONSTRAINT "two_factor_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "auth"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."variance_write_off" ADD CONSTRAINT "variance_write_off_org_id_organization_id_fk" FOREIGN KEY ("org_id") REFERENCES "auth"."organization"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."variance_write_off" ADD CONSTRAINT "variance_write_off_transaction_fk" FOREIGN KEY ("transaction_id","org_id") REFERENCES "core"."mpesa_transaction"("id","org_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "pending_action_org_id_status_created_at_index" ON "agent"."pending_action" USING btree ("org_id","status","created_at");--> statement-breakpoint
CREATE INDEX "twoFactor_secret_idx" ON "auth"."two_factor" USING btree ("secret");--> statement-breakpoint
CREATE INDEX "twoFactor_userId_idx" ON "auth"."two_factor" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "variance_write_off_org_id_transaction_id_index" ON "core"."variance_write_off" USING btree ("org_id","transaction_id");--> statement-breakpoint
ALTER TABLE "ingest"."daraja_request" ADD CONSTRAINT "daraja_request_kind" CHECK (kind IN ('transaction_status', 'account_balance', 'reversal'));--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON agent.pending_action TO paysync_app;--> statement-breakpoint
GRANT SELECT, INSERT ON agent.approval, core.variance_write_off TO paysync_app;--> statement-breakpoint

ALTER TABLE agent.pending_action ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON agent.pending_action
  USING (org_id = current_setting('app.org_id', true))
  WITH CHECK (org_id = current_setting('app.org_id', true));--> statement-breakpoint
ALTER TABLE agent.approval ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON agent.approval
  USING (org_id = current_setting('app.org_id', true))
  WITH CHECK (org_id = current_setting('app.org_id', true));--> statement-breakpoint
ALTER TABLE core.variance_write_off ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON core.variance_write_off
  USING (org_id = current_setting('app.org_id', true))
  WITH CHECK (org_id = current_setting('app.org_id', true));--> statement-breakpoint

CREATE TRIGGER touch_row BEFORE UPDATE ON agent.pending_action
  FOR EACH ROW EXECUTE FUNCTION core.touch_row();--> statement-breakpoint
CREATE TRIGGER forbid_update_delete BEFORE UPDATE OR DELETE ON agent.approval
  FOR EACH ROW EXECUTE FUNCTION core.forbid_mutation();--> statement-breakpoint
CREATE TRIGGER forbid_truncate BEFORE TRUNCATE ON agent.approval
  FOR EACH STATEMENT EXECUTE FUNCTION core.forbid_mutation();--> statement-breakpoint
CREATE TRIGGER forbid_update_delete BEFORE UPDATE OR DELETE ON core.variance_write_off
  FOR EACH ROW EXECUTE FUNCTION core.forbid_mutation();--> statement-breakpoint
CREATE TRIGGER forbid_truncate BEFORE TRUNCATE ON core.variance_write_off
  FOR EACH STATEMENT EXECUTE FUNCTION core.forbid_mutation();--> statement-breakpoint

-- Maker-checker in the database: nobody approves their own request, and only pending requests take decisions.
CREATE FUNCTION agent.approval_by_someone_else() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
  v_requested_by text;
  v_status text;
BEGIN
  SELECT requested_by, status INTO v_requested_by, v_status FROM agent.pending_action WHERE id = NEW.pending_action_id;
  IF v_requested_by = NEW.approver_user_id THEN
    RAISE EXCEPTION 'the requester of action % cannot decide on it', NEW.pending_action_id
      USING ERRCODE = '23514', CONSTRAINT = 'agent_approval_not_requester';
  END IF;
  IF v_status <> 'pending' THEN
    RAISE EXCEPTION 'action % is %, not pending', NEW.pending_action_id, v_status
      USING ERRCODE = '23514', CONSTRAINT = 'agent_approval_pending_only';
  END IF;
  RETURN NEW;
END
$$;--> statement-breakpoint
CREATE TRIGGER approval_by_someone_else BEFORE INSERT ON agent.approval
  FOR EACH ROW EXECUTE FUNCTION agent.approval_by_someone_else();--> statement-breakpoint

-- Allocations of active matches plus write-offs never exceed the transaction amount.
CREATE OR REPLACE FUNCTION core.assert_allocation_within_amount(p_transaction_id uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
  v_amount bigint;
  v_allocated numeric;
  v_written_off numeric;
BEGIN
  SELECT amount INTO v_amount FROM core.mpesa_transaction WHERE id = p_transaction_id;
  SELECT coalesce(sum(a.amount), 0) INTO v_allocated
  FROM core.allocation a JOIN core.match m ON m.id = a.match_id
  WHERE a.transaction_id = p_transaction_id AND m.status = 'active';
  SELECT coalesce(sum(w.amount), 0) INTO v_written_off FROM core.variance_write_off w WHERE w.transaction_id = p_transaction_id;
  IF v_allocated + v_written_off > v_amount THEN
    RAISE EXCEPTION 'allocations and write-offs for transaction % total %, above its amount %', p_transaction_id, v_allocated + v_written_off, v_amount
      USING ERRCODE = '23514', CONSTRAINT = 'core_allocation_within_amount';
  END IF;
END
$$;--> statement-breakpoint
CREATE FUNCTION core.write_off_within_amount() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM core.assert_allocation_within_amount(NEW.transaction_id);
  RETURN NULL;
END
$$;--> statement-breakpoint
CREATE CONSTRAINT TRIGGER write_off_within_amount AFTER INSERT ON core.variance_write_off
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION core.write_off_within_amount();
--> statement-breakpoint

-- Unmatching is one-way; a new match is made instead (its allocations are checked on insert).
CREATE FUNCTION core.match_unmatch_is_final() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status = 'unmatched' AND NEW.status <> 'unmatched' THEN
    RAISE EXCEPTION 'match % was unmatched; create a new match instead', OLD.id
      USING ERRCODE = '23514', CONSTRAINT = 'core_match_unmatch_final';
  END IF;
  RETURN NEW;
END
$$;--> statement-breakpoint
CREATE TRIGGER match_unmatch_is_final BEFORE UPDATE ON core.match
  FOR EACH ROW EXECUTE FUNCTION core.match_unmatch_is_final();
