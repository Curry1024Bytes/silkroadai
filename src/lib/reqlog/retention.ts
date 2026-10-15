/** 客户请求日志的保留期。新日志默认 7 天；已有 null 到期时间的历史行保持原策略。 */
const DEFAULT_RETENTION_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;

export function requestLogRetentionDays(): number {
    const days = Number(process.env.REQUEST_LOGGING_RETENTION_DAYS);
    return Number.isSafeInteger(days) && days >= 1 && days <= 3650 ? days : DEFAULT_RETENTION_DAYS;
}

export function requestLogExpiresAt(createdAt: Date): Date {
    return new Date(createdAt.getTime() + requestLogRetentionDays() * DAY_MS);
}

export function isRequestLogExpired(expiresAt: Date | null | undefined, now: Date = new Date()): boolean {
    return expiresAt != null && expiresAt.getTime() <= now.getTime();
}
