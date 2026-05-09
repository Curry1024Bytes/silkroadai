-- AlterTable
ALTER TABLE "users" ADD COLUMN     "newapi_system_token_id" TEXT,
ADD COLUMN     "newapi_system_token_value" TEXT;

-- CreateTable
CREATE TABLE "image_generations" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "prompt" TEXT NOT NULL,
    "model_name" TEXT NOT NULL,
    "size" TEXT NOT NULL,
    "count" INTEGER NOT NULL,
    "r2_keys" JSONB NOT NULL,
    "cost_usd" DECIMAL(10,6) NOT NULL,
    "quota_consumed" BIGINT NOT NULL,
    "is_favorite" BOOLEAN NOT NULL DEFAULT false,
    "is_deleted" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMP(3),

    CONSTRAINT "image_generations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "image_generations_user_id_is_favorite_created_at_idx" ON "image_generations"("user_id", "is_favorite", "created_at" DESC);

-- CreateIndex
CREATE INDEX "image_generations_expires_at_idx" ON "image_generations"("expires_at");

-- AddForeignKey
ALTER TABLE "image_generations" ADD CONSTRAINT "image_generations_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
