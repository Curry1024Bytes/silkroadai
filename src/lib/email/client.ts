import nodemailer from 'nodemailer';
import type { Transporter } from 'nodemailer';

let _transporter: Transporter | null = null;

/**
 * Lazily create + cache a nodemailer transporter from SMTP_* env vars.
 * Tencent enterprise mail: SMTP_HOST=smtp.exmail.qq.com, port 465 SSL
 * (port 587 would be STARTTLS — `secure` follows the port heuristic).
 *
 * Throws on first call if any of HOST / USER / PASS is missing, so a misconfig
 * fails loudly at the first email send instead of silently dropping mail.
 */
export function getMailer(): Transporter {
    if (_transporter) return _transporter;
    const host = process.env.SMTP_HOST;
    const port = parseInt(process.env.SMTP_PORT || '465', 10);
    const user = process.env.SMTP_USER;
    const pass = process.env.SMTP_PASS;
    if (!host || !user || !pass) {
        throw new Error('SMTP_HOST / SMTP_USER / SMTP_PASS not configured');
    }
    _transporter = nodemailer.createTransport({
        host,
        port,
        secure: port === 465,
        auth: { user, pass },
    });
    return _transporter;
}

/** Test-only: drop the cached transporter so the next getMailer() rebuilds. */
export function _resetMailerForTests(): void {
    _transporter = null;
}
