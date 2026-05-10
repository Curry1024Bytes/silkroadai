-- CreateTable
CREATE TABLE "analytics_events" (
    "id" UUID NOT NULL,
    "user_id" UUID,
    "event_type" TEXT NOT NULL,
    "properties" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "analytics_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "analytics_events_event_type_created_at_idx" ON "analytics_events"("event_type", "created_at" DESC);

-- CreateIndex
CREATE INDEX "analytics_events_user_id_created_at_idx" ON "analytics_events"("user_id", "created_at" DESC);

-- AddForeignKey
ALTER TABLE "analytics_events" ADD CONSTRAINT "analytics_events_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
