/**
 * Transactional-email templates (W7 D4 polish).
 *
 * Visual contract
 * ---------------
 * Brand-aligned shell matching the W7 P1 design system:
 *   - Paper-muted (#F3EDE1) header strip with navy wordmark + tagline
 *   - Paper (#FAF7F2) body card
 *   - Navy (#1A2540) headline + ink (#1A2540) body copy
 *   - Brand-accent gold (#C9A961) hairline accents (CTA underline,
 *     header border-bottom)
 *   - Filled navy CTA button (paper-foreground text)
 *   - Footer: contact pair + legal links + tagline + © year
 *
 * Hex values are inlined verbatim because email clients (notably
 * Outlook desktop) don't honor CSS custom properties. The values mirror
 * the @theme block in `src/app/globals.css`; if the brand palette shifts
 * the hex literals here have to move with it.
 *
 * Hard constraint per W7 D4 brief: don't change content / send timing /
 * recipient lists. Only the visual shell changes. The subject lines,
 * text-body content, and template-variable contracts are unchanged from
 * the W3 D4 / W3 D5 / W6 D2 versions.
 */
export interface EmailContent {
    subject: string;
    text: string;
    html: string;
}

/* ─────────────────────────────────────────────────────────────────── */
/* Shared shell — every template wraps body content in the same chrome */
/* so customers recognize all three as one mail family.                */
/* ─────────────────────────────────────────────────────────────────── */

interface ShellOpts {
    /** Heading shown immediately under the brand bar (e.g. "邮箱验证"). */
    heading: string;
    /** Inner HTML — paragraphs / CTA button / hints. The shell handles
     *  the surrounding card padding + brand chrome. */
    bodyHtml: string;
}

