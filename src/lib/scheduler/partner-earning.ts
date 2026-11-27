/**
 * 代理结算 job（15 分钟一轮，P1 v2：按日志倍率结算）
 *
 * 每轮：
 *  1. 对账代理在 new-api 的配置：平台新增的可用分组要对代理客户隐藏（reconcilePartnerPricing）。
 *  2. 读游标 partner_last_log_id。首次运行（游标为 0）只把游标设到当前位置，不回溯历史日志。
 *  3. 上界 = 60 秒前最新一条日志（任意类型）的 id，避开还没落库的日志；再按代理客户逐个拉
 *     (游标, 上界] 的扣费（type=2）与退款（type=6）日志。
 *  4. 扣费日志：零售率 r = other.user_group_ratio，且必须等于代理在扣费时刻前后 2 分钟内设置的
 *     零售率（零售率历史），否则说明没按代理价扣费，跳过并告警；批发率 w 取扣费时刻生效的历史值。
 *       零售收入 = quotaToCny(quota)；批发成本 = 零售收入 × w ÷ r；代理利润 = 零售收入 − 批发成本
 *  5. 退款日志：按 other.task_id 找回同一任务的扣费行，按退款 quota 占扣费 quota 的比例冲减
 *     （写一条 kind=refund 的负数明细）。找不到扣费行、或退款 affecting 的已冲减额度已满，就跳过。
 *  6. 收益明细、钱包累加、游标推进放在同一个事务里；游标按旧值做条件更新，两个实例同时跑也不会重复入账。
 */
import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db';
import { queryLogs, type NewApiUsageLog } from '@/lib/newapi/client';
import { quotaToCny } from '@/lib/newapi/quota-units';
import { parseLoggedBill } from '@/lib/admin/pricing-bill-check';
import { loadPlatformBillingGroups, reconcilePartnerPricing } from '@/lib/partner/pricing-sync';

const INTERVAL_MS = 15 * 60 * 1_000;
const PAGE_SIZE = 100;
/** 单个客户一轮最多翻的页数（2 万条）。超过就整轮失败、游标不动，避免漏结。 */
const MAX_PAGES_PER_CUSTOMER = 200;
/** 只结算 60 秒前的日志：new-api 先分配 id 后提交，太新的日志可能还有更小的 id 没落库。 */
const SETTLE_LAG_SECONDS = 60;
/** 零售率落库比 new-api 生效略晚，扣费时刻前后这个窗口内设置过的零售率都算代理价。 */
const RETAIL_TOLERANCE_SECONDS = 120;

let timer: ReturnType<typeof setInterval> | null = null;

export type SkipReason =
    | 'no_partner_ratio'
    | 'ratio_not_partner'
    | 'group_unknown'
    | 'no_wholesale'
    | 'zero_quota'
    | 'refund_unlinked'
    | 'refund_exceeds';

export interface EarningRow {
    tenant_id: string;
    user_id: string;
    newapi_log_id: number;
    kind: 'consume' | 'refund';
    task_id: string | null;
    model_slug: string;
    group_key: string;
    prompt_tokens: number;
    completion_tokens: number;
    charged_quota: bigint;
    retail_ratio: Prisma.Decimal;
    wholesale_ratio: Prisma.Decimal;
    retail_cny: Prisma.Decimal;
    wholesale_cny: Prisma.Decimal;
    profit_cny: Prisma.Decimal;
}

export type SettlementOutcome = { kind: 'earning'; row: EarningRow } | { kind: 'skip'; reason: SkipReason };

export interface PartnerEarningResult {
    cursorBefore: number;
    cursorAfter: number;
    logsScanned: number;
    earningsCreated: number;
    skipped: Partial<Record<SkipReason, number>>;
}

interface HistoryRow<T> {
    tenant_id: string;
    group_key: string;
    value: T;
    effective_from: Date;
}

/**
 * 扣费时刻可接受的代理零售率。取「扣费时刻」和「扣费时刻 + 容差」两个时点生效的值：
 * 前者覆盖长期有效的价，后者覆盖 new-api 已生效、Portal 历史行还没提交（或扣费前一瞬刚改价）的情况。
 * 关闭分组后的调用本来就无法扣费，所以两个值里只要有一个等于日志记录的倍率就按代理价结算。
 */
