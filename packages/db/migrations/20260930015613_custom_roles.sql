CREATE TABLE "auth"."organization_role" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"role" text NOT NULL,
	"permission" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "auth"."organization_role" ADD CONSTRAINT "organization_role_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "auth"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "organizationRole_organizationId_idx" ON "auth"."organization_role" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "organizationRole_role_idx" ON "auth"."organization_role" USING btree ("role");--> statement-breakpoint
-- One role name per organization, whatever the case; Better Auth only checks exact names in code.
CREATE UNIQUE INDEX "organization_role_name_unique" ON "auth"."organization_role" ("organization_id", lower("role"));--> statement-breakpoint
-- Default privileges already grant paysync_app on new auth tables; stated here for the record.
GRANT SELECT, INSERT, UPDATE, DELETE ON "auth"."organization_role" TO paysync_app;
