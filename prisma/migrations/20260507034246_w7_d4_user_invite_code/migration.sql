-- AlterTable
ALTER TABLE "users" ADD COLUMN     "invite_code" TEXT;

-- CreateIndex
CREATE INDEX "users_invite_code_idx" ON "users"("invite_code");