export type RetailLookup = (tenantId: string, groupKey: string, at: Date) => number[];
/** 某代理某分组在某时刻生效的批发率；没有历史返回 null。 */
export type WholesaleLookup = (tenantId: string, groupKey: string, at: Date) => Prisma.Decimal | null;

function byTenantGroup<T>(rows: Array<HistoryRow<T>>): Map<string, Array<HistoryRow<T>>> {
    const buckets = new Map<string, Array<HistoryRow<T>>>();
    for (const row of rows) {
        const key = `${row.tenant_id}|${row.group_key}`;
        const bucket = buckets.get(key) ?? [];
        bucket.push(row);
        buckets.set(key, bucket);
    }
    for (const bucket of buckets.values()) bucket.sort((a, b) => b.effective_from.getTime() - a.effective_from.getTime());
    return buckets;
}

export function retailLookup(
    history: Array<{ tenant_id: string; group_key: string; retail_ratio: Prisma.Decimal | null; effective_from: Date }>,
): RetailLookup {
    const buckets = byTenantGroup(history.map((row) => ({ ...row, value: row.retail_ratio })));
    const at = (bucket: Array<HistoryRow<Prisma.Decimal | null>>, when: number): number | null => {
        const row = bucket.find((entry) => entry.effective_from.getTime() <= when);
        return row?.value == null ? null : Number(row.value);
    };
    return (tenantId, groupKey, time) => {
        const bucket = buckets.get(`${tenantId}|${groupKey}`);
        if (!bucket) return [];
        const values = [
            at(bucket, time.getTime()),
            at(bucket, time.getTime() + RETAIL_TOLERANCE_SECONDS * 1000),
        ].filter((value): value is number => value !== null);
        return [...new Set(values)];
    };
}

/** 批发率历史按 (代理, 分组) 分桶，取不晚于日志时间的最新一行。 */
export function wholesaleLookup(
    history: Array<{ tenant_id: string; group_key: string; wholesale_ratio: Prisma.Decimal; effective_from: Date }>,
): WholesaleLookup {
    const buckets = byTenantGroup(history.map((row) => ({ ...row, value: row.wholesale_ratio })));
    return (tenantId, groupKey, at) => {
        const bucket = buckets.get(`${tenantId}|${groupKey}`);
        if (!bucket) return null;
        return bucket.find((row) => row.effective_from <= at)?.value ?? null;
    };
}

function decimal(value: number): Prisma.Decimal {
    return new Prisma.Decimal(value).toDecimalPlaces(6);
}

/** 结算一条扣费日志。纯函数，便于测试。 */
export function settleLog(args: {
    log: NewApiUsageLog;
    tenantId: string;
    userId: string;
    /** 该代理 new-api 计费分组 → 平台档次 key。 */
    groupKeys: Map<string, string>;
    retailAt: RetailLookup;
    wholesaleAt: WholesaleLookup;
}): SettlementOutcome {
    const { log } = args;
    if (log.quota <= 0) return { kind: 'skip', reason: 'zero_quota' };
    const retailRatio = parseLoggedBill(log).recorded.user_group_ratio;
    if (retailRatio === null) return { kind: 'skip', reason: 'no_partner_ratio' };
    const groupKey = args.groupKeys.get(log.group);
    if (!groupKey) return { kind: 'skip', reason: 'group_unknown' };
    const at = new Date(log.created_at * 1000);
    if (!args.retailAt(args.tenantId, groupKey, at).includes(retailRatio)) return { kind: 'skip', reason: 'ratio_not_partner' };
    const wholesaleRatio = args.wholesaleAt(args.tenantId, groupKey, at);
    if (!wholesaleRatio) return { kind: 'skip', reason: 'no_wholesale' };

    const retailCny = decimal(quotaToCny(log.quota));
    const wholesaleCny = retailCny.mul(wholesaleRatio).div(decimal(retailRatio)).toDecimalPlaces(6);
    return {
        kind: 'earning',
        row: {
            tenant_id: args.tenantId,
            user_id: args.userId,
            newapi_log_id: log.id,
            kind: 'consume',
            task_id: taskIdOf(log),
            model_slug: log.model_name.slice(0, 200),
            group_key: groupKey,
            prompt_tokens: log.prompt_tokens,
            completion_tokens: log.completion_tokens,
            charged_quota: BigInt(log.quota),
            retail_ratio: decimal(retailRatio),
            wholesale_ratio: wholesaleRatio,
            retail_cny: retailCny,
            wholesale_cny: wholesaleCny,
            profit_cny: retailCny.minus(wholesaleCny),
        },
    };
}

