-- AlterTable
ALTER TABLE "users" ADD COLUMN     "balance_alert_last_sent_at" TIMESTAMP(3),
ADD COLUMN     "balance_alert_threshold_cny" DECIMAL(8,2) DEFAULT 10.00;
