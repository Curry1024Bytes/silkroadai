/**
 * Reseller commission computation + write (PR-U1).
 *
 * Called from inside `executeRecharge`'s interactive transaction
 * (`src/lib/order/service.ts`) right after RechargeLog.create() and
 * before the cache-bust user.update(). Sits inside the same tx so:
 *   - rollback semantics: any failure downstream rolls back the
 *     commission write too (no orphaned commission rows when recharge
 *     post-write step fails).
 *   - atomic Reseller.cumulative_gmv update (tier upgrade check happens
 *     in the same tx, no read-after-write window).
 *
 * Threshold for admin manual-review hold (brief 防控 #3):
 *   commission_amount > ¥100,000 → admin_review_required=true,
 *   status stays pending forever (cron skips it) until ops flips it.
 *
 * Tier upgrade audit:
 *   When tier crosses up, an AnalyticsEvent `reseller_tier_upgraded`
 *   row is written in the same tx (best-effort — wrapped in try/catch
 *   inside record() so a Prisma hiccup on analytics doesn't roll back
 *   the recharge). Audit row format:
 *     { reseller_id, from_tier, to_tier, cumulative_gmv_after }
 */
import 'server-only';
import { Prisma } from '@prisma/client';
import type { Prisma as PrismaTypes } from '@prisma/client';
import { tierForGmv, isTierUpgrade } from './tier';

/** 14-day hold window (brief). Stored as a const so tests + cron + writer
 *  agree on the duration; production tweak = edit this + ship. */
export const HOLD_DURATION_MS = 14 * 24 * 60 * 60 * 1_000;

/** Auto-review threshold. commission_amount > THIS triggers
 *  admin_review_required=true. Brief value = ¥100,000. */
export const COMMISSION_AUTO_REVIEW_THRESHOLD_CNY = 100_000;

export interface CommissionWriteInput {
    /** Reseller earning the commission. */
    reseller_id: string;
    /** Customer (User.id of the recharging user). */
    user_id: string;
    /** Just-written RechargeLog row id. 1:1 with the resulting Commission
     *  row (unique constraint on the column). */
    recharge_log_id: string;
    /** CNY amount of the recharge (= RechargeLog.amount). */
    attributed_gmv_cny: PrismaTypes.Decimal | number;
    /** `now()` from the tx caller. Used to compute hold_until and to keep
     *  tests deterministic. */
    now: Date;
}

export interface CommissionWriteResult {
    commission_id: string;
    commission_rate: number;
    commission_amount_cny: PrismaTypes.Decimal;
    admin_review_required: boolean;
    tier_upgraded: { from: string; to: string } | null;
}

/**
 * Write a ResellerCommission row + update Reseller.cumulative_gmv +
 * conditionally upgrade Reseller.tier. Returns details for audit logging
 * by the caller.
 *
 * **Must be called from inside a $transaction.** Pass the tx client as
 * `tx`. Throws on any prisma error — caller rolls back the recharge tx.
 *
 * Idempotency: the recharge_log_id @unique constraint guarantees one
 * commission row per recharge. If somehow re-called (e.g., test
 * mistakenly invokes twice), Prisma throws P2002 and the caller tx
 * rolls back. The right outcome.
 */