function taskIdOf(log: NewApiUsageLog): string | null {
    try {
        const other: unknown = JSON.parse(log.other || '{}');
        if (!other || typeof other !== 'object' || Array.isArray(other)) return null;
        const task = (other as Record<string, unknown>).task_id;
        return typeof task === 'string' && task.trim() ? task.trim().slice(0, 200) : null;
    } catch {
        return null;
    }
}

/** 退款冲减：按退款 quota 占扣费 quota 的比例，把扣费那一行的收入/成本/利润都反向记一遍。 */
export function settleRefund(args: {
    log: NewApiUsageLog;
    consume: { group_key: string; charged_quota: bigint; retail_ratio: Prisma.Decimal; wholesale_ratio: Prisma.Decimal; retail_cny: Prisma.Decimal; wholesale_cny: Prisma.Decimal; profit_cny: Prisma.Decimal; task_id: string | null; model_slug: string };
    userId: string;
    tenantId: string;
    /** 该任务此前已经冲减掉的 quota。 */
    alreadyRefunded: Prisma.Decimal;
}): SettlementOutcome {
    const { log } = args;
    if (log.quota <= 0) return { kind: 'skip', reason: 'zero_quota' };
    const taskId = taskIdOf(log);
    if (!taskId) return { kind: 'skip', reason: 'refund_unlinked' };
    const charged = args.consume.charged_quota;
    if (charged <= 0n) return { kind: 'skip', reason: 'refund_unlinked' };
    const remaining = new Prisma.Decimal(charged.toString()).minus(args.alreadyRefunded);
    if (remaining.lte(0)) return { kind: 'skip', reason: 'refund_exceeds' };
    const refund = Prisma.Decimal.min(new Prisma.Decimal(log.quota), remaining).toDecimalPlaces(6);
    const ratio = refund.div(new Prisma.Decimal(charged.toString()));
    const negate = (value: Prisma.Decimal) => value.mul(ratio).toDecimalPlaces(6).negated();
    return {
        kind: 'earning',
        row: {
            tenant_id: args.tenantId,
            user_id: args.userId,
            newapi_log_id: log.id,
            kind: 'refund',
            task_id: taskId,
            model_slug: args.consume.model_slug || log.model_name.slice(0, 200),
            group_key: args.consume.group_key,
            prompt_tokens: 0,
            completion_tokens: 0,
            charged_quota: -BigInt(refund.toFixed(0)),
            retail_ratio: args.consume.retail_ratio,
            wholesale_ratio: args.consume.wholesale_ratio,
            retail_cny: negate(args.consume.retail_cny),
            wholesale_cny: negate(args.consume.wholesale_cny),
            profit_cny: negate(args.consume.profit_cny),
        },
    };
}

/** 60 秒前最新一条日志（任意类型）的 id；没有日志返回 null。 */
async function settleUpperBound(): Promise<number | null> {
    const { items } = await queryLogs({
        end_timestamp: Math.floor(Date.now() / 1000) - SETTLE_LAG_SECONDS,
        page: 1,
        page_size: 1,
    });
    return items[0]?.id ?? null;
}

/** 某客户 id 在 (after, upTo] 内的指定类型日志。日志按 id 倒序返回。 */
async function customerLogs(
    username: string,
    type: 2 | 6,
    after: number,
    upTo: number,
): Promise<NewApiUsageLog[]> {
    const result: NewApiUsageLog[] = [];
    for (let page = 1; page <= MAX_PAGES_PER_CUSTOMER; page += 1) {
        const { items } = await queryLogs({ type, username, page, page_size: PAGE_SIZE });
        for (const log of items) {
            if (log.username === username && log.id > after && log.id <= upTo) result.push(log);
        }
        if (items.length < PAGE_SIZE || items[items.length - 1].id <= after) return result;
    }
    throw new Error(`[partner-earning] ${username} 一轮内日志超过 ${MAX_PAGES_PER_CUSTOMER * PAGE_SIZE} 条，本轮不结算`);
}

async function advanceCursor(db: Prisma.TransactionClient, from: number, to: number): Promise<void> {
    const moved = await db.usageMeterCursor.updateMany({
        where: { id: 1, partner_last_log_id: from },
        data: { partner_last_log_id: to },
    });
    if (moved.count !== 1) throw new Error('[partner-earning] 游标已被其他实例推进，本轮放弃');
}

