import { getMailer } from './client';
import { passwordResetTemplate } from './templates';

export interface SendResult {
    messageId: string;
    accepted: (string | { address: string })[];
    rejected: (string | { address: string })[];
}

/**
 * Append the to-address + resetUrl to a debug log file when
 * EMAIL_DEBUG_LOG is set. Used by e2e scripts to extract the raw token
 * (which is otherwise only stored sha256-hashed in DB). Failure to write
 * the debug log is logged but doesn't affect the outer call. The branch
 * is hard-gated by the env var, so prod (where it's never set) pays no
 * cost beyond a single `if`.
 */
async function appendDebugLog(toAddress: string, resetUrl: string): Promise<void> {
    const path = process.env.EMAIL_DEBUG_LOG;
    if (!path) return;
    try {
        const fs = await import('node:fs/promises');
        await fs.appendFile(
            path,
            `${new Date().toISOString()}\t${toAddress}\t${resetUrl}\n`,
            'utf-8',
        );
    } catch (e) {
        console.warn('[email] EMAIL_DEBUG_LOG write failed:', e);
    }
}

export async function sendPasswordResetEmail(opts: {
    to: string;
    resetUrl: string;
    expiresInMinutes: number;
}): Promise<SendResult | null> {
    const { subject, text, html } = passwordResetTemplate(opts.resetUrl, opts.expiresInMinutes);
    const from = process.env.SMTP_FROM || process.env.SMTP_USER!;

    let info: Awaited<ReturnType<ReturnType<typeof getMailer>['sendMail']>> | null = null;
    let sendErr: unknown = null;

    try {
        info = await getMailer().sendMail({
            from: `"Silk Road AI" <${from}>`,
            to: opts.to,
            subject,
            text,
            html,
        });
    } catch (e) {
        sendErr = e;
    }

    // Always append debug log even on send failure — e2e scripts need the
    // resetUrl to extract the token, which is otherwise unrecoverable
    // (DB stores sha256(token), not the raw value).
    await appendDebugLog(opts.to, opts.resetUrl);

    if (sendErr) throw sendErr;
    if (!info) return null;
    return {
        messageId: info.messageId,
        accepted: info.accepted as SendResult['accepted'],
        rejected: info.rejected as SendResult['rejected'],
    };
}
