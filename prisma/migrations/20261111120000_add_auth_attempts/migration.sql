-- CreateTable
CREATE TABLE "auth_attempts" (
    "id" UUID NOT NULL,
    "kind" VARCHAR(32) NOT NULL,
    "outcome" VARCHAR(32) NOT NULL,
    "email" VARCHAR(254),
    "ip" VARCHAR(45),
    "user_id" UUID,
    "user_agent" VARCHAR(300),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "auth_attempts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "auth_attempts_email_created_at_idx" ON "auth_attempts"("email", "created_at" DESC);

-- CreateIndex
CREATE INDEX "auth_attempts_ip_created_at_idx" ON "auth_attempts"("ip", "created_at" DESC);

-- CreateIndex
CREATE INDEX "auth_attempts_created_at_idx" ON "auth_attempts"("created_at");

