-- W8 D8: widen recharge_logs money columns 12,4 → 20,4 (defense-in-depth).
--
-- Root cause of the 2026-06-03 13× over-charge incident: executeRecharge wrote
-- raw quota (getUser().quota, 1–2 亿 in prod) into balance_before/balance_after,
-- which were numeric(12,4) (max 99,999,999.9999 ≈ 1 亿). A ¥1000 recharge mints
-- ~1.43 亿 raw quota → "numeric field overflow" → the recharge transaction (which
-- also held the non-rollbackable applyTopup side effect) rolled back → the dedup
-- row never persisted → Alipay webhook retried → quota added ~13×.
--
-- The code fix stores ¥CNY (via quotaToCny) in balance_*; raw quota lives only in
-- newapi_quota_added (BigInt). Widening to 20,4 is belt-and-suspenders so this
-- column type can never be the overflow point again regardless of unit.
--
-- AlterTable
ALTER TABLE "recharge_logs" ALTER COLUMN "amount" SET DATA TYPE DECIMAL(20,4),
ALTER COLUMN "balance_before" SET DATA TYPE DECIMAL(20,4),
ALTER COLUMN "balance_after" SET DATA TYPE DECIMAL(20,4);
