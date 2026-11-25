CREATE TABLE "sd_video_task_metadata" (
    "task_id" TEXT NOT NULL,
    "user_id" UUID NOT NULL,
    "public_model" TEXT NOT NULL,
    "resolution" TEXT,
    "has_video" BOOLEAN,
    "aspect_ratio" TEXT,
    "request_summary" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "sd_video_task_metadata_pkey" PRIMARY KEY ("task_id"),
    CONSTRAINT "sd_video_task_metadata_task_id_check" CHECK ("task_id" ~ '^task_[A-Za-z0-9]{32}$'),
    CONSTRAINT "sd_video_task_metadata_resolution_check" CHECK ("resolution" IN ('480p', '720p', '1080p')),
    CONSTRAINT "sd_video_task_metadata_aspect_ratio_check" CHECK (
        "aspect_ratio" IS NULL OR "aspect_ratio" IN ('16:9', '9:16', '4:3', '3:4', '1:1', '21:9')
    )
);

CREATE INDEX "sd_video_task_metadata_user_id_created_at_idx"
ON "sd_video_task_metadata"("user_id", "created_at");
