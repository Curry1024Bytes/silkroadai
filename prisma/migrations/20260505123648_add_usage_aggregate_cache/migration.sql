-- CreateTable
CREATE TABLE "usage_aggregate_cache" (
    "user_id" UUID NOT NULL,
    "period" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "computed_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "usage_aggregate_cache_pkey" PRIMARY KEY ("user_id","period")
);

-- AddForeignKey
ALTER TABLE "usage_aggregate_cache" ADD CONSTRAINT "usage_aggregate_cache_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