export async function writeCommissionInTx(
    tx: PrismaTypes.TransactionClient,
    input: CommissionWriteInput,
): Promise<CommissionWriteResult> {
    // Read reseller row inside tx to get current cumulative_gmv with
    // row-level lock semantics in Postgres READ COMMITTED. Two concurrent
    // recharges of two different attributed customers under the same
    // reseller will serialize on this update path (Reseller.cumulative_gmv
    // update is the contention point), which is the correct trade-off:
    // money math must not race.
    const reseller = await tx.reseller.findUnique({
        where: { id: input.reseller_id },
        select: { id: true, tier: true, cumulative_gmv: true, status: true },
    });
    if (!reseller) {
        // Defensive — shouldn't happen since attribution sets inviter_reseller_id
        // only to a real Reseller. If a reseller was deleted mid-flight, we
        // throw and the recharge rolls back. Operator can re-trigger via
        // /admin retry once they sort the state.
        throw new Error(`writeCommissionInTx: reseller ${input.reseller_id} not found`);
    }
    // suspended/banned reseller doesn't earn commission. Skip silently —
    // recharge still succeeds, just no commission row.
    if (reseller.status !== 'active') {
        return {
            commission_id: '',
            commission_rate: 0,
            commission_amount_cny: new Prisma.Decimal(0),
            admin_review_required: false,
            tier_upgraded: null,
        };
    }

    const gmvBefore = new Prisma.Decimal(reseller.cumulative_gmv);
    const attributedGmv = new Prisma.Decimal(input.attributed_gmv_cny.toString());

    // Compute rate based on CURRENT tier (pre-this-recharge GMV). Tier
    // upgrades affect the NEXT commission, not this one. (Operator
    // calibration: rate snapshotted at INSERT, no back-pay.)
    const currentRule = tierForGmv(gmvBefore);
    const rate = new Prisma.Decimal(currentRule.rate.toString());
    const commissionAmount = attributedGmv.mul(rate);

    // Auto manual-review: > ¥100,000 commission → hold for human review.
    const adminReviewRequired = commissionAmount.gt(COMMISSION_AUTO_REVIEW_THRESHOLD_CNY);

    const holdUntil = new Date(input.now.getTime() + HOLD_DURATION_MS);

    const commission = await tx.resellerCommission.create({
        data: {
            reseller_id: input.reseller_id,
            user_id: input.user_id,
            recharge_log_id: input.recharge_log_id,
            attributed_gmv: attributedGmv,
            commission_rate: rate,
            commission_amount: commissionAmount,
            status: 'pending',
            admin_review_required: adminReviewRequired,
            hold_until: holdUntil,
        },
        select: { id: true },
    });

    // Update cumulative_gmv. New tier = function of new GMV.
    const gmvAfter = gmvBefore.add(attributedGmv);
    const upgradeCheck = isTierUpgrade(gmvBefore, gmvAfter);
    const newTier = tierForGmv(gmvAfter).tier;

    await tx.reseller.update({
        where: { id: input.reseller_id },
        data: {
            cumulative_gmv: gmvAfter,
            // Always write tier (cheap — same string when no upgrade);
            // simpler than branching on the upgrade boolean.
            tier: newTier,
        },
    });

    // Audit tier upgrade as an analytics event (PR-T3 reused). user_id is
    // the reseller's user_id (not the customer's) — so dashboards can
    // group tier upgrades per reseller. Best-effort; failure doesn't
    // break recharge.
    if (upgradeCheck.upgraded) {
        try {
            const resellerOwner = await tx.reseller.findUnique({
                where: { id: input.reseller_id },
                select: { user_id: true },
            });
            if (resellerOwner) {
                await tx.analyticsEvent.create({
                    data: {
                        user_id: resellerOwner.user_id,
                        event_type: 'reseller_tier_upgraded',
                        properties: {
                            reseller_id: input.reseller_id,
                            from_tier: upgradeCheck.from,
                            to_tier: upgradeCheck.to,
                            cumulative_gmv_after: gmvAfter.toString(),
                            triggering_commission_id: commission.id,
                        },
                    },
                });
            }
        } catch (err) {
            // Audit failure is non-fatal — log + continue. The tier
            // upgrade is still recorded in Reseller.tier (the source of
            // truth); analytics is a nice-to-have.
            console.warn(
                `[reseller-commission] tier-upgrade audit failed for reseller=${input.reseller_id}:`,
                err instanceof Error ? err.message : err,
            );
        }
    }

    return {
        commission_id: commission.id,
        commission_rate: currentRule.rate,
        commission_amount_cny: commissionAmount,
        admin_review_required: adminReviewRequired,
        tier_upgraded: upgradeCheck.upgraded ? { from: upgradeCheck.from, to: upgradeCheck.to } : null,
    };
}

/**
 * Decide whether a user's current attribution is still valid for
 * commission purposes. Used by the recharge hook to short-circuit before
 * touching the Reseller table.
 *
 *   - inviter_reseller_id null → not attributed → return false
 *   - attribution_expires_at null → defensive (shouldn't pair with non-null
 *       reseller_id; treat as expired)
 *   - attribution_expires_at ≤ now → expired (24-month protection window
 *       elapsed) → return false
 */
export function isAttributionActive(args: {
    inviter_reseller_id: string | null;
    attribution_expires_at: Date | null;
    now: Date;
}): boolean {
    if (!args.inviter_reseller_id) return false;
    if (!args.attribution_expires_at) return false;
    return args.attribution_expires_at.getTime() > args.now.getTime();
}
