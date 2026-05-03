/*
  Warnings:

  - You are about to drop the column `email_verify_expires` on the `users` table. All the data in the column will be lost.
  - You are about to drop the column `email_verify_token` on the `users` table. All the data in the column will be lost.
  - You are about to drop the column `reset_password_expires` on the `users` table. All the data in the column will be lost.
  - You are about to drop the column `reset_password_token` on the `users` table. All the data in the column will be lost.

  These four columns are W1 sub2apipay-era scaffolding that was never wired
  up. PasswordResetToken table (W3 D4) and EmailVerificationToken table
  (this migration) supersede them.

*/

-- 1. Schema change: drop 4 stale W1 columns, add new email_verified_at.
ALTER TABLE "users" DROP COLUMN "email_verify_expires",
DROP COLUMN "email_verify_token",
DROP COLUMN "reset_password_expires",
DROP COLUMN "reset_password_token",
ADD COLUMN     "email_verified_at" TIMESTAMP(3);

-- 2. Backfill: every existing user is treated as already verified — they
--    were created in the W1/W2/W3 pre-verification era and we are not
--    going to email-spam our own test users to force them through a flow
--    they never opted into. Set both `email_verified_at` (new source of
--    truth) and `email_verified` Boolean (kept for read-side compat with
--    existing login / user routes) so the two fields stay consistent.
UPDATE "users"
SET "email_verified_at" = "created_at",
    "email_verified" = TRUE;

-- 3. New EmailVerificationToken table — mirrors PasswordResetToken design
--    (uuid pk / FK CASCADE / token_hash UNIQUE / expires_at / used_at /
--    created_at; raw token only in mail body, only sha256(token) hits DB).
CREATE TABLE "email_verification_tokens" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "token_hash" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "used_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "email_verification_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "email_verification_tokens_token_hash_key" ON "email_verification_tokens"("token_hash");

-- CreateIndex
CREATE INDEX "email_verification_tokens_user_id_used_at_idx" ON "email_verification_tokens"("user_id", "used_at");

-- AddForeignKey
ALTER TABLE "email_verification_tokens" ADD CONSTRAINT "email_verification_tokens_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
