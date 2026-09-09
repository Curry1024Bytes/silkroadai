import 'dotenv/config';
import { basename } from 'node:path';

type TargetCheck = { ok: boolean; reason: string; origin?: string };
const MAX_STATUS_BYTES = 64 * 1024;

/** A credential-free preflight; this is not a substitute for authenticated smoke tests. */
export async function checkNewapiSmokeTarget(
    baseUrl: string,
    { fetchImpl = fetch, timeoutMs = 5000 }: { fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): Promise<TargetCheck> {
    let base: URL;
    try {
        base = new URL(baseUrl);
    } catch {
        return { ok: false, reason: 'NEWAPI_BASE_URL 不是有效 URL。' };
    }
    if (
        !['http:', 'https:'].includes(base.protocol) ||
        base.username ||
        base.password ||
        base.pathname !== '/' ||
        base.search ||
        base.hash
    ) {
        return { ok: false, reason: 'NEWAPI_BASE_URL 应为不含凭据、路径或查询参数的 HTTP(S) 服务地址。' };
    }
    const origin = base.origin;
    try {
        const response = await fetchImpl(new URL('/api/status', base), {
            method: 'GET',
            redirect: 'manual',
            signal: AbortSignal.timeout(timeoutMs),
        });
        if (!response.ok || !response.headers.get('content-type')?.toLowerCase().includes('application/json')) {
            await response.body?.cancel();
            return {
                ok: false,
                origin,
                reason: `状态接口返回 HTTP ${response.status} 或非 JSON；请检查端口和 SSH 隧道。`,
            };
        }
        if (!response.body) return { ok: false, origin, reason: '状态接口没有响应体。' };
        const reader = response.body.getReader();
        const chunks: Uint8Array[] = [];
        let length = 0;
        try {
            for (;;) {
                const { done, value } = await reader.read();
                if (done) break;
                length += value.byteLength;
                if (length > MAX_STATUS_BYTES) {
                    await reader.cancel();
                    return { ok: false, origin, reason: '状态响应异常过大，拒绝继续联机测试。' };
                }
                chunks.push(value);
            }
        } finally {
            reader.releaseLock();
        }
        const body: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (
            !body ||
            typeof body !== 'object' ||
            !('success' in body) ||
            body.success !== true ||
            !('data' in body) ||
            !body.data ||
            typeof body.data !== 'object' ||
            !('version' in body.data) ||
            typeof body.data.version !== 'string' ||
            !body.data.version
        ) {
            return { ok: false, origin, reason: '响应不符合 new-api 状态接口结构。' };
        }
        return { ok: true, origin, reason: '状态接口检查通过；接下来仍须通过模型列表鉴权测试。' };
    } catch {
        return { ok: false, origin, reason: '状态请求失败、超时或 JSON 无效；请检查真实 new-api 地址。' };
    }
}

if (basename(process.argv[1] ?? '') === 'check-newapi-smoke-target.ts') {
    void checkNewapiSmokeTarget(process.env.NEWAPI_BASE_URL || 'http://localhost:3000').then((result) => {
        console.log(`[new-api preflight] ${result.origin ?? ''} ${result.reason}`);
        process.exitCode = result.ok ? 0 : 1;
    });
}
