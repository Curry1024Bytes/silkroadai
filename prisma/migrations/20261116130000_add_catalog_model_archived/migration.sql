-- Archive retired catalog models without deleting pricing or usage history.
ALTER TABLE "catalog_models"
ADD COLUMN "archived" BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX "catalog_models_tenant_id_archived_sort_order_idx"
ON "catalog_models"("tenant_id", "archived", "sort_order");
