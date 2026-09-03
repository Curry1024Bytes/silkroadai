import 'server-only';
import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db';
import { queryLogs, type NewApiUsageLog } from '@/lib/newapi/client';
import { PLATFORM_TENANT_ID } from '@/lib/admin/tenant-scope';
import { computeUsageCost, pickEffectivePrice } from './cost';
import { applyLedgerEntry } from './ledger';
import { billingSourceIsPortal } from './billing-source';
import { syncNewapiGate } from './newapi-gate';

/**
 * P4a 影子计量 job:轮询 new-api consume 日志,按客户 token 档次取生效 CatalogPrice 算 ¥,
 * 写 UsageRecord(只读账)。
 *
 * ⚠️ 边界(P4a 死线):只 GET new-api 日志 + 只写 portal 自己的 usage_records / usage_meter_cursor。
 * 不扣余额、不挡请求、不改充值、不调 new-api 任何写接口、不碰 GET /api/user/token(gotcha #13)。
 *
 * 幂等:UsageRecord.newapi_log_id @unique + createMany skipDuplicates → 每条日志最多一条记录;
 * cursor 只在成功后推进,失败重跑不重复计。
 *
 * 取日志:new-api `/api/log/` 按 id DESC(最新在前)返回。本 job 从最新往回翻,收集 id > cursor
 * 的 consume 日志,翻到「整页都 ≤ cursor」即停(已处理territory)。若上游某天改了排序,
 * 幂等 + P4b 对账会把"漏算"显现成差异 —— 影子阶段可观察、不动钱,可接受(brief §7)。
 */

const PAGE_SIZE = 1000;
const MAX_PAGES = 50; // 每轮硬上限 ≤ 50k 日志(沿用 usage-aggregate 的界)

export interface ShadowMeterResult {
    cursorBefore: number;
    cursorAfter: number;
    pagesFetched: number;
    fetched: number; // id > cursor 的 consume 日志数(本轮看到的)
    recorded: number; // 实际新建的 UsageRecord 数(排除幂等跳过 + 无 portal user 跳过)
    matched: number;
    unmatched: number;
    skippedNoUser: number;
    charged: number; // P4c-2:扣了 ¥账本的条数(仅 portal 模式 + matched + 两道门通过;默认 0)
}

type ResolvedUser = { id: string; tenant_id: string | null } | null;
type ResolvedToken = { id: string; tier: string } | null;
type ResolvedLogGroup = { key: string } | null;
type ModelWithPrices = {
    upstream_map: unknown;
    prices: { id: string; tier: string; effective_from: Date; input_cny_per_1m: unknown; output_cny_per_1m: unknown }[];
} | null;

