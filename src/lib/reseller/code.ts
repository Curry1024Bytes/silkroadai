/**
 * Reseller invite code validation + normalization (PR-U1).
 *
 * Code format (3-20 chars):
 *   - uppercase letters A-Z
 *   - digits 0-9
 *   - hyphen '-'
 *   - examples: "FRANK-WX-2026", "ALPHA1", "TEST-001"
 *
 * Codes are stored uppercase-normalized — both at create-time (POST
 * /reseller/codes) and at register-time lookup (try the typed-in code
 * as-uppercase against the unique index).
 *
 * Code-collision rule (operator calibration to brief design choice #3):
 *   When a reseller tries to create a new code, reject if that exact
 *   code (case-insensitively) is already in the env-driven W7 D4
 *   INVITE_CODES allow-list. This prevents the polymorphic resolver in
 *   register handler from being ambiguous — env codes take a different
 *   path (+30% first-recharge bonus, no attribution) and we don't want
 *   the same string to potentially route both ways.
 */
import { getValidInviteCodes } from '@/lib/invite/code';

export const MIN_CODE_LENGTH = 3;
export const MAX_CODE_LENGTH = 20;
const CODE_REGEX = /^[A-Z0-9-]+$/;

/** Max active codes per reseller. Soft-deleted (is_active=false) codes
 *  don't count — operator-decided in brief (cap = 10). */
export const MAX_CODES_PER_RESELLER = 10;

export interface CodeValidationResult {
    ok: boolean;
    code?: string; // normalized (uppercased) version if ok=true
    error?: 'format' | 'length' | 'env_collision';
    message?: string;
}

/**
 * Validate + normalize a candidate reseller code BEFORE writing to DB.
 *
 * Checks (in order):
 *   1. length (3-20 after trim)
 *   2. character set (uppercased input must match /[A-Z0-9-]+/)
 *   3. env-collision: code must not appear in INVITE_CODES env (case-insensitive)
 *
 * Returns `{ ok: true, code: normalized }` on success.
 * Returns `{ ok: false, error, message }` on any failure — `message` is
 * a Chinese-friendly explanation for the API response.
 *
 * Uniqueness against the `reseller_invite_codes` table is NOT checked
 * here — that's the DB's job (column has @unique). The endpoint catches
 * Prisma P2002 to surface "码已被占用" to the user.
 */
export function validateAndNormalizeCode(raw: string): CodeValidationResult {
    if (typeof raw !== 'string') {
        return { ok: false, error: 'format', message: '邀请码格式无效' };
    }
    const trimmed = raw.trim();
    if (trimmed.length < MIN_CODE_LENGTH || trimmed.length > MAX_CODE_LENGTH) {
        return {
            ok: false,
            error: 'length',
            message: `邀请码长度需 ${MIN_CODE_LENGTH}-${MAX_CODE_LENGTH} 字符`,
        };
    }
    const normalized = trimmed.toUpperCase();
    if (!CODE_REGEX.test(normalized)) {
        return {
            ok: false,
            error: 'format',
            message: '邀请码只能包含大写字母、数字、中划线',
        };
    }
    // env-collision guard (Q3 calibration). Compare normalized-lowercase
    // against the env Set which lowercases entries.
    const envSet = getValidInviteCodes();
    if (envSet.has(normalized.toLowerCase())) {
        return {
            ok: false,
            error: 'env_collision',
            message: '该邀请码与系统保留码冲突,请换一个',
        };
    }
    return { ok: true, code: normalized };
}

/**
 * Normalize a user-typed code for lookup (uppercase + trim) without
 * running the env-collision check. Used by register handler to look up
 * a reseller code from the input; if not found, register handler then
 * falls back to the env allow-list.
 */
export function normalizeForLookup(raw: string | null | undefined): string | null {
    if (!raw || typeof raw !== 'string') return null;
    const trimmed = raw.trim();
    if (trimmed.length === 0) return null;
    return trimmed.toUpperCase();
}