export async function runPartnerEarning(): Promise<PartnerEarningResult> {
    const cursorRow = await prisma.usageMeterCursor.upsert({
        where: { id: 1 },
        create: { id: 1, last_log_id: 0, partner_last_log_id: 0 },
        update: {},
    });
    const cursor = cursorRow.partner_last_log_id;
    const result: PartnerEarningResult = {
        cursorBefore: cursor,
        cursorAfter: cursor,
        logsScanned: 0,
        earningsCreated: 0,
        skipped: {},
    };
    const skip = (reason: SkipReason) => {
        result.skipped[reason] = (result.skipped[reason] ?? 0) + 1;
    };

    const upper = await settleUpperBound();
    if (upper === null || upper <= cursor) return result;
    if (cursor === 0) {
        // 首次运行：从现在开始结算，历史日志与代理定价无关。
        await prisma.$transaction((tx) => advanceCursor(tx, cursor, upper));
        result.cursorAfter = upper;
        return result;
    }

    const [retailHistory, wholesaleHistory, billingGroups] = await Promise.all([
        prisma.partnerRetailRatioHistory.findMany({
            select: { tenant_id: true, group_key: true, retail_ratio: true, effective_from: true },
        }),
        prisma.partnerWholesaleRatioHistory.findMany({
            select: { tenant_id: true, group_key: true, wholesale_ratio: true, effective_from: true },
        }),
        loadPlatformBillingGroups(),
    ]);
    const tenantIds = [...new Set(retailHistory.map((row) => row.tenant_id))];
    if (!tenantIds.length) {
        await prisma.$transaction((tx) => advanceCursor(tx, cursor, upper));
        result.cursorAfter = upper;
        return result;
    }

    const groupKeysByTenant = new Map<string, Map<string, string>>();
    const ambiguous = new Set<string>();
    for (const row of retailHistory) {
        const newapiGroup = billingGroups.get(row.group_key);
        if (!newapiGroup) continue;
        const map = groupKeysByTenant.get(row.tenant_id) ?? new Map<string, string>();
        const existing = map.get(newapiGroup);
        if (existing !== undefined && existing !== row.group_key) ambiguous.add(`${row.tenant_id}|${newapiGroup}`);
        map.set(newapiGroup, row.group_key);
        groupKeysByTenant.set(row.tenant_id, map);
    }

    const retailAt = retailLookup(retailHistory);
    const wholesaleAt = wholesaleLookup(wholesaleHistory);
    const customers = await prisma.user.findMany({
        where: { tenant_id: { in: tenantIds }, newapi_username: { not: null } },
        select: { id: true, tenant_id: true, newapi_username: true },
    });

    const rows: EarningRow[] = [];
    for (const customer of customers) {
        const tenantId = customer.tenant_id!;
        const groupKeys = groupKeysByTenant.get(tenantId) ?? new Map<string, string>();
        const [consumes, refunds] = await Promise.all([
            customerLogs(customer.newapi_username!, 2, cursor, upper),
            customerLogs(customer.newapi_username!, 6, cursor, upper),
        ]);
        result.logsScanned += consumes.length + refunds.length;

        const consumeRows = new Map<number, EarningRow>();
        for (const log of consumes) {
            if (ambiguous.has(`${tenantId}|${log.group}`)) {
                skip('group_unknown');
                continue;
            }
            const outcome = settleLog({ log, tenantId, userId: customer.id, groupKeys, retailAt, wholesaleAt });
            if (outcome.kind === 'skip') {
                skip(outcome.reason);
                continue;
            }
            consumeRows.set(outcome.row.newapi_log_id, outcome.row);
            rows.push(outcome.row);
        }

        // 同一任务的扣费行：本轮的先用内存，更早的查库。
        const byTask = new Map<string, EarningRow>();
        for (const row of consumeRows.values()) if (row.task_id) byTask.set(row.task_id, row);
        const refundedByTask = new Map<string, Prisma.Decimal>();
        for (const log of refunds) {
            const taskId = taskIdOf(log);
            if (!taskId) {
                skip('refund_unlinked');
                continue;
            }
            let consume = byTask.get(taskId);
            if (!consume) {
                const stored = await prisma.partnerEarning.findFirst({
                    where: { tenant_id: tenantId, task_id: taskId, kind: 'consume' },
                    orderBy: { settled_at: 'desc' },
                });
                if (stored) {
                    consume = {
                        tenant_id: stored.tenant_id,
                        user_id: customer.id,
                        newapi_log_id: stored.newapi_log_id,
                        kind: 'consume',
                        task_id: stored.task_id,
                        model_slug: stored.model_slug,
                        group_key: stored.group_key,
                        prompt_tokens: stored.prompt_tokens,
                        completion_tokens: stored.completion_tokens,
                        charged_quota: stored.charged_quota,
                        retail_ratio: stored.retail_ratio,
                        wholesale_ratio: stored.wholesale_ratio,
                        retail_cny: stored.retail_cny,
                        wholesale_cny: stored.wholesale_cny,
                        profit_cny: stored.profit_cny,
                    };
                }
            }
            if (!consume) {
                skip('refund_unlinked');
                continue;
            }
            let alreadyRefunded = refundedByTask.get(taskId);
            if (!alreadyRefunded) {
                const prior = await prisma.partnerEarning.aggregate({
                    where: { tenant_id: tenantId, task_id: taskId, kind: 'refund' },
                    _sum: { charged_quota: true },
                });
                alreadyRefunded = new Prisma.Decimal(prior._sum.charged_quota?.toString() ?? '0').negated();
            }
            const outcome = settleRefund({ log, consume, userId: customer.id, tenantId, alreadyRefunded });
            if (outcome.kind === 'skip') {
                skip(outcome.reason);
                continue;
            }
            refundedByTask.set(
                taskId,
                alreadyRefunded.plus(new Prisma.Decimal(outcome.row.charged_quota.toString()).negated()),
            );
            rows.push(outcome.row);
        }
    }

    const profitByTenant = new Map<string, Prisma.Decimal>();
    for (const row of rows) {
        profitByTenant.set(row.tenant_id, (profitByTenant.get(row.tenant_id) ?? new Prisma.Decimal(0)).plus(row.profit_cny));
    }

    await prisma.$transaction(async (tx) => {
        // 不用 skipDuplicates：重复说明另一个实例已结算过这些日志，整轮回滚。
        if (rows.length) await tx.partnerEarning.createMany({ data: rows });
        for (const [tenantId, total] of profitByTenant) {
            const profit = total.toDecimalPlaces(4);
            if (profit.isZero()) continue;
            await tx.partnerWallet.upsert({
                where: { tenant_id: tenantId },
                create: { tenant_id: tenantId, balance_cny: profit, total_earned_cny: profit },
                update: { balance_cny: { increment: profit }, total_earned_cny: { increment: profit } },
            });
        }
        await advanceCursor(tx, cursor, upper);
    });
    result.earningsCreated = rows.length;
    result.cursorAfter = upper;

    const negative = rows.filter((row) => row.kind === 'consume' && row.profit_cny.isNegative()).map((row) => row.newapi_log_id);
    if (negative.length) console.warn('[partner-earning] 零售率低于批发率的日志', { logIds: negative.slice(0, 20) });
    const warnings = Object.fromEntries(Object.entries(result.skipped).filter(([reason]) => reason !== 'zero_quota'));
    if (Object.keys(warnings).length) {
        console.warn('[partner-earning] 跳过的代理客户日志（未按代理价扣费或分组未开放）', warnings);
    }
    return result;
}

/** 一轮：先对账代理配置，再结算。两步互不阻塞。 */
export async function runPartnerTick(): Promise<void> {
    try {
        const rewritten = await reconcilePartnerPricing();
        if (rewritten.length) console.warn('[partner-earning] 已重写代理 new-api 配置', { tenants: rewritten });
    } catch (err) {
        console.error('[partner-earning] 代理配置对账失败:', err);
    }
    try {
        await runPartnerEarning();
    } catch (err) {
        console.error('[partner-earning] 结算失败，游标未推进:', err);
    }
}

export function startPartnerEarningScheduler(): void {
    if (timer) return;
    // 首次延迟 2 分钟，避免进程启动时和 shadow-meter 并发争 queryLogs
    setTimeout(() => {
        void runPartnerTick();
        timer = setInterval(() => void runPartnerTick(), INTERVAL_MS);
    }, 2 * 60 * 1_000);
}
