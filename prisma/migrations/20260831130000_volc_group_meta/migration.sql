-- volc 素材组名字所有权表。纯增量:新表,不动既有任何表;回滚 = DROP TABLE。
CREATE TABLE "volc_group_meta" (
    "vendor_id" TEXT NOT NULL,
    "user_id" UUID,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "volc_group_meta_pkey" PRIMARY KEY ("vendor_id")
);
