/**
 * API Key 额度上限 / 到期时间 —— 纯函数,server route 与 /keys 客户端岛共用。
 *
 * 语义(2026-10-22):
 *   - 额度上限 = 这把 key 一共还能花多少(¥),是账户余额之下的第二道闸,
 *     充值不会自动补它;`null` = 无限(new-api `unlimited_quota=true`)。
 *   - 到期时间 = 绝对时间点;`null` = 永不(new-api `expired_time=-1`)。
 *   - 这里【不做】¥↔quota 换算(client island 禁止读 quota-units env),换算只在 server route。
 *   - 用户可见文案(预设标签 / 校验错误 / 「永不过期」)来自 `messages/keys.ts`,按 `locale` 取;
 *     省略 locale = 中文(与历史行为一致)。
 */
import { intlLocale, pickMessages, type Locale } from '@/lib/i18n';
import { keysMessages } from '@/lib/i18n/messages/keys';

export const EXPIRY_PRESETS = ['never', '1h', '1d', '1m', 'custom'] as const;
export type ExpiryPreset = (typeof EXPIRY_PRESETS)[number];

/** Chinese preset labels (legacy alias). Prefer `expiryPresetLabels(locale)`. */
export const EXPIRY_PRESET_LABELS: Record<ExpiryPreset, string> = keysMessages.zh.quotaExpiry.presets;

export function expiryPresetLabels(locale: Locale = 'zh'): Record<ExpiryPreset, string> {
    return pickMessages(keysMessages, locale).quotaExpiry.presets;
}

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
    | { ok: true; quotaCny: number | null; expiresAt: string | null }
    | { ok: false; error: string };

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

export function buildQuotaExpiryPayload(
    input: QuotaExpiryInput,
    now: Date = new Date(),
    locale: Locale = 'zh',
): QuotaExpiryPayload {
    const errors = pickMessages(keysMessages, locale).quotaExpiry.errors;
    let quotaCny: number | null = null;
    if (!input.quotaUnlimited) {
        quotaCny = parseQuotaCny(input.quotaCny);
        if (quotaCny === null) {
            return { ok: false, error: errors.invalidQuota(MAX_QUOTA_CNY.toLocaleString('en-US')) };
        }
    }
    let expiresAt: string | null = null;
    if (input.expiryPreset === 'custom') {
        if (!input.expiryCustom.trim()) return { ok: false, error: errors.pickExpiry };
        expiresAt = presetToExpiresAt('custom', input.expiryCustom, now);
        if (expiresAt === null) return { ok: false, error: errors.badExpiryFormat };
        if (Date.parse(expiresAt) <= now.getTime()) return { ok: false, error: errors.expiryMustBeFuture };
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

/** 到期时间展示;全站统一北京时间(gotcha #20),数字格式随 locale。 */
export function formatExpiry(expiresAt: string | null, locale: Locale = 'zh'): string {
    if (!expiresAt) return pickMessages(keysMessages, locale).quotaExpiry.neverExpires;
    return new Date(expiresAt).toLocaleString(intlLocale(locale), { timeZone: 'Asia/Shanghai', hour12: false });
}

/** ISO → `datetime-local` 输入框需要的本地时间串(yyyy-MM-ddTHH:mm)。 */
export function toDatetimeLocalValue(iso: string | null, now: Date = new Date()): string {
    const d = iso ? new Date(iso) : new Date(now.getTime() + 24 * 60 * 60 * 1000);
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
