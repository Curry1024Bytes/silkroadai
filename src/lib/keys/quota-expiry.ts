/**
 * API Key 额度上限 / 到期时间 —— 纯函数,server route 与 /keys 客户端岛共用。
 *
 * 语义(2026-10-22):
 *   - 额度上限 = 这把 key 一共还能花多少(¥),是账户余额之下的第二道闸,
 *     充值不会自动补它;`null` = 无限(new-api `unlimited_quota=true`)。
 *   - 到期时间 = 绝对时间点;`null` = 永不(new-api `expired_time=-1`)。
 *   - 这里【不做】¥↔quota 换算(client island 禁止读 quota-units env),换算只在 server route。
 */

export const EXPIRY_PRESETS = ['never', '1h', '1d', '1m', 'custom'] as const;
export type ExpiryPreset = (typeof EXPIRY_PRESETS)[number];

export const EXPIRY_PRESET_LABELS: Record<ExpiryPreset, string> = {
    never: '永不',
    '1h': '1 小时',
    '1d': '1 天',
    '1m': '1 个月',
    custom: '自定义',
};

/** 额度上限上限值(¥),防手滑多打零。 */
export const MAX_QUOTA_CNY = 1_000_000;

export interface QuotaExpiryInput {
    quotaUnlimited: boolean;
    /** 原始输入串,如 "100" / "99.5"。 */
    quotaCny: string;
    expiryPreset: ExpiryPreset;
    /** `datetime-local` 的值,如 "2026-11-01T12:00"(浏览器本地时区)。 */
    expiryCustom: string;
}

export type QuotaExpiryPayload =
    { ok: true; quotaCny: number | null; expiresAt: string | null } | { ok: false; error: string };

export function presetToExpiresAt(preset: ExpiryPreset, custom: string, now: Date = new Date()): string | null {
    switch (preset) {
        case 'never':
            return null;
        case '1h':
            return new Date(now.getTime() + 60 * 60 * 1000).toISOString();
        case '1d':
            return new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString();
        case '1m': {
            const d = new Date(now.getTime());
            d.setMonth(d.getMonth() + 1);
            return d.toISOString();
        }
        case 'custom': {
            const ms = Date.parse(custom);
            return Number.isNaN(ms) ? null : new Date(ms).toISOString();
        }
    }
}

/** 解析额度输入:正数、≤ MAX、最多两位小数。返回 null 表示非法。 */
export function parseQuotaCny(raw: string): number | null {
    const s = raw.trim();
    if (!/^\d+(\.\d{1,2})?$/.test(s)) return null;
    const n = Number(s);
    if (!Number.isFinite(n) || n <= 0 || n > MAX_QUOTA_CNY) return null;
    return Math.round(n * 100) / 100;
}

export function buildQuotaExpiryPayload(input: QuotaExpiryInput, now: Date = new Date()): QuotaExpiryPayload {
    let quotaCny: number | null = null;
    if (!input.quotaUnlimited) {
        quotaCny = parseQuotaCny(input.quotaCny);
        if (quotaCny === null) {
            return {
                ok: false,
                error: `额度上限请填 0.01 ~ ${MAX_QUOTA_CNY.toLocaleString('en-US')} 之间的金额(最多两位小数)`,
            };
        }
    }
    let expiresAt: string | null = null;
    if (input.expiryPreset === 'custom') {
        if (!input.expiryCustom.trim()) return { ok: false, error: '请选择到期时间' };
        expiresAt = presetToExpiresAt('custom', input.expiryCustom, now);
        if (expiresAt === null) return { ok: false, error: '到期时间格式不正确' };
        if (Date.parse(expiresAt) <= now.getTime()) return { ok: false, error: '到期时间必须晚于现在' };
    } else {
        expiresAt = presetToExpiresAt(input.expiryPreset, '', now);
    }
    return { ok: true, quotaCny, expiresAt };
}

export function isExpired(expiresAt: string | null, now: Date = new Date()): boolean {
    if (!expiresAt) return false;
    const ms = Date.parse(expiresAt);
    return !Number.isNaN(ms) && ms <= now.getTime();
}

/** 到期时间展示;全站统一北京时间(gotcha #20)。 */
export function formatExpiry(expiresAt: string | null): string {
    if (!expiresAt) return '永不过期';
    return new Date(expiresAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
}

/** ISO → `datetime-local` 输入框需要的本地时间串(yyyy-MM-ddTHH:mm)。 */
export function toDatetimeLocalValue(iso: string | null, now: Date = new Date()): string {
    const d = iso ? new Date(iso) : new Date(now.getTime() + 24 * 60 * 60 * 1000);
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Shared API/UI copy: changing settings does not reactivate an inactive Key. */
export const KEY_INACTIVE_MESSAGE = '此 Key 仍不可用，请联系管理员恢复或创建新 Key。';
