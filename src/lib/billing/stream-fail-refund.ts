/**
 * 失败流自动退款(2026-07-29 luwei@hidream.ai 诊断的根治件②)。
 *
 * 背景:/v1/messages 流式透传时,号池上游(pool-claude ccmax ch119-138 等)会出现
 * 「200 头已发 → 流里只有 ping → 最后一个 error 事件/直接断」的中途失败。new-api
 * 对这种失败仍会按【自数输入 token、0 输出】落一条 type=2 消费行 —— 客户被扣了
 * 输入费但什么都没拿到(7-23~7-29 单客户 37 笔 ¥16.76)。new-api 是 AGPL 不改源码,
 * 在 portal 层【事后精确冲账】:
 *
 * 精确性来源:Anthropic 面(/v1/messages)上游响应头 `x-oneapi-request-id` ==
 * new-api 账单行 request_id(2026-07-29 真机验证,见 memory
 * v1-usage-endpoint-request-id)。proxy 检出失败流时把该头带过来,延迟查账后
 * 【按 request_id 单行】退,零时间窗猜测、零误伤:
 *   - 行必须 type=2 且 completion_tokens=0 且 quota>0 才退(有输出 = 客户拿到了
 *     东西,不属于本判据,宁可漏不可错);
 *   - 客户主动断流不走本路径(proxy 只对「上游 error 尾/无 message_start 死流」
 *     调用本模块,client abort 在 hold 层单独识别、不触发);
 *   - RechargeLog note 里带 request_id 标记做幂等(同一行永不双退);
 *   - 每用户 24h 退款条数熔断(上游整体炸时不放大账务写入,报警人工接管)。
 *
 * 仅支持 billing_mode='newapi'(现网除企业门户外全部);portal ¥账本客户打警报
 * 走人工(P4c canary 客户极少,错退风险 > 自动化收益)。
 */
import 'server-only';
import { prisma } from '@/lib/db';
import { addQuota, getUser, queryLogs } from '@/lib/newapi/client';
import { quotaToCny } from '@/lib/newapi/quota-units';

/** 检出失败 → 首次查账的延迟:new-api 在流失败当刻结算,12s 足够账落库。 */
const FIRST_LOOKUP_DELAY_MS = 12_000;
/** 首查没找到账单行时的二次确认延迟(可能结算慢);二查仍无 = 没扣钱,正确不动。 */
const SECOND_LOOKUP_DELAY_MS = 20_000;
/** 单用户 24h 自动退款条数熔断。 */
const DAILY_REFUND_CAP = 50;
/** RechargeLog note 前缀(幂等标记 + 报表可辨识)。 */
const NOTE_PREFIX = '[stream-fail]';

export interface StreamFailRefundArgs {
    /** 失败的那次上游响应的 x-oneapi-request-id(== 账单行 request_id)。 */
    upstreamRequestId: string | null;
    /** 客户请求的原始鉴权值(authorization 或 x-api-key 头,可含 Bearer/sk- 前缀)。 */
    rawAuth: string | null;
    model: string;
    /** 日志标签(哪条管道检出的)。 */
    label: string;
}

/** fire-and-forget:proxy 检出失败流后调用,不阻塞客户响应路径。 */
export function scheduleStreamFailRefund(args: StreamFailRefundArgs): void {
    if (!args.upstreamRequestId || !args.rawAuth) {
        console.warn('[stream-fail-refund] missing request id or auth, skip', {
            label: args.label,
            model: args.model,
            hasRequestId: !!args.upstreamRequestId,
        });
        return;
    }
    const timer = setTimeout(() => {
        void runStreamFailRefund(args).catch((err) => {
            console.warn('[stream-fail-refund] failed', {
                label: args.label,
                requestId: args.upstreamRequestId,
                err: err instanceof Error ? err.message : String(err),
            });
        });
    }, FIRST_LOOKUP_DELAY_MS);
    (timer as unknown as { unref?: () => void }).unref?.();
}

