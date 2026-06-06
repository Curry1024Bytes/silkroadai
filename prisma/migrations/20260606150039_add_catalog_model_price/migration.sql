-- CreateTable
CREATE TABLE "catalog_models" (
    "id" UUID NOT NULL,
    "tenant_id" UUID,
    "slug" TEXT NOT NULL,
    "display_name" TEXT NOT NULL,
    "vendor" TEXT NOT NULL,
    "modality" TEXT NOT NULL DEFAULT 'chat',
    "context_window" INTEGER,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "upstream_map" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "catalog_models_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "catalog_prices" (
    "id" UUID NOT NULL,
    "model_id" UUID NOT NULL,
    "tier" TEXT NOT NULL,
    "input_cny_per_1m" DECIMAL(12,4),
    "output_cny_per_1m" DECIMAL(12,4),
    "per_image_cny" DECIMAL(12,4),
    "cost_cny_per_1m" DECIMAL(12,4),
    "effective_from" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "catalog_prices_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "catalog_models_tenant_id_sort_order_idx" ON "catalog_models"("tenant_id", "sort_order");

-- CreateIndex
CREATE UNIQUE INDEX "catalog_models_tenant_id_slug_key" ON "catalog_models"("tenant_id", "slug");

-- CreateIndex
CREATE INDEX "catalog_prices_model_id_tier_effective_from_idx" ON "catalog_prices"("model_id", "tier", "effective_from");

-- AddForeignKey
ALTER TABLE "catalog_models" ADD CONSTRAINT "catalog_models_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "catalog_prices" ADD CONSTRAINT "catalog_prices_model_id_fkey" FOREIGN KEY ("model_id") REFERENCES "catalog_models"("id") ON DELETE CASCADE ON UPDATE CASCADE;
