/** All copy is rendered server-side. resetUrl arrives pre-built; we don't
 *  manipulate the URL here — the route handler is responsible for path +
 *  querystring shape. */
export interface EmailContent {
    subject: string;
    text: string;
    html: string;
}

export function passwordResetTemplate(
    resetUrl: string,
    expiresInMinutes: number,
): EmailContent {
    const subject = '[Silk Road AI] 重置密码';

    const text = `
您收到此邮件是因为有人(可能是您本人)请求重置 Silk Road AI 账户密码。

重置链接(${expiresInMinutes} 分钟内有效):
${resetUrl}

如果不是您本人操作,请忽略本邮件,您的密码不会被改动。

— Silk Road AI
https://silkroadai.io
`.trim();

    const html = `
<!DOCTYPE html>
<html><body style="font-family: -apple-system, 'Helvetica Neue', Arial, sans-serif; max-width: 560px; margin: 0 auto; padding: 24px; color: #1a2540;">
  <div style="background: #0a1535; color: #fff; padding: 16px 20px; border-radius: 6px;">
    <h1 style="margin: 0; font-size: 18px;">Silk Road AI</h1>
    <p style="margin: 4px 0 0; font-size: 12px; opacity: 0.7;">Connecting Global Intelligence.</p>
  </div>
  <div style="padding: 20px 4px;">
    <h2 style="font-size: 16px; margin: 0 0 12px;">重置密码</h2>
    <p style="line-height: 1.6;">您收到此邮件是因为有人(可能是您本人)请求重置 Silk Road AI 账户密码。</p>
    <p style="margin: 24px 0;">
      <a href="${resetUrl}" style="background: #0a1535; color: #fff; padding: 12px 24px; text-decoration: none; border-radius: 4px; display: inline-block;">点击重置密码</a>
    </p>
    <p style="font-size: 13px; color: #5a6478;">链接 ${expiresInMinutes} 分钟内有效。如果不是您本人操作,请忽略本邮件 — 您的密码不会被改动。</p>
    <p style="font-size: 13px; color: #5a6478; margin-top: 24px;">如果按钮无法点击,复制以下链接到浏览器打开:<br><span style="word-break: break-all;">${resetUrl}</span></p>
  </div>
  <hr style="border: none; border-top: 1px solid #e5e8ee; margin: 16px 0;">
  <p style="font-size: 12px; color: #8a92a4; text-align: center;">— Silk Road AI · <a href="https://silkroadai.io" style="color: #5a6478;">silkroadai.io</a></p>
</body></html>
`.trim();

    return { subject, text, html };
}