function brandShell({ heading, bodyHtml }: ShellOpts): string {
    const year = new Date().getFullYear();
    // Note on style strategy: every block uses inline `style=` because
    // most webmail clients (notably Gmail) strip <style> blocks before
    // delivery. Keeping the structure simple + table-free so it renders
    // identically across modern clients (Gmail, Apple Mail, Outlook 365).
    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Silk Road AI</title>
</head>
<body style="margin:0;padding:0;background:#faf7f2;font-family:-apple-system,'Helvetica Neue',Inter,Arial,'PingFang SC','Hiragino Sans GB',sans-serif;color:#1a2540;line-height:1.7;">
  <div style="max-width:560px;margin:0 auto;padding:24px 16px;">
    <!-- Header strip -->
    <div style="background:#f3ede1;border:1px solid #efe8dd;border-bottom-width:2px;border-bottom-color:#c9a961;border-radius:8px 8px 0 0;padding:18px 24px;">
      <h1 style="margin:0;font-size:18px;font-weight:700;letter-spacing:-0.2px;color:#1a2540;">Silk Road AI</h1>
      <p style="margin:4px 0 0;font-size:12px;color:#6b7689;">Connecting Global Intelligence.</p>
    </div>

    <!-- Body card -->
    <div style="background:#ffffff;border:1px solid #efe8dd;border-top:none;padding:28px 24px 24px;">
      <h2 style="margin:0 0 14px;font-size:18px;font-weight:600;color:#1a2540;">${heading}</h2>
      ${bodyHtml}
    </div>

    <!-- Footer -->
    <div style="background:#f3ede1;border:1px solid #efe8dd;border-top:none;border-radius:0 0 8px 8px;padding:16px 24px;font-size:12px;color:#3a4660;">
      <p style="margin:0 0 6px;">客服:微信 <code style="font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px;background:#ffffff;padding:1px 6px;border:1px solid #efe8dd;border-radius:3px;color:#1a2540;">Global_Ads</code> · 邮箱 <a href="mailto:support@silkroadai.io" style="color:#1a2540;text-decoration:none;border-bottom:1px dotted #1a2540;">support@silkroadai.io</a></p>
      <p style="margin:0 0 6px;"><a href="https://silkroadai.io/terms" style="color:#3a4660;text-decoration:none;">服务条款</a> · <a href="https://silkroadai.io/privacy" style="color:#3a4660;text-decoration:none;">隐私政策</a> · <a href="https://silkroadai.io/refund" style="color:#3a4660;text-decoration:none;">退款政策</a></p>
      <p style="margin:0;color:#6b7689;">© ${year} Silk Road AI · <a href="https://silkroadai.io" style="color:#6b7689;text-decoration:none;">silkroadai.io</a></p>
    </div>
  </div>
</body>
</html>`;
}

/** CTA button — filled navy with paper text. Works inline in every
 *  modern client; fallback for image-blocking is the visible text label. */
function ctaButton(href: string, label: string): string {
    return `<p style="margin:24px 0;">
      <a href="${href}" style="display:inline-block;background:#1a2540;color:#faf7f2;padding:12px 26px;text-decoration:none;border-radius:8px;font-weight:600;font-size:15px;border:1px solid #1a2540;">${label}</a>
    </p>`;
}

/** "If the button doesn't work, copy this URL" affordance — required by
 *  email accessibility guidelines + works for clients that strip the
 *  button styling. */
function fallbackUrlBlock(url: string): string {
    return `<p style="margin:18px 0 0;font-size:12px;color:#6b7689;">如果按钮无法点击,复制以下链接到浏览器打开:<br>
      <span style="word-break:break-all;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;color:#3a4660;">${url}</span>
    </p>`;
}

/* ─────────────────────────────────────────────────────────────────── */
/* verify-email (W3 D5)                                                */
/* ─────────────────────────────────────────────────────────────────── */

export function emailVerificationTemplate(verifyUrl: string, expiresInHours: number): EmailContent {
    const subject = '[Silk Road AI] 邮箱验证';

    // text body kept verbatim from the W3 D5 release — plain-text mail
    // readers should see exactly the same content they did before.
    const text = `
欢迎使用 Silk Road AI!

请点击以下链接完成邮箱验证(${expiresInHours} 小时内有效):
${verifyUrl}

如果不是您本人注册,请忽略本邮件。

— Silk Road AI
https://silkroadai.io
`.trim();

    const bodyHtml = `
      <p style="margin:0 0 12px;font-size:14.5px;color:#1a2540;">欢迎使用 Silk Road AI!请点击下方按钮完成邮箱验证。</p>
      ${ctaButton(verifyUrl, '验证邮箱')}
      <p style="margin:0;font-size:13px;color:#3a4660;">链接 ${expiresInHours} 小时内有效。如果不是您本人注册,请忽略本邮件。</p>
      ${fallbackUrlBlock(verifyUrl)}
    `;

    return { subject, text, html: brandShell({ heading: '邮箱验证', bodyHtml }) };
}

/* ─────────────────────────────────────────────────────────────────── */
/* balance-alert (W6 D2)                                               */
/* ─────────────────────────────────────────────────────────────────── */

export function balanceAlertTemplate(opts: {
    remainCny: number;
    thresholdCny: number;
    topupUrl: string;
    settingsUrl: string;
}): EmailContent {
    const remainStr = opts.remainCny.toFixed(2);
    const thresholdStr = opts.thresholdCny.toFixed(2);
    const subject = `[Silk Road AI] 余额提醒:仅剩 ¥${remainStr}`;

    const text = `
您的 Silk Road AI 余额已低于您设定的提醒阈值 ¥${thresholdStr}。

当前余额约 ¥${remainStr}。为避免 API 调用中断,建议尽快充值。

立即充值:${opts.topupUrl}

如需修改提醒阈值或关闭余额提醒,请前往后台:
${opts.settingsUrl}

— Silk Road AI
https://silkroadai.io
`.trim();

    const bodyHtml = `
      <p style="margin:0 0 12px;font-size:14.5px;color:#1a2540;">您的 Silk Road AI 余额已低于您设定的提醒阈值 <strong style="color:#1a2540;">¥${thresholdStr}</strong>。</p>
      <p style="margin:0 0 12px;font-size:14.5px;color:#1a2540;">当前余额约 <strong style="font-variant-numeric:tabular-nums;color:#1a2540;">¥${remainStr}</strong>。为避免 API 调用中断,建议尽快充值。</p>
      ${ctaButton(opts.topupUrl, '立即充值')}
      <p style="margin:0;font-size:13px;color:#3a4660;">您可以在 portal 后台修改提醒阈值或关闭提醒。<a href="${opts.settingsUrl}" style="color:#1a2540;text-decoration:none;border-bottom:1px dotted #1a2540;">前往设置 →</a></p>
    `;

    return { subject, text, html: brandShell({ heading: '余额提醒', bodyHtml }) };
}

/* ─────────────────────────────────────────────────────────────────── */
/* password-reset (W3 D4)                                              */
/* ─────────────────────────────────────────────────────────────────── */

export function passwordResetTemplate(resetUrl: string, expiresInMinutes: number): EmailContent {
    const subject = '[Silk Road AI] 重置密码';

    const text = `
您收到此邮件是因为有人(可能是您本人)请求重置 Silk Road AI 账户密码。

重置链接(${expiresInMinutes} 分钟内有效):
${resetUrl}

如果不是您本人操作,请忽略本邮件,您的密码不会被改动。

— Silk Road AI
https://silkroadai.io
`.trim();

    const bodyHtml = `
      <p style="margin:0 0 12px;font-size:14.5px;color:#1a2540;">您收到此邮件是因为有人(可能是您本人)请求重置 Silk Road AI 账户密码。</p>
      ${ctaButton(resetUrl, '点击重置密码')}
      <p style="margin:0;font-size:13px;color:#3a4660;">链接 ${expiresInMinutes} 分钟内有效。如果不是您本人操作,请忽略本邮件 — 您的密码不会被改动。</p>
      ${fallbackUrlBlock(resetUrl)}
    `;

    return { subject, text, html: brandShell({ heading: '重置密码', bodyHtml }) };
}