/** 主流程(导出供测试直接驱动,绕过 setTimeout)。 */
export async function runStreamFailRefund(args: StreamFailRefundArgs): Promise<void> {
    const requestId = args.upstreamRequestId!;
    const stored = (args.rawAuth ?? '')
        .replace(/^Bearer\s+/i, '')
        .trim()
        .replace(/^sk-/, '');
    if (!stored) return;

    const token = await prisma.newApiToken.findUnique({
        where: { newapi_token_value: stored },
        select: {
            user: {
                select: { id: true, newapi_user_id: true, newapi_username: true, billing_mode: true },
            },
        },
    });
    const user = token?.user;
    if (!user || user.newapi_user_id == null || user.newapi_username == null) return;
    if (user.billing_mode !== 'newapi') {
        // portal ¥账本客户:自动冲账没走通账本链路,人工处理(量极小)。
        console.warn('[stream-fail-refund] portal-billing user needs MANUAL refund review', {
            userId: user.id,
            requestId,
            model: args.model,
        });
        return;
    }

    const row = await findBilledRow(user.newapi_user_id, user.newapi_username, requestId);
    if (!row) return; // 没扣钱(记成了错误行)= 正确,不动

    // 幂等:同一 request_id 只退一次
    const already = await prisma.rechargeLog.findFirst({
        where: { user_id: user.id, source: 'refund', note: { contains: requestId } },
        select: { id: true },
    });
    if (already) return;

    // 熔断:上游整体故障时不放大自动账务写入
    const recent = await prisma.rechargeLog.count({
        where: {
            user_id: user.id,
            source: 'refund',
            note: { startsWith: NOTE_PREFIX },
            created_at: { gte: new Date(Date.now() - 24 * 3600 * 1000) },
        },
    });
    if (recent >= DAILY_REFUND_CAP) {
        console.warn('[stream-fail-refund] DAILY CAP HIT — manual review needed', {
            userId: user.id,
            requestId,
            cap: DAILY_REFUND_CAP,
        });
        return;
    }

    // 冲账(镜像 balance-adjust newapi 路径:add → cache bust → 流水)
    const before = (await getUser(user.newapi_user_id)).quota;
    await addQuota({ userId: user.newapi_user_id, quotaDelta: row.quota, mode: 'add' });
    await prisma.user.update({
        where: { id: user.id },
        data: { newapi_quota_cache: null, newapi_used_quota_cache: null, newapi_cached_at: null },
    });
    try {
        await prisma.rechargeLog.create({
            data: {
                user_id: user.id,
                amount: quotaToCny(row.quota), // 正数 ¥ = 退回余额
                balance_before: quotaToCny(before),
                balance_after: quotaToCny(before + row.quota),
                newapi_quota_added: BigInt(row.quota),
                newapi_user_id: user.newapi_user_id,
                source: 'refund',
                note: `${NOTE_PREFIX} 上游流中途失败自动退款 model=${args.model} request_id=${requestId}`,
            },
        });
    } catch (err) {
        // 流水失败不回滚已退的额度(客户不吃亏);幂等标记丢失可能导致重复退,
        // 但本函数每次失败流只调度一次,重复窗口仅限「同 request_id 再次检出」= 不发生。
        console.warn('[stream-fail-refund] recharge_log insert failed', {
            userId: user.id,
            requestId,
            err: err instanceof Error ? err.message : String(err),
        });
    }
    console.warn('[stream-fail-refund] refunded', {
        userId: user.id,
        requestId,
        model: args.model,
        quota: row.quota,
        cny: quotaToCny(row.quota).toFixed(4),
        label: args.label,
    });
}

/** 按 request_id 精确找到那笔被扣的行;首查不到等 SECOND_LOOKUP_DELAY_MS 再确认一次。 */
async function findBilledRow(
    newapiUserId: number,
    username: string,
    requestId: string,
): Promise<{ quota: number } | null> {
    for (let attempt = 1; attempt <= 2; attempt++) {
        const { items } = await queryLogs({
            user_id: newapiUserId,
            username,
            request_id: requestId,
            type: 2,
            page_size: 10,
        });
        const row = items.find(
            (l) =>
                l.user_id === newapiUserId &&
                l.request_id === requestId &&
                l.type === 2 &&
                l.completion_tokens === 0 &&
                l.quota > 0,
        );
        if (row) return { quota: row.quota };
        // 同 request_id 但有输出/0 扣费 → 明确不该退,不再等
        if (items.some((l) => l.request_id === requestId)) return null;
        if (attempt === 1) await new Promise((r) => setTimeout(r, SECOND_LOOKUP_DELAY_MS));
    }
    return null;
}