export async function runShadowMeter(): Promise<ShadowMeterResult> {
    // 1) 读游标(单行表,懒建)。
    const cursor = await prisma.usageMeterCursor.upsert({
        where: { id: 1 },
        create: { id: 1, last_log_id: 0 },
        update: {},
    });
    const lastLogId = cursor.last_log_id;

    const result: ShadowMeterResult = {
        cursorBefore: lastLogId,
        cursorAfter: lastLogId,
        pagesFetched: 0,
        fetched: 0,
        recorded: 0,
        matched: 0,
        unmatched: 0,
        skippedNoUser: 0,
        charged: 0,
    };

    // 2) 翻页拉 type=2(consume)日志,收集 id > cursor 的。
    const fresh: NewApiUsageLog[] = [];
    for (let page = 1; page <= MAX_PAGES; page++) {
        const r = await queryLogs({ type: 2, page, page_size: PAGE_SIZE });
        result.pagesFetched++;
        const pageFresh = r.items.filter((l) => l.type === 2 && l.id > lastLogId);
        fresh.push(...pageFresh);
        if (r.items.length < PAGE_SIZE) break; // 最后一页
        if (pageFresh.length === 0) break; // DESC:已翻进 ≤ cursor 的旧territory
    }
    result.fetched = fresh.length;

    if (fresh.length === 0) {
        await prisma.usageMeterCursor.update({ where: { id: 1 }, data: { last_run_at: new Date() } });
        return result;
    }

    // 3) 逐条解析(user / token→tier / 生效价)并算成本。in-run 缓存避免重复查询。
    const userCache = new Map<number, ResolvedUser>();
    const tokenCache = new Map<number, ResolvedToken>();
    const logGroupCache = new Map<string, ResolvedLogGroup>();
    const modelCache = new Map<string, ModelWithPrices>();

    const rows: Prisma.UsageRecordCreateManyInput[] = [];
    let maxId = lastLogId;

    for (const log of fresh) {
        if (log.id > maxId) maxId = log.id;

        // portal user(必需 —— UsageRecord.user_id NOT NULL);非 portal 用户的调用跳过。
        let user = userCache.get(log.user_id);
        if (user === undefined) {
            user = await prisma.user.findUnique({
                where: { newapi_user_id: log.user_id },
                select: { id: true, tenant_id: true },
            });
            userCache.set(log.user_id, user);
        }
        if (!user) {
            result.skippedNoUser++;
            continue;
        }

        // token → 档次。系统 token 不在 Portal NewApiToken 表时,使用日志自身的
        // new-api group 反查当前 tenant 的 ChannelGroup;仍无法唯一解析则写显式
        // unresolved 标记且 matched=false,绝不虚构历史 `pool` 档。
        let token: ResolvedToken = null;
        if (log.token_id) {
            let cached = tokenCache.get(log.token_id);
            if (cached === undefined) {
                cached = await prisma.newApiToken.findUnique({
                    where: { newapi_token_id: log.token_id },
                    select: { id: true, tier: true },
                });
                tokenCache.set(log.token_id, cached);
            }
            token = cached;
        }
        let tier = token?.tier;
        if (!tier) {
            const newapiGroup = typeof log.group === 'string' ? log.group.trim() : '';
            const modelTenant = user.tenant_id ?? PLATFORM_TENANT_ID;
            const cacheKey = `${modelTenant}\u0000${newapiGroup}`;
            let resolved = logGroupCache.get(cacheKey);
            if (resolved === undefined) {
                const matches = newapiGroup
                    ? await prisma.channelGroup.findMany({
                          where: { tenant_id: modelTenant, enabled: true, newapi_group: newapiGroup },
                          select: { key: true },
                          take: 2,
                      })
                    : [];
                resolved = matches.length === 1 ? matches[0] : null;
                logGroupCache.set(cacheKey, resolved);
            }
            tier = resolved?.key ?? `unresolved:${newapiGroup || 'unknown'}`;
        }

        // CatalogModel(按 user 的 tenant + slug)+ 其版本化价。
        const modelTenant = user.tenant_id ?? PLATFORM_TENANT_ID;
        const slug = log.model_name || '';
        const mkey = `${modelTenant} ${slug}`;
        let model = modelCache.get(mkey);
        if (model === undefined) {
            model = slug
                ? await prisma.catalogModel.findFirst({
                      where: { tenant_id: modelTenant, slug },
                      select: {
                          upstream_map: true,
                          prices: {
                              select: {
                                  id: true,
                                  tier: true,
                                  effective_from: true,
                                  input_cny_per_1m: true,
                                  output_cny_per_1m: true,
                              },
                          },
                      },
                  })
                : null;
            modelCache.set(mkey, model);
        }

        const logTime = new Date(log.created_at * 1000);
        const upstreamMap =
            model?.upstream_map && typeof model.upstream_map === 'object' && !Array.isArray(model.upstream_map)
                ? (model.upstream_map as Record<string, unknown>)
                : {};
        const price =
            model && Object.hasOwn(upstreamMap, tier)
                ? pickEffectivePrice(
                      model.prices.map((p) => ({
                          id: p.id,
                          tier: p.tier,
                          effective_from: p.effective_from,
                          input_cny_per_1m: p.input_cny_per_1m as string | number | null,
                          output_cny_per_1m: p.output_cny_per_1m as string | number | null,
                      })),
                      tier,
                      logTime,
                  )
                : null;
        const { costCny, matched } = computeUsageCost(price, log.prompt_tokens ?? 0, log.completion_tokens ?? 0);
        if (matched) result.matched++;
        else result.unmatched++;

        rows.push({
            tenant_id: user.tenant_id,
            user_id: user.id,
            token_id: token?.id ?? null,
            newapi_log_id: log.id,
            newapi_user_id: log.user_id,
            model_slug: slug,
            tier,
            input_tokens: log.prompt_tokens ?? 0,
            output_tokens: log.completion_tokens ?? 0,
            cost_cny: costCny,
            price_id: price?.id ?? null,
            matched,
            newapi_quota: log.quota ?? 0,
            log_created_at: logTime,
        });
    }

    // 4) 幂等批量写(newapi_log_id 冲突即跳过)。
    if (rows.length > 0) {
        const created = await prisma.usageRecord.createMany({ data: rows, skipDuplicates: true });
        result.recorded = created.count;
    }

    // 4.5) P4c-2 计量扣账本 —— 两道门(全局 BILLING_SOURCE + 单客户 billing_mode='portal')。
    //   纯记账,【不挡请求】;只扣 matched(有价);(charge, ref=UsageRecord.id) 幂等绝不双扣。
    //   全局门 = newapi(默认/未设)→ 整个阶段跳过,对 newapi 客户零开销、零回归。
    //   放在【推进游标之前】:扣费崩了 cursor 不前进 → 下轮重拉 + (charge,ref) 幂等补扣,不丢账。
    if (billingSourceIsPortal() && rows.length > 0) {
        await debitPortalUsers(rows, result);
    }

    // 5) 推进游标(只在成功后)。
    await prisma.usageMeterCursor.update({ where: { id: 1 }, data: { last_log_id: maxId, last_run_at: new Date() } });
    result.cursorAfter = maxId;

    return result;
}

