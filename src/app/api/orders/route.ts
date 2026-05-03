import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { createOrder } from '@/lib/order/service';
import { getEnv } from '@/lib/config';
import { getEnabledPaymentTypes } from '@/lib/payment/resolve-enabled-types';
import { getCurrentUser } from '@/lib/auth/session';
import { handleApiError } from '@/lib/utils/api';
import { getSystemConfigs } from '@/lib/system-config';

// prisma + bcrypt are Node-native; pin runtime so Next doesn't try to put
// this on the Edge.
export const runtime = 'nodejs';

// W4-1 D2: dropped `token` field — auth comes from the silkroad_session
// cookie set during login / OAuth callback. Old W1 callers (Sub2API iframe)
// passed a litellm token here; that path is gone.
const createOrderSchema = z.object({
  amount: z.number().positive().max(99999999.99),
  payment_type: z.string().min(1),
  src_host: z.string().max(253).optional(),
  src_url: z
    .string()
    .max(2048)
    .refine((url) => {
      try {
        const protocol = new URL(url).protocol;
        return protocol === 'http:' || protocol === 'https:';
      } catch {
        return false;
      }
    }, 'src_url must be a valid HTTP/HTTPS URL')
    .optional(),
  is_mobile: z.boolean().optional(),
  order_type: z.enum(['balance', 'subscription']).optional(),
  plan_id: z.string().optional(),
});

export async function POST(request: NextRequest) {
  try {
    const env = getEnv();
    const body = await request.json();
    const parsed = createOrderSchema.safeParse(body);

    if (!parsed.success) {
      return NextResponse.json({ error: '参数错误', details: parsed.error.flatten().fieldErrors }, { status: 400 });
    }

    const { amount, payment_type, src_host, src_url, is_mobile, order_type, plan_id } = parsed.data;

    // Cookie-based session lookup (set by login / OAuth callback).
    const sessionUser = await getCurrentUser(request);
    if (!sessionUser) {
      return NextResponse.json({ error: '请先登录', code: 'AUTH_REQUIRED' }, { status: 401 });
    }
    const userId: string = sessionUser.id;

    // 订阅订单跳过金额范围校验（价格由服务端套餐决定）
    if (order_type !== 'subscription') {
      // 优先读 DB 配置（管理后台在线配置），回退到环境变量
      const amountConfigs = await getSystemConfigs(['RECHARGE_MIN_AMOUNT', 'RECHARGE_MAX_AMOUNT']);
      const effectiveMin = amountConfigs['RECHARGE_MIN_AMOUNT']
        ? parseFloat(amountConfigs['RECHARGE_MIN_AMOUNT']) || env.MIN_RECHARGE_AMOUNT
        : env.MIN_RECHARGE_AMOUNT;
      const effectiveMax = amountConfigs['RECHARGE_MAX_AMOUNT']
        ? parseFloat(amountConfigs['RECHARGE_MAX_AMOUNT']) || env.MAX_RECHARGE_AMOUNT
        : env.MAX_RECHARGE_AMOUNT;
      if (amount < effectiveMin || amount > effectiveMax) {
        return NextResponse.json({ error: `充值金额需在 ${effectiveMin} - ${effectiveMax} 之间` }, { status: 400 });
      }
    }

    // Validate payment type is enabled (registry + ENABLED_PAYMENT_TYPES config)
    const enabledTypes = await getEnabledPaymentTypes();
    if (!enabledTypes.includes(payment_type)) {
      return NextResponse.json({ error: `不支持的支付方式: ${payment_type}` }, { status: 400 });
    }

    const clientIp =
      request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || request.headers.get('x-real-ip') || '127.0.0.1';

    const result = await createOrder({
      user_id: userId,
      amount,
      paymentType: payment_type,
      clientIp,
      isMobile: is_mobile,
      srcHost: src_host,
      srcUrl: src_url,
      orderType: order_type,
      planId: plan_id,
    });

    // 不向客户端暴露 userName / userBalance 等隐私字段
    const { userName: _u, userBalance: _b, ...safeResult } = result;
    return NextResponse.json(safeResult);
  } catch (error) {
    return handleApiError(error, '创建订单失败，请稍后重试');
  }
}
