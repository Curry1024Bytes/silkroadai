import { NextRequest } from 'next/server';
import { handlePaymentNotify } from '@/lib/order/service';
import { ensureDBProviders, paymentRegistry } from '@/lib/payment';
import type { PaymentType, PaymentProvider } from '@/lib/payment';
import { EasyPayProvider } from '@/lib/easy-pay/provider';
import { getInstanceConfig } from '@/lib/payment/load-balancer';
import { extractHeaders } from '@/lib/utils/api';

/**
 * EasyPay async notification webhook (HTTP GET). Verifies signature, then
 * hands the validated PaymentNotification to confirmPayment → executeRecharge
 * (W4-1 D1).
 *
 * Sig-fail policy (W4-1 D3, Sweep 2):
 *   - Provider throws on bad sig with the exact message
 *     "EasyPay notification signature verification failed".
 *   - We MUST return 'success' on sig fail — easy-pay retries on body 'fail'
 *     (it does not look at status codes), so returning 'fail' to attacker
 *     spam would create an indefinite retry storm against our origin.
 *   - But silent ignore was the W1 default and produced no ops signal. Now
 *     we console.warn with safe metadata (out_trade_no, pid, sig prefix —
 *     no raw body, no full sig). W6 will pipe this to Sentry / alert.
 */
export async function GET(request: NextRequest) {
  try {
    const instId = request.nextUrl.searchParams.get('inst');

    let provider: PaymentProvider;
    if (instId) {
      // 多实例模式：根据实例 ID 获取配置
      const config = await getInstanceConfig(instId);
      if (!config) {
        return new Response('Invalid instance', { status: 400, headers: { 'Content-Type': 'text/plain' } });
      }
      provider = new EasyPayProvider(instId, config);
    } else {
      // 回退到环境变量单实例模式
      await ensureDBProviders();
      provider = paymentRegistry.getProvider('alipay' as PaymentType);
    }

    const rawBody = request.nextUrl.searchParams.toString();
    const headers = extractHeaders(request);

    let notification;
    try {
      notification = await provider.verifyNotification(rawBody, headers);
    } catch (verifyErr) {
      // Sig fail — W4-1 D3 Sweep 2. Surface a warning with the small
      // pieces we can safely log (out_trade_no for traceability, no raw sig
      // / body), then return 'success' so easy-pay stops retrying.
      const msg = verifyErr instanceof Error ? verifyErr.message : String(verifyErr);
      if (msg.includes('signature verification failed')) {
        const sp = request.nextUrl.searchParams;
        const sigStr = sp.get('sign') || '';
        console.warn(
          '[easy-pay/notify] signature verification failed',
          {
            instId: instId ?? null,
            out_trade_no: sp.get('out_trade_no') || null,
            pid: sp.get('pid') || null,
            // Truncated prefix so logs aren't useful for replay; full sig
            // would let an operator forge later if log access leaks.
            signPrefix: sigStr ? `${sigStr.slice(0, 6)}...` : null,
          },
        );
        return new Response('success', { headers: { 'Content-Type': 'text/plain' } });
      }
      // Any other verifyNotification error (e.g. pid mismatch, malformed
      // amount) — re-throw to outer catch which logs and returns 'fail'.
      throw verifyErr;
    }
    if (!notification) {
      return new Response('success', { headers: { 'Content-Type': 'text/plain' } });
    }
    const success = await handlePaymentNotify(notification, provider.name);
    return new Response(success ? 'success' : 'fail', {
      headers: { 'Content-Type': 'text/plain' },
    });
  } catch (error) {
    console.error('EasyPay notify error:', error);
    return new Response('fail', {
      headers: { 'Content-Type': 'text/plain' },
    });
  }
}