/**
 * P4c-2:对【本轮新写的、portal 模式客户的、matched 有价】UsageRecord,用 applyLedgerEntry 扣 ¥账本。
 *
 * createMany 不回 id → 按 newapi_log_id 取回真实 UsageRecord(拿其 id 作幂等 ref)。
 * 单客户门:批量查 billing_mode='portal' 的 user(防 N+1);非 portal → 不扣(= 现状)。
 * 幂等:(kind='charge', ref=UsageRecord.id) 唯一约束 —— meter 重处理 / 崩溃重跑都不双扣。
 * 不挡请求:扣费失败仅 warn、不抛(UsageRecord 已写、cursor 照常前进,下轮 ref 幂等补)。
 */
async function debitPortalUsers(rows: Prisma.UsageRecordCreateManyInput[], result: ShadowMeterResult): Promise<void> {
    const freshLogIds = rows.map((r) => r.newapi_log_id);
    // 只取 matched(有价)的真实记录;matched=false 算不出价 → 不扣(留观察 / 对账)。
    const records = await prisma.usageRecord.findMany({
        where: { newapi_log_id: { in: freshLogIds }, matched: true },
        select: { id: true, user_id: true, cost_cny: true, model_slug: true, tier: true },
    });
    if (records.length === 0) return;

    const userIds = [...new Set(records.map((r) => r.user_id))];
    const portalUserIds = new Set(
        (
            await prisma.user.findMany({
                where: { id: { in: userIds }, billing_mode: 'portal' },
                select: { id: true },
            })
        ).map((u) => u.id),
    );
    if (portalUserIds.size === 0) return; // 无人是 portal → 不扣(= 现状)

    const chargedUserIds = new Set<string>();
    for (const rec of records) {
        if (!portalUserIds.has(rec.user_id)) continue; // 单客户门:非 portal → 跳过
        if (rec.cost_cny.isZero()) continue; // 0 成本:无需记账(不动余额、不留噪声)
        try {
            await applyLedgerEntry(rec.user_id, {
                kind: 'charge',
                amount_cny: rec.cost_cny.negated(), // 扣减(负);cost_cny = 零售价 = 客户该付的
                ref: rec.id, // (charge, ref) 幂等 —— 绝不双扣
                note: `${rec.model_slug}/${rec.tier}`,
            });
            result.charged++;
            chargedUserIds.add(rec.user_id);
        } catch (err) {
            // 不挡请求 / 不阻断计量:扣费失败只 warn。UsageRecord 已写、cursor 照常前进。
            console.warn(
                `[meter] ledger charge failed for usage ${rec.id} (user ${rec.user_id}):`,
                err instanceof Error ? err.message : err,
            );
        }
    }

    // P4c-3 哑门:本轮扣过费的 portal 客户重新同步 new-api quota —— 余额掉到 ≤0 → 关门
    //   (new-api 拒 → insufficient_user_quota);仍 >0 → 顶满 GATE_OPEN_QUOTA。每客户一次。
    //   非致命:失败仅 warn,下一轮 meter / 下次充值会再 sync(透支窗口 = 一个轮询周期)。
    for (const uid of chargedUserIds) {
        try {
            await syncNewapiGate(uid);
        } catch (err) {
            console.warn(
                `[meter] syncNewapiGate failed for user ${uid} (next run reconciles):`,
                err instanceof Error ? err.message : err,
            );
        }
    }
}

