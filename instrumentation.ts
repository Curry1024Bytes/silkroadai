/**
 * Next.js 启动钩子(每个 runtime 启动时调用一次 register)。
 *
 * 给 Node 内置 fetch 装自定义 undici dispatcher,把 headersTimeout / bodyTimeout 从默认 300s
 * 提到 600s。否则 portal → new-api 的慢生图(ch83 adobe 大图要 300-600s 才返响应头)会在 300s
 * 撞 `UND_ERR_HEADERS_TIMEOUT` → "fetch failed",而 new-api 那边已出图【并计费】→ 客户「扣了费没图」。
 *
 * ⚠️ 关键:`AbortSignal.timeout()` 覆盖不了 undici 的 headersTimeout(两者是独立机制),PR #229 只挂
 * signal 没用。只能靠 dispatcher 改 headersTimeout。setGlobalDispatcher 通过 globalThis 上的共享
 * symbol 影响 Node 内置 fetch(配置 proxy/超时的标准做法)。与 Caddy `ai.silkroadai.io` 的 600s 对齐。
 * 见 2026-07-13 lkl1131888403 诊断(portal 日志实锤 UND_ERR_HEADERS_TIMEOUT)。
 *
 * 只在 nodejs runtime 生效(edge runtime 无 undici,也不发这类长 fetch)。
 */
export async function register() {
    if (process.env.NEXT_RUNTIME === 'nodejs') {
        const { setGlobalDispatcher, Agent } = await import('undici');
        setGlobalDispatcher(
            new Agent({
                headersTimeout: 600_000, // 与 Caddy response_header_timeout 600s 对齐
                bodyTimeout: 600_000,
            }),
        );
    }
}
