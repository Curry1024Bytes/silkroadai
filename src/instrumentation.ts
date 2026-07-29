/**
 * Next.js 启动钩子(每个 runtime 启动时调用一次 register)。
 *
 * ⚠️ 单一事实源 —— 全仓只能有【这一个】instrumentation.ts,且必须在 **src/**。
 * 实测(Next 16 + Turbopack,2026-07-28 两次部署验证):
 *  - 只有根目录 instrumentation.ts → 钩子【完全不编译】,register 不跑
 *    (.next/server 里连 instrumentation 产物都没有)
 *  - 根 + src 并存 → 钩子启用但编译解析到【根】文件,src 内容被静默丢弃
 *    (PR #231 由此让五个调度器停摆 15 天:订单超时 / 余额提醒 / 图片清理 /
 *    分销结算 / shadow meter;铁证 = usage_records 最后一行停在 #231 部署时刻)
 *  - 只有 src/instrumentation.ts → 正确(#231 之前的长期形态)
 * 所以:不要在仓库根再建 instrumentation.ts,任何 register 逻辑都加在这里。
 *
 * ── Part 1:undici dispatcher(PR #231)──
 * 给 Node 内置 fetch 把 headersTimeout / bodyTimeout 从默认 300s 提到 600s。
 * 否则 portal → new-api 的慢生图(ch83 adobe 大图要 300-600s 才返响应头)会在
 * 300s 撞 `UND_ERR_HEADERS_TIMEOUT` → "fetch failed",而 new-api 已出图【并计费】
 * → 客户「扣了费没图」。`AbortSignal.timeout()` 覆盖不了 headersTimeout(独立机制),
 * 只能靠 dispatcher。与 Caddy `ai.silkroadai.io` 600s 对齐。见 2026-07-13
 * lkl1131888403 诊断。
 *
 * ── Part 2:后台调度器(仅主站单实例跑)──
 * 两道门,命中任一即不跑:
 *  - `PORTAL_FLAVOR=seedance-enterprise`:seedance 独立门户实例(与主站共库)
 *  - `PORTAL_SCHEDULERS=off`:/v1 API 副本实例(2026-07-28 起 Caddy 把客户 API
 *    流量负载均衡到 portal-api-{1..3},website 与调度器留在主实例)
 * 否则双实例双跑(meter 游标竞态 / 提醒双发风险)。
 */
export async function register() {
    if (process.env.NEXT_RUNTIME !== 'nodejs') return;

    const { setGlobalDispatcher, Agent, ProxyAgent } = await import('undici');
    const devProxyUrl = process.env.NODE_ENV !== 'production' ? process.env.DEV_PROXY_URL : undefined;
    let proxyInstalled = false;

    if (devProxyUrl) {
        try {
            setGlobalDispatcher(new ProxyAgent(devProxyUrl));
            proxyInstalled = true;
            console.log(`[dev-proxy] outbound fetch via ${devProxyUrl}`);
        } catch (error) {
            console.warn('[dev-proxy] failed to install proxy dispatcher', error);
        }
    }

    if (!proxyInstalled) {
        setGlobalDispatcher(
            new Agent({
                headersTimeout: 600_000, // 与 Caddy response_header_timeout 600s 对齐
                bodyTimeout: 600_000,
            }),
        );
    }

    // W5 D4: Sentry server-side init. Conditional on SENTRY_DSN — empty env
    // keeps SDK in no-op mode so dev / test runs don't ship anywhere.
    // (config 在项目根,本文件在 src/ 下 → ../)
    await import('../sentry.server.config');

    // 调度器门(见文件头 Part 2)
    if (process.env.PORTAL_FLAVOR === 'seedance-enterprise') return;
    if (process.env.PORTAL_SCHEDULERS === 'off') return;

    const { startTimeoutScheduler } = await import('@/lib/order/timeout');
    startTimeoutScheduler();

    // W6 D2: balance-low retention alerts. 1h cadence.
    const { startBalanceAlertScheduler } = await import('@/lib/scheduler/balance-alert');
    startBalanceAlertScheduler();

    // PR-T1 Phase 4: image-generation TTL + soft-delete sweep. 6h cadence.
    const { startImageCleanupScheduler } = await import('@/lib/scheduler/image-cleanup');
    startImageCleanupScheduler();

    // PR-U1: reseller commission hold-release (pending → confirmed after
    // 14d) + monthly settlement auto-create on day 1 UTC. 1h cadence.
    const { startResellerCommissionScheduler } = await import('@/lib/scheduler/reseller-commission');
    startResellerCommissionScheduler();

    // P4a: shadow metering — poll new-api consume logs → UsageRecord (¥ per
    // CatalogPrice). Pure observation, no billing/balance impact. 10m cadence.
    const { startShadowMeterScheduler } = await import('@/lib/scheduler/shadow-meter');
    startShadowMeterScheduler();
}
