-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_key_id_fkey" FOREIGN KEY ("key_id") REFERENCES "litellm_keys"("id") ON DELETE SET NULL ON UPDATE CASCADE;