/**
 * P4c-5 §1.5:每轮兜底把【所有】portal 客户的哑门重同步到账本余额(余额 >0 顶满放行 / ≤0 关门),
 * 不依赖"是否本轮被扣费"。根治 P4c-5 灰度发现的卡死缺口 —— 任何改余额的路径(admin 调余额/退款/
 * 未来别的入口)漏调 syncNewapiGate 时,下一轮 meter 必然把哑门校正到与账本一致,卡死客户最多等
 * 一个轮询周期自愈。
 *
 * 独立于 {@link runShadowMeter} 的日志处理 —— 由 scheduler 每轮单独调一次(`shadow-meter.ts`),
 * 所以即使本轮没有任何日志/扣费,空闲 / 被 admin 调过余额 / 退过款的 portal 客户的哑门也会被校正。
 * 仅 BILLING_SOURCE='portal' 时跑;syncNewapiGate 内部再守 `billing_mode='portal'` + 有 newapi_user_id
 * (newapi 客户 quota 一字不碰)。量级:portal 客户极少,每轮全量 sync 无压力(将来多了可只 sync
 * 余额可能变过的那批,先做全量兜底,简单稳)。失败逐个吞掉、不阻断。返回成功 sync 的客户数。
 */
export async function reconcileAllPortalGates(): Promise<number> {
    if (!billingSourceIsPortal()) return 0; // 全局门关 → 不碰任何人

    const portalUsers = await prisma.user.findMany({
        where: { billing_mode: 'portal' },
        select: { id: true },
    });
    let synced = 0;
    for (const u of portalUsers) {
        try {
            await syncNewapiGate(u.id);
            synced++;
        } catch (err) {
            console.warn(`[meter] gate reconcile failed for user ${u.id}:`, err instanceof Error ? err.message : err);
        }
    }
    return synced;
}

/**
 * flip-guardrail §2 反向危险态:全局闸关(`BILLING_SOURCE≠portal`)但仍有 `billing_mode='portal'`
 * 客户 —— 他们【脱钩】:哑门 quota 停在 1e9、`syncNewapiGate`/meter 全 no-op → 账本冻结、不扣费 →
 * 可能无限免费用。这是 kill-switch 的盲区(比 357 半翻号更糟:单关 env flag 不是完整 revert,
 * 关闸前必须先把所有 portal 客户回滚到 newapi)。
 *
 * 返回这种"孤儿"portal 客户数(闸【开】→ 返 0,portal 客户是正常态、不算孤儿)。**只读、无副作用**
 * —— 调用方负责 loud warn + Sentry 告警,【不】自动回滚客户(太重 + 有风险,留人工)。
 */
export async function countOrphanedPortalCustomers(): Promise<number> {
    if (billingSourceIsPortal()) return 0; // 闸开 → portal 客户正常,不算孤儿
    return prisma.user.count({ where: { billing_mode: 'portal' } });
}
