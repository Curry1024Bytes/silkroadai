import * as Sentry from '@sentry/nextjs';
import { getMailer } from './client';
import { passwordResetTemplate, emailVerificationTemplate, balanceAlertTemplate, type EmailContent } from './templates';

export interface SendResult {
    messageId: string;
    accepted: (string | { address: string })[];
    rejected: (string | { address: string })[];
}

/**
 * Append the to-address + URL to a debug log file when EMAIL_DEBUG_LOG is
 * set. Used by e2e scripts to extract the raw token (which is otherwise only
 * stored sha256-hashed in DB). Failure to write the debug log is logged but
 * doesn't affect the outer call. The branch is hard-gated by the env var, so
 * prod (where it's never set) pays no cost beyond a single `if`.
 */
async function appendDebugLog(toAddress: string, url: string): Promise<void> {
    const path = process.env.EMAIL_DEBUG_LOG;
    if (!path) return;
    try {
        const fs = await import('node:fs/promises');
        await fs.appendFile(path, `${new Date().toISOString()}\t${toAddress}\t${url}\n`, 'utf-8');
    } catch (e) {
        console.warn('[email] EMAIL_DEBUG_LOG write failed:', e);
    }
}

/**
 * Internal helper — render template, send via SMTP, append debug log even on
 * SMTP failure (so e2e can extract the token without a working mail server),
 * then re-throw the SMTP error. Returns null only when SMTP succeeded but the
 * upstream lib returned no info (defensive).
 */
async function sendTemplated(opts: {
    to: string;
    debugUrl: string; // url to append to debug log (raw token visible here)
    content: EmailContent;
}): Promise<SendResult | null> {
    const from = process.env.SMTP_FROM || process.env.SMTP_USER!;
    let info: Awaited<ReturnType<ReturnType<typeof getMailer>['sendMail']>> | null = null;
    let sendErr: unknown = null;

    try {
        info = await getMailer().sendMail({
            from: `"Silk Road AI" <${from}>`,
            to: opts.to,
            subject: opts.content.subject,
            text: opts.content.text,
            html: opts.content.html,
        });
    } catch (e) {
        sendErr = e;
        // W5 D4: ship to Sentry so SMTP outages get an alert. No-op when
        // SENTRY_DSN unset. We DON'T tag the recipient address (PII) —
        // just the area + the underlying error message.
        Sentry.captureException(e, { tags: { area: 'email-send' } });
    }

    await appendDebugLog(opts.to, opts.debugUrl);

    if (sendErr) throw sendErr;
    if (!info) return null;
    return {
        messageId: info.messageId,
        accepted: info.accepted as SendResult['accepted'],
        rejected: info.rejected as SendResult['rejected'],
    };
}

export async function sendPasswordResetEmail(opts: {
    to: string;
    resetUrl: string;
    expiresInMinutes: number;
}): Promise<SendResult | null> {
    return sendTemplated({
        to: opts.to,
        debugUrl: opts.resetUrl,
        content: passwordResetTemplate(opts.resetUrl, opts.expiresInMinutes),
    });
}

export async function sendVerificationEmail(opts: {
    to: string;
    verifyUrl: string;
    expiresInHours: number;
}): Promise<SendResult | null> {
    return sendTemplated({
        to: opts.to,
        debugUrl: opts.verifyUrl,
        content: emailVerificationTemplate(opts.verifyUrl, opts.expiresInHours),
    });
}

/**
 * W6 D2 — balance-low retention alert.
 *
 * Sent by BalanceAlertScheduler when a user's quota falls at-or-below their
 * configured threshold. SMTP failures are still captured to Sentry via the
 * shared `sendTemplated` helper. There's no security-sensitive token in the
 * URLs here; the EMAIL_DEBUG_LOG entry is informational only (lets ops grep
 * which alerts went out without standing up an SMTP catch).
 */
export async function sendBalanceAlertEmail(opts: {
    to: string;
    remainCny: number;
    thresholdCny: number;
    topupUrl: string;
    settingsUrl: string;
}): Promise<SendResult | null> {
    return sendTemplated({
        to: opts.to,
        debugUrl: opts.topupUrl,
        content: balanceAlertTemplate({
            remainCny: opts.remainCny,
            thresholdCny: opts.thresholdCny,
            topupUrl: opts.topupUrl,
            settingsUrl: opts.settingsUrl,
        }),
    });
}
