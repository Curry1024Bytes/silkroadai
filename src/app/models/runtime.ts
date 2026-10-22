import 'server-only';
import { DEFAULT_PLAZA_RUNTIME, type PlazaRuntimeConfig } from '@newapi/lib/plaza-runtime';

const NEWAPI_BASE_URL = process.env.NEWAPI_BASE_URL || 'http://localhost:3000';
const PUBLIC_API_BASE = process.env.NEXT_PUBLIC_API_BASE_URL || 'https://ai.silkroadai.io';

let cached: { at: number; value: PlazaRuntimeConfig } | null = null;
const TTL_MS = 60_000;

/** 读 new-api 公开 `/api/status` 里的货币展示配置;失败回默认值(与线上一致)。 */
export async function loadPlazaRuntime(): Promise<PlazaRuntimeConfig> {
    const now = Date.now();
    if (cached && now - cached.at < TTL_MS) return cached.value;
    let value: PlazaRuntimeConfig = { ...DEFAULT_PLAZA_RUNTIME, server_address: PUBLIC_API_BASE };
    try {
        const res = await fetch(new URL('/api/status', NEWAPI_BASE_URL), {
            headers: { Accept: 'application/json' },
            signal: AbortSignal.timeout(5_000),
            cache: 'no-store',
        });
        const json = (await res.json()) as { success?: boolean; data?: Record<string, unknown> };
        const d = json?.data ?? {};
        const num = (k: string, fallback: number) => (typeof d[k] === 'number' ? (d[k] as number) : fallback);
        const str = (k: string, fallback: string) => (typeof d[k] === 'string' ? (d[k] as string) : fallback);
        const qdt = str('quota_display_type', value.quota_display_type);
        value = {
            ...value,
            price: num('price', value.price),
            usd_exchange_rate: num('usd_exchange_rate', num('price', value.usd_exchange_rate)),
            quota_per_unit: num('quota_per_unit', value.quota_per_unit),
            display_in_currency: typeof d.display_in_currency === 'boolean' ? d.display_in_currency : true,
            quota_display_type: (['USD', 'CNY', 'TOKENS', 'CUSTOM'] as const).includes(
                qdt as 'USD' | 'CNY' | 'TOKENS' | 'CUSTOM',
            )
                ? (qdt as PlazaRuntimeConfig['quota_display_type'])
                : value.quota_display_type,
            custom_currency_symbol: str('custom_currency_symbol', value.custom_currency_symbol),
            custom_currency_exchange_rate: num('custom_currency_exchange_rate', value.custom_currency_exchange_rate),
            system_name: 'Silk Road AI',
        };
        cached = { at: now, value };
    } catch (err) {
        console.warn('[models] /api/status unreachable, using defaults', String(err));
    }
    return value;
}
