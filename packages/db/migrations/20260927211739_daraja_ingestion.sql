CREATE TABLE "ingest"."daraja_token" (
	"credential_id" text PRIMARY KEY NOT NULL,
	"ciphertext" "bytea" NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ingest"."stk_request" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"org_id" text NOT NULL,
	"shortcode_id" uuid NOT NULL,
	"checkout_request_id" text,
	"merchant_request_id" text,
	"account_reference" text NOT NULL,
	"amount" bigint NOT NULL,
	"phone_ciphertext" "bytea",
	"status" text DEFAULT 'initiated' NOT NULL,
	"result_code" text,
	"result_desc" text,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "stk_request_checkoutRequestId_unique" UNIQUE("checkout_request_id"),
	CONSTRAINT "stk_request_id_org_unique" UNIQUE("id","org_id"),
	CONSTRAINT "stk_request_status" CHECK (status IN ('initiated', 'pending', 'succeeded', 'failed', 'cancelled', 'unknown')),
	CONSTRAINT "stk_request_amount_positive" CHECK ("ingest"."stk_request"."amount" > 0),
	CONSTRAINT "stk_request_account_reference_length" CHECK (char_length("ingest"."stk_request"."account_reference") BETWEEN 1 AND 12)
);
--> statement-breakpoint
CREATE TABLE "ingest"."unrouted_event" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"source" text NOT NULL,
	"external_id" text NOT NULL,
	"reason" text NOT NULL,
	"payload" jsonb NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "unrouted_event_source_externalId_unique" UNIQUE("source","external_id"),
	CONSTRAINT "unrouted_event_source" CHECK (source IN ('c2b_validation', 'c2b_confirmation', 'stk_callback', 'transaction_status_result', 'reversal_result', 'account_balance_result', 'queue_timeout', 'pull', 'statement')),
	CONSTRAINT "unrouted_event_reason" CHECK (reason IN ('unknown_shortcode', 'unknown_checkout', 'invalid_payload', 'malformed_json'))
);
--> statement-breakpoint
ALTER TABLE "core"."mpesa_transaction" ADD COLUMN "stk_request_id" uuid;--> statement-breakpoint
ALTER TABLE "ingest"."stk_request" ADD CONSTRAINT "stk_request_org_id_organization_id_fk" FOREIGN KEY ("org_id") REFERENCES "auth"."organization"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ingest"."stk_request" ADD CONSTRAINT "stk_request_shortcode_fk" FOREIGN KEY ("shortcode_id","org_id") REFERENCES "core"."shortcode"("id","org_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "stk_request_org_id_created_at_index" ON "ingest"."stk_request" USING btree ("org_id","created_at");--> statement-breakpoint
ALTER TABLE "core"."mpesa_transaction" ADD CONSTRAINT "mpesa_transaction_stk_request_fk" FOREIGN KEY ("stk_request_id","org_id") REFERENCES "ingest"."stk_request"("id","org_id") ON DELETE no action ON UPDATE no action;