ALTER TABLE "api_tokens" DROP CONSTRAINT "api_tokens_role_check";--> statement-breakpoint
ALTER TABLE "training_users" DROP CONSTRAINT "training_users_role_check";--> statement-breakpoint
UPDATE api_tokens SET role = 'support' WHERE role = 'agent';--> statement-breakpoint
UPDATE training_users SET role = 'support' WHERE role = 'agent';--> statement-breakpoint
ALTER TABLE "api_tokens" ADD CONSTRAINT "api_tokens_role_check" CHECK ("api_tokens"."role" IN ('customer', 'support', 'admin'));--> statement-breakpoint
ALTER TABLE "training_users" ADD CONSTRAINT "training_users_role_check" CHECK ("training_users"."role" IN ('customer', 'support', 'admin'));
