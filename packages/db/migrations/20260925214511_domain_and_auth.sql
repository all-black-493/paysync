CREATE SCHEMA "auth";
--> statement-breakpoint
CREATE TABLE "agent"."idempotency_record" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"org_id" text NOT NULL,
	"key" text NOT NULL,
	"action" text NOT NULL,
	"request_hash" text NOT NULL,
	"response" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "idempotency_record_orgId_key_unique" UNIQUE("org_id","key"),
	CONSTRAINT "idempotency_record_key_length" CHECK (char_length("agent"."idempotency_record"."key") BETWEEN 8 AND 200)
);
--> statement-breakpoint
CREATE TABLE "audit"."event" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"org_id" text NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"surface" text NOT NULL,
	"user_id" text,
	"agent_session_id" text,
	"mcp_client_id" text,
	"action" text NOT NULL,
	"input" jsonb,
	"decision" text,
	"outcome" text NOT NULL,
	"details" jsonb,
	"trace_id" text,
	CONSTRAINT "event_surface" CHECK (surface IN ('web', 'rest', 'ai-sdk', 'mcp', 'system'))
);
--> statement-breakpoint
CREATE TABLE "auth"."account" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"user_id" text NOT NULL,
	"access_token" text,
	"refresh_token" text,
	"id_token" text,
	"access_token_expires_at" timestamp with time zone,
	"refresh_token_expires_at" timestamp with time zone,
	"scope" text,
	"password" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "auth"."invitation" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"email" text NOT NULL,
	"role" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"inviter_id" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "auth"."member" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"user_id" text NOT NULL,
	"role" text DEFAULT 'member' NOT NULL,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "auth"."organization" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"logo" text,
	"created_at" timestamp with time zone NOT NULL,
	"metadata" text,
	CONSTRAINT "organization_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "auth"."rate_limit" (
	"id" text PRIMARY KEY NOT NULL,
	"key" text NOT NULL,
	"count" integer NOT NULL,
	"last_request" bigint NOT NULL,
	CONSTRAINT "rate_limit_key_unique" UNIQUE("key")
);
--> statement-breakpoint
CREATE TABLE "auth"."session" (
	"id" text PRIMARY KEY NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"token" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"ip_address" text,
	"user_agent" text,
	"user_id" text NOT NULL,
	"active_organization_id" text,
	CONSTRAINT "session_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "auth"."user" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"email_verified" boolean DEFAULT false NOT NULL,
	"image" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "auth"."verification" (
	"id" text PRIMARY KEY NOT NULL,
	"identifier" text NOT NULL,
	"value" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "core"."allocation" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"org_id" text NOT NULL,
	"match_id" uuid NOT NULL,
	"transaction_id" uuid NOT NULL,
	"expected_payment_id" uuid NOT NULL,
	"amount" bigint NOT NULL,
	"currency" char(3) DEFAULT 'KES' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "allocation_amount_positive" CHECK ("core"."allocation"."amount" > 0),
	CONSTRAINT "allocation_currency" CHECK ("core"."allocation"."currency" = 'KES')
);
--> statement-breakpoint
CREATE TABLE "core"."exception" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"org_id" text NOT NULL,
	"kind" text NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"priority" text DEFAULT 'normal' NOT NULL,
	"transaction_id" uuid,
	"expected_payment_id" uuid,
	"summary" text NOT NULL,
	"details" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"note" text,
	"tags" text[] DEFAULT '{}'::text[] NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "exception_kind" CHECK (kind IN ('no_match', 'low_confidence', 'partial_payment', 'overpayment', 'duplicate', 'verification_failed', 'amount_mismatch', 'balance_variance', 'job_failed')),
	CONSTRAINT "exception_status" CHECK (status IN ('open', 'resolved', 'dismissed')),
	CONSTRAINT "exception_priority" CHECK (priority IN ('normal', 'high')),
	CONSTRAINT "exception_note_length" CHECK ("core"."exception"."note" IS NULL OR char_length("core"."exception"."note") <= 2000),
	CONSTRAINT "exception_tags_count" CHECK (cardinality("core"."exception"."tags") <= 20)
);
--> statement-breakpoint
CREATE TABLE "core"."expected_payment" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"org_id" text NOT NULL,
	"reference" text NOT NULL,
	"reference_normalized" text NOT NULL,
	"description" text,
	"amount_due" bigint NOT NULL,
	"currency" char(3) DEFAULT 'KES' NOT NULL,
	"due_date" date,
	"payer_label" text,
	"status" text DEFAULT 'open' NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "expected_payment_orgId_referenceNormalized_unique" UNIQUE("org_id","reference_normalized"),
	CONSTRAINT "expected_payment_id_org_unique" UNIQUE("id","org_id"),
	CONSTRAINT "expected_payment_amount_positive" CHECK ("core"."expected_payment"."amount_due" > 0),
	CONSTRAINT "expected_payment_currency" CHECK ("core"."expected_payment"."currency" = 'KES'),
	CONSTRAINT "expected_payment_status" CHECK (status IN ('open', 'partially_paid', 'paid', 'void')),
	CONSTRAINT "expected_payment_reference_length" CHECK (char_length("core"."expected_payment"."reference") BETWEEN 1 AND 64)
);
--> statement-breakpoint
CREATE TABLE "core"."match" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"org_id" text NOT NULL,
	"transaction_id" uuid NOT NULL,
	"method" text NOT NULL,
	"confidence" numeric(5, 4),
	"jev_probabilities" jsonb,
	"status" text DEFAULT 'active' NOT NULL,
	"actor_user_id" text,
	"agent_session_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"unmatched_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "match_id_org_unique" UNIQUE("id","org_id"),
	CONSTRAINT "match_method" CHECK (method IN ('exact', 'rule', 'jev', 'manual')),
	CONSTRAINT "match_status" CHECK (status IN ('active', 'unmatched')),
	CONSTRAINT "match_confidence_range" CHECK ("core"."match"."confidence" IS NULL OR "core"."match"."confidence" BETWEEN 0 AND 1),
	CONSTRAINT "match_unmatched_at" CHECK (("core"."match"."status" = 'unmatched') = ("core"."match"."unmatched_at" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "core"."mpesa_transaction" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"org_id" text NOT NULL,
	"shortcode_id" uuid NOT NULL,
	"receipt_number" text NOT NULL,
	"amount" bigint NOT NULL,
	"currency" char(3) DEFAULT 'KES' NOT NULL,
	"transacted_at" timestamp with time zone NOT NULL,
	"source" text NOT NULL,
	"bill_ref_number" text,
	"payer_name_ciphertext" "bytea",
	"msisdn_ciphertext" "bytea",
	"msisdn_hash" "bytea",
	"status" text DEFAULT 'pending_verification' NOT NULL,
	"inbound_event_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "mpesa_transaction_shortcodeId_receiptNumber_unique" UNIQUE("shortcode_id","receipt_number"),
	CONSTRAINT "mpesa_transaction_id_org_unique" UNIQUE("id","org_id"),
	CONSTRAINT "mpesa_transaction_amount_positive" CHECK ("core"."mpesa_transaction"."amount" > 0),
	CONSTRAINT "mpesa_transaction_currency" CHECK ("core"."mpesa_transaction"."currency" = 'KES'),
	CONSTRAINT "mpesa_transaction_status" CHECK (status IN ('pending_verification', 'verified', 'reversed')),
	CONSTRAINT "mpesa_transaction_source" CHECK (source IN ('c2b', 'stk', 'pull', 'statement')),
	CONSTRAINT "mpesa_transaction_receipt_format" CHECK ("core"."mpesa_transaction"."receipt_number" ~ '^[A-Z0-9]{10}$')
);
--> statement-breakpoint
CREATE TABLE "core"."shortcode" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"org_id" text NOT NULL,
	"code" text NOT NULL,
	"kind" text NOT NULL,
	"environment" text NOT NULL,
	"c2b_enabled" boolean DEFAULT false NOT NULL,
	"stk_enabled" boolean DEFAULT false NOT NULL,
	"pull_enabled" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "shortcode_environment_code_unique" UNIQUE("environment","code"),
	CONSTRAINT "shortcode_id_org_unique" UNIQUE("id","org_id"),
	CONSTRAINT "shortcode_code_format" CHECK ("core"."shortcode"."code" ~ '^[0-9]{5,7}$'),
	CONSTRAINT "shortcode_kind" CHECK (kind IN ('paybill', 'till')),
	CONSTRAINT "shortcode_environment" CHECK (environment IN ('sandbox', 'production'))
);
--> statement-breakpoint
CREATE TABLE "ingest"."inbound_event" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"org_id" text NOT NULL,
	"shortcode_id" uuid NOT NULL,
	"source" text NOT NULL,
	"external_id" text NOT NULL,
	"payload" jsonb NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "inbound_event_source_externalId_unique" UNIQUE("source","external_id"),
	CONSTRAINT "inbound_event_id_org_unique" UNIQUE("id","org_id"),
	CONSTRAINT "inbound_event_source" CHECK (source IN ('c2b_validation', 'c2b_confirmation', 'stk_callback', 'transaction_status_result', 'reversal_result', 'account_balance_result', 'queue_timeout', 'pull', 'statement')),
	CONSTRAINT "inbound_event_external_id_length" CHECK (char_length("ingest"."inbound_event"."external_id") BETWEEN 1 AND 128)
);
--> statement-breakpoint
CREATE TABLE "ledger"."account" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"org_id" text NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"kind" text NOT NULL,
	"currency" char(3) DEFAULT 'KES' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "account_orgId_code_unique" UNIQUE("org_id","code"),
	CONSTRAINT "account_id_org_unique" UNIQUE("id","org_id"),
	CONSTRAINT "account_kind" CHECK (kind IN ('asset', 'liability', 'equity', 'income', 'expense')),
	CONSTRAINT "account_currency" CHECK ("ledger"."account"."currency" = 'KES')
);
--> statement-breakpoint
CREATE TABLE "ledger"."entry" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"org_id" text NOT NULL,
	"journal_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"amount" bigint NOT NULL,
	"currency" char(3) DEFAULT 'KES' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "entry_amount_nonzero" CHECK ("ledger"."entry"."amount" <> 0),
	CONSTRAINT "entry_currency" CHECK ("ledger"."entry"."currency" = 'KES')
);
--> statement-breakpoint
CREATE TABLE "ledger"."journal" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"org_id" text NOT NULL,
	"kind" text NOT NULL,
	"description" text NOT NULL,
	"transaction_id" uuid,
	"idempotency_key" text NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "journal_orgId_idempotencyKey_unique" UNIQUE("org_id","idempotency_key"),
	CONSTRAINT "journal_id_org_unique" UNIQUE("id","org_id"),
	CONSTRAINT "journal_idempotency_key_length" CHECK (char_length("ledger"."journal"."idempotency_key") BETWEEN 1 AND 200)
);
--> statement-breakpoint
ALTER TABLE "agent"."idempotency_record" ADD CONSTRAINT "idempotency_record_org_id_organization_id_fk" FOREIGN KEY ("org_id") REFERENCES "auth"."organization"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit"."event" ADD CONSTRAINT "event_org_id_organization_id_fk" FOREIGN KEY ("org_id") REFERENCES "auth"."organization"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth"."account" ADD CONSTRAINT "account_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "auth"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth"."invitation" ADD CONSTRAINT "invitation_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "auth"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth"."invitation" ADD CONSTRAINT "invitation_inviter_id_user_id_fk" FOREIGN KEY ("inviter_id") REFERENCES "auth"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth"."member" ADD CONSTRAINT "member_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "auth"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth"."member" ADD CONSTRAINT "member_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "auth"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth"."session" ADD CONSTRAINT "session_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "auth"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."allocation" ADD CONSTRAINT "allocation_org_id_organization_id_fk" FOREIGN KEY ("org_id") REFERENCES "auth"."organization"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."allocation" ADD CONSTRAINT "allocation_match_fk" FOREIGN KEY ("match_id","org_id") REFERENCES "core"."match"("id","org_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."allocation" ADD CONSTRAINT "allocation_transaction_fk" FOREIGN KEY ("transaction_id","org_id") REFERENCES "core"."mpesa_transaction"("id","org_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."allocation" ADD CONSTRAINT "allocation_expected_payment_fk" FOREIGN KEY ("expected_payment_id","org_id") REFERENCES "core"."expected_payment"("id","org_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."exception" ADD CONSTRAINT "exception_org_id_organization_id_fk" FOREIGN KEY ("org_id") REFERENCES "auth"."organization"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."exception" ADD CONSTRAINT "exception_transaction_fk" FOREIGN KEY ("transaction_id","org_id") REFERENCES "core"."mpesa_transaction"("id","org_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."exception" ADD CONSTRAINT "exception_expected_payment_fk" FOREIGN KEY ("expected_payment_id","org_id") REFERENCES "core"."expected_payment"("id","org_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."expected_payment" ADD CONSTRAINT "expected_payment_org_id_organization_id_fk" FOREIGN KEY ("org_id") REFERENCES "auth"."organization"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."match" ADD CONSTRAINT "match_org_id_organization_id_fk" FOREIGN KEY ("org_id") REFERENCES "auth"."organization"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."match" ADD CONSTRAINT "match_transaction_fk" FOREIGN KEY ("transaction_id","org_id") REFERENCES "core"."mpesa_transaction"("id","org_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."mpesa_transaction" ADD CONSTRAINT "mpesa_transaction_org_id_organization_id_fk" FOREIGN KEY ("org_id") REFERENCES "auth"."organization"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."mpesa_transaction" ADD CONSTRAINT "mpesa_transaction_shortcode_fk" FOREIGN KEY ("shortcode_id","org_id") REFERENCES "core"."shortcode"("id","org_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."mpesa_transaction" ADD CONSTRAINT "mpesa_transaction_inbound_event_fk" FOREIGN KEY ("inbound_event_id","org_id") REFERENCES "ingest"."inbound_event"("id","org_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."shortcode" ADD CONSTRAINT "shortcode_org_id_organization_id_fk" FOREIGN KEY ("org_id") REFERENCES "auth"."organization"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ingest"."inbound_event" ADD CONSTRAINT "inbound_event_org_id_organization_id_fk" FOREIGN KEY ("org_id") REFERENCES "auth"."organization"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger"."account" ADD CONSTRAINT "account_org_id_organization_id_fk" FOREIGN KEY ("org_id") REFERENCES "auth"."organization"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger"."entry" ADD CONSTRAINT "entry_org_id_organization_id_fk" FOREIGN KEY ("org_id") REFERENCES "auth"."organization"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger"."entry" ADD CONSTRAINT "entry_journal_fk" FOREIGN KEY ("journal_id","org_id") REFERENCES "ledger"."journal"("id","org_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger"."entry" ADD CONSTRAINT "entry_account_fk" FOREIGN KEY ("account_id","org_id") REFERENCES "ledger"."account"("id","org_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger"."journal" ADD CONSTRAINT "journal_org_id_organization_id_fk" FOREIGN KEY ("org_id") REFERENCES "auth"."organization"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger"."journal" ADD CONSTRAINT "journal_transaction_fk" FOREIGN KEY ("transaction_id","org_id") REFERENCES "core"."mpesa_transaction"("id","org_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "event_org_id_occurred_at_index" ON "audit"."event" USING btree ("org_id","occurred_at");--> statement-breakpoint
CREATE INDEX "account_userId_idx" ON "auth"."account" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "invitation_organizationId_idx" ON "auth"."invitation" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "invitation_email_idx" ON "auth"."invitation" USING btree ("email");--> statement-breakpoint
CREATE INDEX "member_organizationId_idx" ON "auth"."member" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "member_userId_idx" ON "auth"."member" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "session_userId_idx" ON "auth"."session" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "verification_identifier_idx" ON "auth"."verification" USING btree ("identifier");--> statement-breakpoint
CREATE INDEX "allocation_transaction_id_index" ON "core"."allocation" USING btree ("transaction_id");--> statement-breakpoint
CREATE INDEX "allocation_expected_payment_id_index" ON "core"."allocation" USING btree ("expected_payment_id");--> statement-breakpoint
CREATE INDEX "allocation_org_id_index" ON "core"."allocation" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "exception_org_id_status_created_at_index" ON "core"."exception" USING btree ("org_id","status","created_at");--> statement-breakpoint
CREATE INDEX "expected_payment_org_id_status_due_date_index" ON "core"."expected_payment" USING btree ("org_id","status","due_date");--> statement-breakpoint
CREATE INDEX "match_org_id_transaction_id_index" ON "core"."match" USING btree ("org_id","transaction_id");--> statement-breakpoint
CREATE INDEX "mpesa_transaction_org_id_transacted_at_index" ON "core"."mpesa_transaction" USING btree ("org_id","transacted_at");--> statement-breakpoint
CREATE INDEX "mpesa_transaction_org_id_status_index" ON "core"."mpesa_transaction" USING btree ("org_id","status");--> statement-breakpoint
CREATE INDEX "shortcode_org_id_index" ON "core"."shortcode" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "inbound_event_org_id_received_at_index" ON "ingest"."inbound_event" USING btree ("org_id","received_at");--> statement-breakpoint
CREATE INDEX "entry_journal_id_index" ON "ledger"."entry" USING btree ("journal_id");--> statement-breakpoint
CREATE INDEX "entry_org_id_account_id_index" ON "ledger"."entry" USING btree ("org_id","account_id");--> statement-breakpoint
CREATE INDEX "journal_org_id_created_at_index" ON "ledger"."journal" USING btree ("org_id","created_at");