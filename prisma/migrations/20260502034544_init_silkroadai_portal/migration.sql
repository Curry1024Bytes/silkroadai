-- CreateIndex
CREATE INDEX "orders_payment_type_paid_at_idx" ON "orders"("payment_type", "paid_at");
