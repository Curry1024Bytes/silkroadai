import { prisma } from '@/lib/db';
import { getEnv } from '@/lib/config';
import { ORDER_STATUS } from '@/lib/constants';
import { generateRechargeCode } from './code-gen';
import { getMethodDailyLimit } from './limits';
import { getMethodFeeRate, calculatePayAmount } from './fee';
import { ensureDBProviders, paymentRegistry } from '@/lib/payment';
import type { PaymentType, PaymentNotification } from '@/lib/payment';
import {
    getUser,
    createAndRedeem,
    subtractBalance,
    addBalance,
    getGroup,
    getUserSubscriptions,
    extendSubscription,
} from '@/lib/litellm/client';
// new-api 充值入账 (W4-1 D1) — 替换 createAndRedeem stub。
// 仅 executeRecharge 改造,createOrder/refund/subscription 仍走 litellm shim
// (R3 stub 路径,W4-1 D1 brief 范围外,见 docs/W4-1-D1*)。
import {
    applyTopup as newapiApplyTopup,
    getUser as newapiGetUser,
    cnyToQuota,
    quotaToCny,
    NewApiError,
} from '@/lib/newapi/client';
import { computeValidityDays, type ValidityUnit } from '@/lib/subscription-utils';
import { Prisma } from '@prisma/client';
import { deriveOrderState, isRefundStatus } from './status';
import { pickLocaleText, type Locale } from '@/lib/locale';
import { getBizDayStartUTC } from '@/lib/time/biz-day';
import { buildOrderResultUrl, createOrderStatusAccessToken } from '@/lib/order/status-access';
import { getSystemConfig, getSystemConfigs } from '@/lib/system-config';
import { selectInstance, getInstanceConfig, type LoadBalanceStrategy } from '@/lib/payment/load-balancer';
import { isValidInviteCode } from '@/lib/invite/code';
// PR-U1: reseller commission hook (called from inside executeRecharge tx
// after RechargeLog.create). Failure throws → tx rollback → recharge
// reverts (money-path consistency).
import { writeCommissionInTx, isAttributionActive } from '@/lib/reseller/commission';
// P4c-3: portal-mode 客户充值 → ¥账本(applyLedgerEntry)+ 开哑门(syncNewapiGate),不 add_quota。
// 两道门 billingSourceIsPortal() + user.billing_mode === 'portal';否则完全走旧 new-api 路径。
import { applyLedgerEntry } from '@/lib/billing/ledger';
import { syncNewapiGate } from '@/lib/billing/newapi-gate';
import { billingSourceIsPortal } from '@/lib/billing/billing-source';

const DEFAULT_MAX_PENDING_ORDERS = 3;
/** Decimal(10,2) 允许的最大金额 */
export const MAX_AMOUNT = 99999999.99;
/**
 * 首充 bonus 比率(W6 D1)。默认 20% 主 quota,一次性,仅 user 第一次充值发。
 * 改这个数对存量已充用户无影响 — 已 flip 的 first_recharge_bonus_granted=true
 * 永远不会重新走 bonus 路径。
 */
export const FIRST_RECHARGE_BONUS_RATE = 0.2;

/**
 * W7 D4: 邀请码 perk。注册时填入有效邀请码的 user 首充时获得 30% 而非 20% bonus。
 * 与 FIRST_RECHARGE_BONUS_RATE 解耦,不互斥(选择高的)。改这个数同样仅
 * 影响后续未发 bonus 的 user。
 *
 * 重要:bonus 发放时点 re-validate user.invite_code 是否仍在 INVITE_CODES env
 * 列表里。这给操作员一条「软撤销」路径 — 把码从 env 移除即可让该码持有者
 * 退回默认 20%,无需任何 DB migration。
 */
export const FIRST_RECHARGE_BONUS_RATE_INVITED = 0.3;

function message(locale: Locale, zh: string, en: string): string {
    return pickLocaleText(locale, zh, en);
}

export interface CreateOrderInput {
    user_id: string | null;
    amount: number;
    paymentType: PaymentType;
    clientIp: string;
    isMobile?: boolean;
    srcHost?: string;
    srcUrl?: string;
    locale?: Locale;
    // 订阅订单专用
    orderType?: 'balance' | 'subscription';
    planId?: string;
}

export interface CreateOrderResult {
    orderId: string;
    amount: number;
    payAmount: number;
    feeRate: number;
    status: string;
    paymentType: PaymentType;
    userName: string;
    /** Portal users no longer track balance locally — quota lives on new-api.
     *  Field kept on the result for backward-compat with admin orders UI; W4-1
     *  D2 sets it to 0 and the route handler strips it before responding. */
    userBalance: number;
    payUrl?: string | null;
    qrCode?: string | null;
    clientSecret?: string | null;
    /** Which payment provider routed this order (W5 D6: front-end uses
     *  this to decide between QR-display (easypay) and direct redirect
     *  (alipay_direct / stripe). */
    provider?: string;
    expiresAt: Date;
    statusAccessToken: string;
}

export async function createOrder(input: CreateOrderInput): Promise<CreateOrderResult> {
    const env = getEnv();
    const locale = input.locale ?? 'zh';
    const todayStart = getBizDayStartUTC();
    const orderType = input.orderType ?? 'balance';

    // ── 订阅订单前置校验 ──
    let subscriptionPlan: {
        id: string;
        groupId: number | null;
        price: Prisma.Decimal;
        validityDays: number;
        validityUnit: string;
        name: string;
        productName: string | null;
    } | null = null;
    let subscriptionGroupName = '';

    // R6: 余额充值禁用检查
    if (orderType === 'balance') {
        const balanceDisabled = await getSystemConfig('BALANCE_PAYMENT_DISABLED');
        if (balanceDisabled === 'true') {
            throw new OrderError(
                'BALANCE_PAYMENT_DISABLED',
                message(locale, '余额充值已被管理员关闭', 'Balance recharge has been disabled by the administrator'),
                403,
            );
        }
    }

    if (orderType === 'subscription') {
        if (!input.planId) {
            throw new OrderError(
                'INVALID_INPUT',
                message(locale, '订阅订单必须指定套餐', 'Subscription order requires a plan'),
                400,
            );
        }
        const plan = await prisma.subscriptionPlan.findUnique({ where: { id: input.planId } });
        if (!plan || !plan.forSale) {
            throw new OrderError(
                'PLAN_NOT_AVAILABLE',
                message(locale, '该套餐不存在或未上架', 'Plan not found or not for sale'),
                404,
            );
        }
        // 校验分组绑定有效
        if (plan.groupId === null) {
            throw new OrderError(
                'GROUP_NOT_BOUND',
                message(locale, '该套餐尚未绑定分组，无法购买', 'Plan is not bound to a group'),
                400,
            );
        }
        // 校验 Sub2API 分组仍然存在
        const group = await getGroup(plan.groupId);
        if (!group || group.status !== 'active') {
            throw new OrderError(
                'GROUP_NOT_FOUND',
                message(locale, '订阅分组已下架，无法购买', 'Subscription group is no longer available'),
                410,
            );
        }
        // R4: 校验分组必须为订阅类型
        if (group.subscription_type !== 'subscription') {
            throw new OrderError(
                'GROUP_TYPE_MISMATCH',
                message(locale, '该分组不是订阅类型，无法购买订阅', 'This group is not a subscription type'),
                400,
            );
        }
        subscriptionGroupName = group?.name || plan.name;
        subscriptionPlan = plan;
        // 订阅订单金额使用服务端套餐价格，不信任客户端
        input.amount = Number(plan.price);
    }

    // W4-1 D2: portal user lookup goes through prisma now (was litellm.getUser
    // stub which returned null and crashed on `.status`). litellm.getUser is
    // still imported for legacy callers (refund / subscription flows — out of
    // W4-1 scope) but the recharge path is portal-native here.
    if (!input.user_id) {
        throw new OrderError(
            'AUTH_REQUIRED',
            message(locale, '请先登录后再发起充值', 'Please log in to recharge'),
            401,
        );
    }
    const portalUser = await prisma.user.findUnique({
        where: { id: input.user_id },
        select: { id: true, email: true, nickname: true, status: true },
    });
    if (!portalUser) {
        throw new OrderError('USER_NOT_FOUND', message(locale, '用户不存在', 'User not found'), 404);
    }
    if (portalUser.status !== 'active') {
        throw new OrderError('USER_INACTIVE', message(locale, '用户账号已被禁用', 'User account is disabled'), 403);
    }
    // 适配 Order schema 上仍存在的 W1 sub2apipay 旧字段(userEmail/userName/
    // userNotes 都是 String?,for admin orders UI 展示)。Portal 没有 username/
    // notes,nickname 优先,缺则用 email 本地部分。
    const userDisplayName = portalUser.nickname || portalUser.email.split('@')[0];
    const user = {
        email: portalUser.email,
        username: userDisplayName,
        notes: null as string | null,
        balance: 0,
        status: portalUser.status,
    };

    // ── 取消频率限制：超限后禁止创建新订单 ──
    const rateLimitConfigs = await getSystemConfigs([
        'CANCEL_RATE_LIMIT_ENABLED',
        'CANCEL_RATE_LIMIT_WINDOW',
        'CANCEL_RATE_LIMIT_UNIT',
        'CANCEL_RATE_LIMIT_MAX',
        'CANCEL_RATE_LIMIT_WINDOW_MODE',
    ]);
    if (rateLimitConfigs['CANCEL_RATE_LIMIT_ENABLED'] === 'true') {
        const windowSize = parseInt(rateLimitConfigs['CANCEL_RATE_LIMIT_WINDOW'] || '1', 10) || 1;
        const maxCount = parseInt(rateLimitConfigs['CANCEL_RATE_LIMIT_MAX'] || '10', 10) || 10;
        const unit = rateLimitConfigs['CANCEL_RATE_LIMIT_UNIT'] || 'day';
        const windowMode = rateLimitConfigs['CANCEL_RATE_LIMIT_WINDOW_MODE'] || 'rolling';

        let windowStart: Date;
        if (windowMode === 'fixed') {
            const now = new Date();
            if (unit === 'day') {
                const start = new Date(now);
                start.setHours(0, 0, 0, 0);
                start.setDate(start.getDate() - (windowSize - 1));
                windowStart = start;
            } else if (unit === 'minute') {
                const start = new Date(now);
                start.setSeconds(0, 0);
                start.setMinutes(start.getMinutes() - (windowSize - 1));
                windowStart = start;
            } else {
                const start = new Date(now);
                start.setMinutes(0, 0, 0);
                start.setHours(start.getHours() - (windowSize - 1));
                windowStart = start;
            }
        } else {
            const unitMs = unit === 'minute' ? 60_000 : unit === 'day' ? 86_400_000 : 3_600_000;
            windowStart = new Date(Date.now() - windowSize * unitMs);
        }

        const recentCancelCount = await prisma.auditLog.count({
            where: {
                action: 'ORDER_CANCELLED',
                operator: `user:${input.user_id}`,
                createdAt: { gte: windowStart },
            },
        });
        if (recentCancelCount >= maxCount) {
            let retryAfter: Date;
            if (windowMode === 'fixed') {
                const now = new Date();
                if (unit === 'day') {
                    retryAfter = new Date(now);
                    retryAfter.setHours(0, 0, 0, 0);
                    retryAfter.setDate(retryAfter.getDate() + 1);
                } else if (unit === 'minute') {
                    retryAfter = new Date(now);
                    retryAfter.setSeconds(0, 0);
                    retryAfter.setMinutes(retryAfter.getMinutes() + 1);
                } else {
                    retryAfter = new Date(now);
                    retryAfter.setMinutes(0, 0, 0);
                    retryAfter.setHours(retryAfter.getHours() + 1);
                }
            } else {
                const unitMs = unit === 'minute' ? 60_000 : unit === 'day' ? 86_400_000 : 3_600_000;
                const earliest = await prisma.auditLog.findFirst({
                    where: {
                        action: 'ORDER_CANCELLED',
                        operator: `user:${input.user_id}`,
                        createdAt: { gte: windowStart },
                    },
                    orderBy: { createdAt: 'asc' },
                    select: { createdAt: true },
                });
                retryAfter = earliest
                    ? new Date(earliest.createdAt.getTime() + windowSize * unitMs)
                    : new Date(Date.now() + windowSize * unitMs);
            }

            const waitMs = retryAfter.getTime() - Date.now();
            const retryAfterMinutes = Math.max(1, Math.ceil(waitMs / 60_000));

            throw new OrderError('CANCEL_RATE_LIMITED', 'Cancel rate limited', 429, {
                windowSize,
                unit,
                maxCount,
                retryAfterMinutes,
            });
        }
    }

    const feeRate = getMethodFeeRate(input.paymentType);
    const payAmountStr = calculatePayAmount(input.amount, feeRate);
    const payAmountNum = Number(payAmountStr);

    const orderTimeoutConfig = await getSystemConfig('ORDER_TIMEOUT_MINUTES');
    const orderTimeoutMinutes = orderTimeoutConfig
        ? parseInt(orderTimeoutConfig, 10) || env.ORDER_TIMEOUT_MINUTES
        : env.ORDER_TIMEOUT_MINUTES;
    const expiresAt = new Date(Date.now() + orderTimeoutMinutes * 60 * 1000);

    // 读取最大支付中订单数配置
    const maxPendingConfig = await getSystemConfig('MAX_PENDING_ORDERS');
    const maxPendingOrders = maxPendingConfig
        ? parseInt(maxPendingConfig, 10) || DEFAULT_MAX_PENDING_ORDERS
        : DEFAULT_MAX_PENDING_ORDERS;

    // 每日充值限额配置（参考 /api/user 覆盖模式：getSystemConfig → env 兜底）
    const dailyLimitConfig = await getSystemConfig('DAILY_RECHARGE_LIMIT');
    const maxDailyRechargeAmount = dailyLimitConfig
        ? parseFloat(dailyLimitConfig) || env.MAX_DAILY_RECHARGE_AMOUNT
        : env.MAX_DAILY_RECHARGE_AMOUNT;

    // 将限额校验与订单创建放在同一个 serializable 事务中，防止并发突破限额
    const order = await prisma.$transaction(async (tx) => {
        // 待支付订单数限制
        const pendingCount = await tx.order.count({
            where: { user_id: input.user_id, status: ORDER_STATUS.PENDING },
        });
        if (pendingCount >= maxPendingOrders) {
            throw new OrderError(
                'TOO_MANY_PENDING',
                message(
                    locale,
                    `待支付订单过多（最多 ${maxPendingOrders} 笔）`,
                    `Too many pending orders (${maxPendingOrders})`,
                ),
                429,
            );
        }

        // 每日累计充值限额校验（0 = 不限制）
        if (maxDailyRechargeAmount > 0) {
            const dailyAgg = await tx.order.aggregate({
                where: {
                    user_id: input.user_id,
                    status: { in: [ORDER_STATUS.PAID, ORDER_STATUS.RECHARGING, ORDER_STATUS.COMPLETED] },
                    paidAt: { gte: todayStart },
                },
                _sum: { amount: true },
            });
            const alreadyPaid = Number(dailyAgg._sum?.amount ?? 0);
            if (alreadyPaid + input.amount > maxDailyRechargeAmount) {
                const remaining = Math.max(0, maxDailyRechargeAmount - alreadyPaid);
                throw new OrderError(
                    'DAILY_LIMIT_EXCEEDED',
                    message(
                        locale,
                        `今日累计充值已达上限，剩余可充值 ${remaining.toFixed(2)} 元`,
                        `Daily recharge limit reached. Remaining amount: ${remaining.toFixed(2)} CNY`,
                    ),
                    429,
                );
            }
        }

        // 渠道每日全平台限额校验（0 = 不限）
        const methodDailyLimit = await getMethodDailyLimit(input.paymentType);
        if (methodDailyLimit > 0) {
            const methodAgg = await tx.order.aggregate({
                where: {
                    paymentType: input.paymentType,
                    status: { in: [ORDER_STATUS.PAID, ORDER_STATUS.RECHARGING, ORDER_STATUS.COMPLETED] },
                    paidAt: { gte: todayStart },
                },
                _sum: { amount: true },
            });
            const methodUsed = Number(methodAgg._sum.amount ?? 0);
            if (methodUsed + input.amount > methodDailyLimit) {
                const remaining = Math.max(0, methodDailyLimit - methodUsed);
                throw new OrderError(
                    'METHOD_DAILY_LIMIT_EXCEEDED',
                    remaining > 0
                        ? message(
                              locale,
                              `${input.paymentType} 今日剩余额度 ${remaining.toFixed(2)} 元，请减少充值金额或使用其他支付方式`,
                              `${input.paymentType} remaining daily quota: ${remaining.toFixed(2)} CNY. Reduce the amount or use another payment method`,
                          )
                        : message(
                              locale,
                              `${input.paymentType} 今日充值额度已满，请使用其他支付方式`,
                              `${input.paymentType} daily quota is full. Please use another payment method`,
                          ),
                    429,
                );
            }
        }

        const created = await tx.order.create({
            data: {
                user_id: input.user_id,
                userEmail: user.email,
                userName: user.username,
                userNotes: user.notes || null,
                amount: new Prisma.Decimal(input.amount.toFixed(2)),
                payAmount: new Prisma.Decimal(payAmountStr),
                feeRate: feeRate > 0 ? new Prisma.Decimal(feeRate.toFixed(4)) : null,
                rechargeCode: '',
                status: 'PENDING',
                paymentType: input.paymentType,
                expiresAt,
                clientIp: input.clientIp,
                srcHost: input.srcHost || null,
                srcUrl: input.srcUrl || null,
                orderType,
                planId: subscriptionPlan?.id ?? null,
                subscriptionGroupId: subscriptionPlan?.groupId ?? null,
                subscriptionDays: subscriptionPlan
                    ? computeValidityDays(subscriptionPlan.validityDays, subscriptionPlan.validityUnit as ValidityUnit)
                    : null,
            },
        });

        const rechargeCode = generateRechargeCode(created.id);
        await tx.order.update({
            where: { id: created.id },
            data: { rechargeCode },
        });

        return { ...created, rechargeCode };
    });

    try {
        await ensureDBProviders();
        const provider = paymentRegistry.getProvider(input.paymentType);

        // 多实例负载均衡：尝试为当前 provider 选择实例
        let actualProvider = provider;
        let selectedInstanceId: string | undefined;

        const strategyConfig = await getSystemConfig('LOAD_BALANCE_STRATEGY');
        const strategy = (strategyConfig === 'least-amount' ? 'least-amount' : 'round-robin') as LoadBalanceStrategy;

        const instanceResult = await selectInstance(provider.providerKey, strategy, input.paymentType, input.amount);
        if (instanceResult) {
            if (provider.providerKey === 'easypay') {
                const { EasyPayProvider } = await import('@/lib/easy-pay/provider');
                actualProvider = new EasyPayProvider(instanceResult.instanceId, instanceResult.config);
            } else if (provider.providerKey === 'stripe') {
                const { StripeProvider } = await import('@/lib/stripe/provider');
                actualProvider = new StripeProvider(instanceResult.instanceId, instanceResult.config);
            }
            selectedInstanceId = instanceResult.instanceId;
        } else {
            // 检查是否有配置的实例但全部被限额过滤掉
            const instanceCount = await prisma.paymentProviderInstance.count({
                where: { providerKey: provider.providerKey, enabled: true },
            });
            if (instanceCount > 0) {
                throw new OrderError(
                    'NO_AVAILABLE_INSTANCE',
                    message(
                        locale,
                        '当前支付方式暂无可用渠道（所有实例已达限额），请稍后重试或更换支付方式',
                        'No available payment instance (all instances have reached their limits). Please try later or use another payment method',
                    ),
                    429,
                );
            }
        }

        const statusAccessToken = createOrderStatusAccessToken(order.id, input.user_id);
        const orderResultUrl = buildOrderResultUrl(env.NEXT_PUBLIC_APP_URL, order.id, input.user_id);

        // 只有 easypay 从外部传入 notifyUrl，return_url 统一回到带访问令牌的结果页
        let notifyUrl: string | undefined;
        let returnUrl: string | undefined = orderResultUrl;
        if (actualProvider.providerKey === 'easypay') {
            if (selectedInstanceId) {
                notifyUrl = `${env.NEXT_PUBLIC_APP_URL}/api/easy-pay/notify?inst=${selectedInstanceId}`;
            } else {
                notifyUrl = env.EASY_PAY_NOTIFY_URL || '';
            }
            returnUrl = orderResultUrl;
        }

        // R3+R5: 构建支付商品名称
        let paymentSubject: string;
        if (subscriptionPlan) {
            // R3: 订阅订单优先使用套餐自定义商品名称
            paymentSubject =
                subscriptionPlan.productName || `Sub2API 订阅 ${subscriptionGroupName || subscriptionPlan.name}`;
        } else {
            // R5: 余额订单使用前缀/后缀配置
            const nameConfigs = await getSystemConfigs(['PRODUCT_NAME_PREFIX', 'PRODUCT_NAME_SUFFIX']);
            const prefix = nameConfigs['PRODUCT_NAME_PREFIX']?.trim();
            const suffix = nameConfigs['PRODUCT_NAME_SUFFIX']?.trim();
            if (prefix || suffix) {
                paymentSubject = `${prefix || ''} ${payAmountStr} ${suffix || ''}`.trim();
            } else {
                paymentSubject = `Sub2API ${payAmountStr} CNY`;
            }
        }

        const paymentResult = await actualProvider.createPayment({
            orderId: order.id,
            amount: payAmountNum,
            paymentType: input.paymentType,
            subject: paymentSubject,
            notifyUrl,
            returnUrl,
            clientIp: input.clientIp,
            isMobile: input.isMobile,
        });

        await prisma.order.update({
            where: { id: order.id },
            data: {
                paymentTradeNo: paymentResult.tradeNo,
                payUrl: paymentResult.payUrl || null,
                qrCode: paymentResult.qrCode || null,
                providerInstanceId: selectedInstanceId ?? null,
            },
        });

        await prisma.auditLog.create({
            data: {
                orderId: order.id,
                action: 'ORDER_CREATED',
                detail: JSON.stringify({
                    user_id: input.user_id,
                    amount: input.amount,
                    paymentType: input.paymentType,
                    orderType,
                    ...(subscriptionPlan && {
                        planId: subscriptionPlan.id,
                        planName: subscriptionPlan.name,
                        groupId: subscriptionPlan.groupId,
                    }),
                }),
                operator: `user:${input.user_id}`,
            },
        });

        return {
            orderId: order.id,
            amount: input.amount,
            payAmount: payAmountNum,
            feeRate,
            status: ORDER_STATUS.PENDING,
            paymentType: input.paymentType,
            userName: user.username,
            userBalance: user.balance,
            payUrl: paymentResult.payUrl,
            qrCode: paymentResult.qrCode,
            clientSecret: paymentResult.clientSecret,
            // W5 D6: front-end branches on this — easypay returns QR (display
            // inline), alipay_direct / stripe return payUrl (redirect / popup).
            provider: actualProvider.providerKey,
            expiresAt,
            statusAccessToken,
        };
    } catch (error) {
        await prisma.order.delete({ where: { id: order.id } });

        // 已经是业务错误，直接向上抛
        if (error instanceof OrderError) throw error;

        // 支付网关配置缺失或调用失败，转成友好错误
        const msg = error instanceof Error ? error.message : String(error);
        console.error(`Payment gateway error (${input.paymentType}):`, error);
        if (msg.includes('environment variables') || msg.includes('not configured') || msg.includes('not found')) {
            throw new OrderError(
                'PAYMENT_GATEWAY_ERROR',
                message(
                    locale,
                    `支付渠道（${input.paymentType}）暂未配置，请联系管理员`,
                    `Payment method (${input.paymentType}) is not configured. Please contact the administrator`,
                ),
                503,
            );
        }
        throw new OrderError(
            'PAYMENT_GATEWAY_ERROR',
            message(
                locale,
                '支付渠道暂时不可用，请稍后重试或更换支付方式',
                'Payment method is temporarily unavailable. Please try again later or use another payment method',
            ),
            502,
        );
    }
}

export type CancelOutcome = 'cancelled' | 'already_paid';

/**
 * 核心取消逻辑 — 所有取消路径共用。
 * 调用前由 caller 负责权限校验（user_id / admin 身份）。
 */
export async function cancelOrderCore(options: {
    orderId: string;
    paymentTradeNo: string | null;
    paymentType: string | null;
    providerInstanceId?: string | null;
    finalStatus: 'CANCELLED' | 'EXPIRED';
    operator: string;
    auditDetail: string;
}): Promise<CancelOutcome> {
    const { orderId, paymentTradeNo, paymentType, providerInstanceId, finalStatus, operator, auditDetail } = options;

    // 1. 平台侧处理
    if (paymentTradeNo && paymentType) {
        try {
            let provider;
            // 多实例：使用实例配置创建 provider
            if (providerInstanceId) {
                const instConfig = await getInstanceConfig(providerInstanceId);
                if (instConfig) {
                    // 目前仅 easypay 支持多实例
                    const { EasyPayProvider } = await import('@/lib/easy-pay/provider');
                    provider = new EasyPayProvider(providerInstanceId, instConfig);
                }
            }
            if (!provider) {
                await ensureDBProviders();
                provider = paymentRegistry.getProvider(paymentType as PaymentType);
            }
            const queryResult = await provider.queryOrder(paymentTradeNo);

            if (queryResult.status === 'paid') {
                await confirmPayment({
                    orderId,
                    tradeNo: paymentTradeNo,
                    paidAmount: queryResult.amount,
                    providerName: provider.name,
                });
                console.log(`Order ${orderId} was paid during cancel (${operator}), processed as success`);
                return 'already_paid';
            }

            if (provider.cancelPayment) {
                try {
                    await provider.cancelPayment(paymentTradeNo);
                } catch (cancelErr) {
                    console.warn(`Failed to cancel payment for order ${orderId}:`, cancelErr);
                }
            }
        } catch (platformErr) {
            console.warn(`Platform check failed for order ${orderId}, cancelling locally:`, platformErr);
        }
    }

    // 2. DB 更新 (WHERE status='PENDING' 保证幂等)
    const result = await prisma.order.updateMany({
        where: { id: orderId, status: ORDER_STATUS.PENDING },
        data: { status: finalStatus, updatedAt: new Date() },
    });

    // 3. 审计日志
    if (result.count > 0) {
        await prisma.auditLog.create({
            data: {
                orderId,
                action: finalStatus === ORDER_STATUS.EXPIRED ? 'ORDER_EXPIRED' : 'ORDER_CANCELLED',
                detail: auditDetail,
                operator,
            },
        });
    }

    return 'cancelled';
}

export async function cancelOrder(
    orderId: string,
    user_id: string | null,
    locale: Locale = 'zh',
): Promise<CancelOutcome> {
    const order = await prisma.order.findUnique({
        where: { id: orderId },
        select: {
            id: true,
            user_id: true,
            status: true,
            paymentTradeNo: true,
            paymentType: true,
            providerInstanceId: true,
        },
    });

    if (!order) throw new OrderError('NOT_FOUND', message(locale, '订单不存在', 'Order not found'), 404);
    if (order.user_id !== user_id)
        throw new OrderError('FORBIDDEN', message(locale, '无权操作该订单', 'Forbidden'), 403);
    if (order.status !== ORDER_STATUS.PENDING)
        throw new OrderError(
            'INVALID_STATUS',
            message(locale, '订单当前状态不可取消', 'Order cannot be cancelled'),
            400,
        );

    return cancelOrderCore({
        orderId: order.id,
        paymentTradeNo: order.paymentTradeNo,
        paymentType: order.paymentType,
        providerInstanceId: order.providerInstanceId,
        finalStatus: ORDER_STATUS.CANCELLED,
        operator: `user:${user_id}`,
        auditDetail: message(locale, '用户取消订单', 'User cancelled order'),
    });
}

export async function adminCancelOrder(orderId: string, locale: Locale = 'zh'): Promise<CancelOutcome> {
    const order = await prisma.order.findUnique({
        where: { id: orderId },
        select: { id: true, status: true, paymentTradeNo: true, paymentType: true, providerInstanceId: true },
    });

    if (!order) throw new OrderError('NOT_FOUND', message(locale, '订单不存在', 'Order not found'), 404);
    if (order.status !== ORDER_STATUS.PENDING)
        throw new OrderError(
            'INVALID_STATUS',
            message(locale, '订单当前状态不可取消', 'Order cannot be cancelled'),
            400,
        );

    return cancelOrderCore({
        orderId: order.id,
        paymentTradeNo: order.paymentTradeNo,
        paymentType: order.paymentType,
        providerInstanceId: order.providerInstanceId,
        finalStatus: ORDER_STATUS.CANCELLED,
        operator: 'admin',
        auditDetail: message(locale, '管理员取消订单', 'Admin cancelled order'),
    });
}

/**
 * Provider-agnostic: confirm a payment and trigger recharge.
 * Called by any provider's webhook/notify handler after verification.
 */
export async function confirmPayment(input: {
    orderId: string;
    tradeNo: string;
    paidAmount: number;
    providerName: string;
}): Promise<boolean> {
    const order = await prisma.order.findUnique({
        where: { id: input.orderId },
    });
    if (!order) {
        console.error(`${input.providerName} notify: order not found:`, input.orderId);
        return false;
    }

    let paidAmount: Prisma.Decimal;
    try {
        paidAmount = new Prisma.Decimal(input.paidAmount.toFixed(2));
    } catch {
        console.error(`${input.providerName} notify: invalid amount:`, input.paidAmount);
        return false;
    }
    if (paidAmount.lte(0)) {
        console.error(`${input.providerName} notify: non-positive amount:`, input.paidAmount);
        return false;
    }
    const expectedAmount = order.payAmount ?? order.amount;
    if (!paidAmount.equals(expectedAmount)) {
        const diff = paidAmount.minus(expectedAmount).abs();
        if (diff.gt(new Prisma.Decimal('0.01'))) {
            // 写审计日志
            await prisma.auditLog.create({
                data: {
                    orderId: order.id,
                    action: 'PAYMENT_AMOUNT_MISMATCH',
                    detail: JSON.stringify({
                        expected: expectedAmount.toString(),
                        paid: paidAmount.toString(),
                        diff: diff.toString(),
                        tradeNo: input.tradeNo,
                    }),
                    operator: input.providerName,
                },
            });
            console.error(
                `${input.providerName} notify: amount mismatch beyond threshold`,
                `expected=${expectedAmount.toString()}, paid=${paidAmount.toString()}, diff=${diff.toString()}`,
            );
            return false;
        }
        console.warn(
            `${input.providerName} notify: minor amount difference (rounding)`,
            expectedAmount.toString(),
            paidAmount.toString(),
        );
    }

    // 只接受 PENDING 状态，或过期不超过 5 分钟的 EXPIRED 订单（支付在过期边缘完成的宽限窗口）
    const graceDeadline = new Date(Date.now() - 5 * 60 * 1000);
    const result = await prisma.order.updateMany({
        where: {
            id: order.id,
            OR: [{ status: ORDER_STATUS.PENDING }, { status: ORDER_STATUS.EXPIRED, updatedAt: { gte: graceDeadline } }],
        },
        data: {
            status: ORDER_STATUS.PAID,
            payAmount: paidAmount,
            paymentTradeNo: input.tradeNo,
            paidAt: new Date(),
            failedAt: null,
            failedReason: null,
        },
    });

    if (result.count === 0) {
        // 重新查询当前状态，区分「已成功」和「需重试」
        const current = await prisma.order.findUnique({
            where: { id: order.id },
            select: { status: true },
        });
        if (!current) return true;

        // 已完成或已退款 — 告知支付平台成功
        if (current.status === ORDER_STATUS.COMPLETED || current.status === ORDER_STATUS.REFUNDED) {
            return true;
        }

        // FAILED 状态 — 之前充值失败，利用重试通知自动重试充值
        if (current.status === ORDER_STATUS.FAILED) {
            try {
                await executeFulfillment(order.id);
                return true;
            } catch (err) {
                console.error('Fulfillment retry failed for order:', order.id, err);
                return false; // 让支付平台继续重试
            }
        }

        // PAID / RECHARGING — 正在处理中，让支付平台稍后重试
        if (current.status === ORDER_STATUS.PAID || current.status === ORDER_STATUS.RECHARGING) {
            return false;
        }

        // 其他状态（CANCELLED 等）— 不应该出现，返回 true 停止重试
        return true;
    }

    await prisma.auditLog.create({
        data: {
            orderId: order.id,
            action: 'ORDER_PAID',
            detail: JSON.stringify({
                previous_status: order.status,
                trade_no: input.tradeNo,
                expected_amount: order.amount.toString(),
                paid_amount: paidAmount.toString(),
            }),
            operator: input.providerName,
        },
    });

    try {
        await executeFulfillment(order.id);
    } catch (err) {
        console.error('Fulfillment failed for order:', order.id, err);
        return false;
    }

    return true;
}

/**
 * Handle a verified payment notification from any provider.
 * The caller (webhook route) is responsible for verifying the notification
 * via provider.verifyNotification() before calling this function.
 */
export async function handlePaymentNotify(notification: PaymentNotification, providerName: string): Promise<boolean> {
    if (notification.status !== 'success') {
        return true;
    }

    return confirmPayment({
        orderId: notification.orderId,
        tradeNo: notification.tradeNo,
        paidAmount: notification.amount,
        providerName,
    });
}

/**
 * 统一履约入口 — 根据 orderType 分派到余额充值或订阅分配。
 */
export async function executeFulfillment(orderId: string): Promise<void> {
    const order = await prisma.order.findUnique({
        where: { id: orderId },
        select: { orderType: true },
    });
    if (!order) throw new OrderError('NOT_FOUND', 'Order not found', 404);

    if (order.orderType === 'subscription') {
        await executeSubscriptionFulfillment(orderId);
    } else {
        await executeRecharge(orderId);
    }
}

/**
 * 订阅履约 — 支付成功后调用 Sub2API 分配订阅。
 */
export async function executeSubscriptionFulfillment(orderId: string): Promise<void> {
    const order = await prisma.order.findUnique({ where: { id: orderId } });
    if (!order) throw new OrderError('NOT_FOUND', 'Order not found', 404);
    if (order.status === ORDER_STATUS.COMPLETED) return;
    if (isRefundStatus(order.status)) {
        throw new OrderError('INVALID_STATUS', 'Refund-related order cannot fulfill', 400);
    }
    if (order.status !== ORDER_STATUS.PAID && order.status !== ORDER_STATUS.FAILED) {
        throw new OrderError('INVALID_STATUS', `Order cannot fulfill in status ${order.status}`, 400);
    }
    if (!order.subscriptionGroupId || !order.subscriptionDays) {
        throw new OrderError('INVALID_STATUS', 'Missing subscription info on order', 400);
    }

    // CAS 锁
    const lockResult = await prisma.order.updateMany({
        where: { id: orderId, status: { in: [ORDER_STATUS.PAID, ORDER_STATUS.FAILED] } },
        data: { status: ORDER_STATUS.RECHARGING },
    });
    if (lockResult.count === 0) return;

    try {
        // 校验分组是否仍然存在
        const group = await getGroup(order.subscriptionGroupId);
        if (!group || group.status !== 'active') {
            throw new Error(`Subscription group ${order.subscriptionGroupId} no longer exists or inactive`);
        }

        // 检测是否续费：查找同分组的活跃订阅，决定天数计算起点
        let validityDays = order.subscriptionDays;
        let fulfillMethod: 'renew' | 'new' = 'new';
        let renewedSubscriptionId: number | undefined;

        const userSubs = await getUserSubscriptions(order.user_id);
        const activeSub = userSubs.find((s) => s.group_id === order.subscriptionGroupId && s.status === 'active');

        if (activeSub) {
            // 续费：从到期日往后推算天数（使用订单关联的具体套餐，而非分组下任意套餐）
            const plan = order.planId
                ? await prisma.subscriptionPlan.findUnique({
                      where: { id: order.planId },
                      select: { validityDays: true, validityUnit: true },
                  })
                : null;
            if (plan) {
                validityDays = computeValidityDays(
                    plan.validityDays,
                    plan.validityUnit as ValidityUnit,
                    new Date(activeSub.expires_at),
                );
            }
            fulfillMethod = 'renew';
            renewedSubscriptionId = activeSub.id;
        }

        await createAndRedeem(
            order.rechargeCode,
            Number(order.amount),
            order.user_id,
            `sub2apipay subscription order:${orderId}`,
            {
                type: 'subscription',
                groupId: order.subscriptionGroupId,
                validityDays,
            },
        );

        await prisma.order.updateMany({
            where: { id: orderId, status: ORDER_STATUS.RECHARGING },
            data: { status: ORDER_STATUS.COMPLETED, completedAt: new Date() },
        });

        await prisma.auditLog.create({
            data: {
                orderId,
                action: 'SUBSCRIPTION_SUCCESS',
                detail: JSON.stringify({
                    groupId: order.subscriptionGroupId,
                    days: order.subscriptionDays,
                    amount: Number(order.amount),
                    method: fulfillMethod,
                    ...(renewedSubscriptionId && { renewedSubscriptionId }),
                }),
                operator: 'system',
            },
        });
    } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        const isGroupGone = reason.includes('no longer exists');

        await prisma.order.update({
            where: { id: orderId },
            data: {
                status: ORDER_STATUS.FAILED,
                failedAt: new Date(),
                failedReason: isGroupGone ? `SUBSCRIPTION_GROUP_GONE: ${reason}` : reason,
            },
        });

        await prisma.auditLog.create({
            data: {
                orderId,
                action: 'SUBSCRIPTION_FAILED',
                detail: reason,
                operator: 'system',
            },
        });

        throw error;
    }
}

/**
 * 余额充值履约（W4-1 D1 初版 → W8 D8 重写为 intent → execute → confirm 三段)
 *
 * ── W8 D8 背景 ──
 * 旧实现把不可回滚的 applyTopup(HTTP add_quota)和去重锚点 rechargeLog.create
 * 放在同一个 transaction 里,且把 raw quota(1–2 亿)写进 numeric(12,4) 的
 * balance_before/after → numeric field overflow → tx 回滚但 applyTopup 已生效
 * → 去重行没落库 → 易支付 webhook 重试 → 同一订单被重复入账 ~13×。
 * 详见 docs/W8-D8-RECHARGE-BUG-ROOT-CAUSE.md。
 *
 * ── 新的三段式 idempotency ──
 *   阶段 1 去重:CAS lock 后 findFirst RechargeLog(order_id, source=payment)。
 *     - newapi_quota_added != null → 上轮已确认入账 → 幂等 finalize COMPLETED。
 *     - newapi_quota_added == null → 占位行存在但入账结果未知(crash / 网络歧义
 *       失败)→ order FAILED + RECHARGE_NEEDS_REVIEW,转人工,绝不自动重扣。
 *   阶段 2 intent(独立 tx,commit):CAS-claim 首充 bonus + INSERT 占位 RechargeLog
 *     (newapi_quota_added=null 哨兵,balance_* 占位 0)。commit 之后 applyTopup
 *     对同一 order 永不二次执行(阶段 1 去重命中)。
 *   阶段 3 execute(在任何 tx 之外):applyTopup。Smart-recovery 失败策略(operator
 *     W8 D8 决策):NewApiError(new-api 明确拒绝 → 未入账)→ 删占位 + 撤 bonus claim
 *     → 抛 → order FAILED → webhook 重试干净重扣;非 NewApiError(网络/超时,结果
 *     未知)→ 保留占位 → 抛 → order FAILED → 重试走阶段 1 人工复核(不重扣)。
 *   阶段 4 confirm(tx,commit):回填占位行(balance_* 存 ¥CNY、newapi_quota_added
 *     落值)+ order COMPLETED + commission + 缓存清零。
 *
 * ── 关键修正 ──
 *   - balance_before/after 存 ¥CNY(quotaToCny),与 amount 同单位;raw quota 只在
 *     newapi_quota_added(BigInt)。配合 schema 拓宽到 numeric(20,4),overflow 根除。
 *   - applyTopup 移出 transaction,不再 ~10s 持 DB 连接(消解 W6 D5 F1)。
 *
 * 与 W1 LiteLLM 时代的差异(gotcha #1 / #12):不调 createAndRedeem、不动 token
 * (new-api 永远 unlimited_quota=true)、充值 = add_quota 增量语义、amount 是 CNY。
 */
export async function executeRecharge(orderId: string): Promise<void> {
    const order = await prisma.order.findUnique({ where: { id: orderId } });
    if (!order) {
        throw new OrderError('NOT_FOUND', 'Order not found', 404);
    }
    if (order.status === ORDER_STATUS.COMPLETED) {
        return;
    }
    if (isRefundStatus(order.status)) {
        throw new OrderError('INVALID_STATUS', 'Refund-related order cannot recharge', 400);
    }
    if (order.status !== ORDER_STATUS.PAID && order.status !== ORDER_STATUS.FAILED) {
        throw new OrderError('INVALID_STATUS', `Order cannot recharge in status ${order.status}`, 400);
    }
    if (!order.user_id) {
        // Order 创建时必须有 user_id；防御性检查 — 没有 portal user 就找不到
        // 对应的 new-api user,直接 FAILED。
        await prisma.order.update({
            where: { id: orderId },
            data: {
                status: ORDER_STATUS.FAILED,
                failedAt: new Date(),
                failedReason: 'order has no user_id (cannot route to new-api)',
            },
        });
        throw new OrderError('INVALID_STATUS', 'Order has no user_id', 400);
    }
    // Narrow user_id → string here (right after the guard, before any await,
    // so TS keeps the narrowing). Used throughout the phases below.
    const userId = order.user_id;

    // 原子 CAS:将状态从 PAID/FAILED → RECHARGING,防止并发竞态。同一 order 同时
    // 只有一个 executeRecharge 持有 RECHARGING,后续阶段无需再防同 order 并发。
    const lockResult = await prisma.order.updateMany({
        where: { id: orderId, status: { in: [ORDER_STATUS.PAID, ORDER_STATUS.FAILED] } },
        data: { status: ORDER_STATUS.RECHARGING },
    });
    if (lockResult.count === 0) {
        // 另一个并发请求已经在处理 — 让它继续,本调用直接返回。
        return;
    }

    const cnyAmount = Number(order.amount);

    try {
        // ── 阶段 1:幂等去重 ──
        // 占位 RechargeLog 行现在「在 applyTopup 之前就 commit」,newapi_quota_added
        // 作为「是否已确认入账」哨兵。
        const existingLog = await prisma.rechargeLog.findFirst({
            where: { order_id: orderId, source: 'payment' },
            select: { id: true, newapi_quota_added: true },
        });
        if (existingLog) {
            if (existingLog.newapi_quota_added != null) {
                // 已确认入账(applyTopup 成功 + confirm tx commit 过)→ 幂等 finalize,
                // 绝不重复 applyTopup。覆盖「上轮入账成功但 COMPLETED 写入前 crash」尾场景。
                console.warn(
                    `[executeRecharge] order ${orderId} already settled (RechargeLog ${existingLog.id}) — finalizing without re-charging new-api`,
                );
                await prisma.order.updateMany({
                    where: { id: orderId, status: ORDER_STATUS.RECHARGING },
                    data: { status: ORDER_STATUS.COMPLETED, completedAt: new Date() },
                });
                return;
            }
            // 占位行存在但 newapi_quota_added 仍为 null = 入账结果未知(进程在
            // applyTopup 之后、confirm 之前 crash,或 applyTopup 网络层歧义失败被保留)。
            // 既不能安全重扣(可能双扣),也不能直接 finalize(可能根本没入账)
            // → 标 FAILED + RECHARGE_NEEDS_REVIEW 审计,转人工复核。不抛错(让
            // confirmPayment 返回 true,webhook 停止重试),由 operator / 阶段 C 审计捞出。
            const reviewReason = `RECHARGE_NEEDS_REVIEW: unconfirmed top-up placeholder (RechargeLog ${existingLog.id}); applyTopup outcome unknown — not auto-retrying to avoid double charge`;
            console.error(`[executeRecharge] order ${orderId} ${reviewReason}`);
            await prisma.order.update({
                where: { id: orderId },
                data: { status: ORDER_STATUS.FAILED, failedAt: new Date(), failedReason: reviewReason },
            });
            await prisma.auditLog.create({
                data: { orderId, action: 'RECHARGE_NEEDS_REVIEW', detail: reviewReason, operator: 'system' },
            });
            return;
        }

        // 取 portal user 拿 new-api 关联。RechargeLog.user_id 是 portal UUID,
        // 但充值要打到 new-api 的 int user id。这两个 ID 在 register/oauth
        // provisionNewCustomer 时建立映射(User.newapi_user_id)。
        // W6 D1: 同时读 first_recharge_bonus_granted,决定是否走首充福利路径
        // (仅作 peek,真正的 race-safe claim 走 intent 事务内 updateMany)。
        const portalUser = await prisma.user.findUnique({
            where: { id: userId },
            select: {
                id: true,
                newapi_user_id: true,
                // P4c-3: 决定走 ¥账本(portal)还是 add_quota(newapi,默认)。
                billing_mode: true,
                first_recharge_bonus_granted: true,
                // W7 D4: read invite_code so we can pick the right bonus rate
                // (30% if currently-valid, 20% default). Re-validation against
                // INVITE_CODES env happens inside the intent tx so an operator
                // can soft-revoke a code via env edit.
                invite_code: true,
                // PR-U1: reseller attribution. NULL on either field = no
                // reseller commission to write. attribution_expires_at <= now
                // also disables commission (24-month protection elapsed).
                // Re-checked inside tx via isAttributionActive() so a stale
                // peek can't trigger a write past the window.
                inviter_reseller_id: true,
                attribution_expires_at: true,
            },
        });
        if (!portalUser) {
            throw new Error(`portal user ${userId} not found`);
        }
        if (portalUser.newapi_user_id == null) {
            throw new Error(
                `portal user ${userId} has no newapi_user_id (provisionNewCustomer never ran or rolled back)`,
            );
        }
        const newapiUserId = portalUser.newapi_user_id;
        const peekBonusEligible = portalUser.first_recharge_bonus_granted === false;
        // W7 D4: bonus-rate selection. Read once at peek time and pass into
        // the tx so the rate doesn't shift mid-transaction if env is reloaded.
        const bonusRate = isValidInviteCode(portalUser.invite_code)
            ? FIRST_RECHARGE_BONUS_RATE_INVITED
            : FIRST_RECHARGE_BONUS_RATE;
        const mainQuota = cnyToQuota(cnyAmount);
        // P4c-3 两道门:全局 BILLING_SOURCE=portal + 单客户 billing_mode='portal' → 钱进 ¥账本;
        // 否则(默认 / 任一门关)= 完全照旧的 new-api add_quota 路径(newapi 客户一字不改)。
        const isPortalRecharge = billingSourceIsPortal() && portalUser.billing_mode === 'portal';

        // ── 阶段 2:intent — 首充 bonus CAS-claim + 占位 RechargeLog,独立 commit ──
        // (W8 D8 核心)把去重锚点 placeholder 在 applyTopup **之前** commit。commit
        // 之后,任何后续失败 / crash / webhook 重试都不会让同一 order 二次 applyTopup
        // (阶段 1 去重命中)。
        //
        // 首充 bonus 的 race-safe claim 必须在此(applyTopup 之前、与 placeholder 原子):
        //   - tx 内 updateMany WHERE first_recharge_bonus_granted=false。先到 count=1
        //     拿到 bonus;并发同 user 第二条 order 在 Postgres READ COMMITTED 下 block
        //     等行锁,commit 后 re-read granted=true → count=0 → 只入主 quota。
        //   - 若放到 applyTopup 之后再 claim,并发两单会各自带 bonus 调一次 applyTopup
        //     → 双发 bonus。所以 claim 必须前置。
        const intent = await prisma.$transaction(async (tx) => {
            let bonusQuota = 0;
            let bonusClaimed = false;
            if (peekBonusEligible) {
                const claim = await tx.user.updateMany({
                    where: { id: userId, first_recharge_bonus_granted: false },
                    data: { first_recharge_bonus_granted: true },
                });
                if (claim.count === 1) {
                    bonusQuota = Math.floor(mainQuota * bonusRate);
                    bonusClaimed = true;
                }
                // count===0 防御性:peek 与 claim 之间另一条并发 order 已抢到 bonus,
                // 本次只入主 quota,不复发 bonus(数据自愈,不抛错)。
            }
            const placeholder = await tx.rechargeLog.create({
                data: {
                    user_id: userId,
                    order_id: orderId,
                    amount: new Prisma.Decimal(cnyAmount.toFixed(4)),
                    // balance_* 在阶段 4 confirm 回填为 ¥CNY;此处占位 0。
                    balance_before: new Prisma.Decimal(0),
                    balance_after: new Prisma.Decimal(0),
                    // newapi_quota_added=null = 「尚未确认入账」哨兵(confirm 阶段落值)。
                    newapi_quota_added: null,
                    bonus_quota_added: BigInt(bonusQuota),
                    newapi_user_id: newapiUserId,
                    source: 'payment',
                    note: `recharge order:${orderId} (pending top-up)`,
                },
                select: { id: true },
            });
            return { rechargeLogId: placeholder.id, bonusQuota, bonusClaimed };
        });
        const totalQuota = mainQuota + intent.bonusQuota;

        // 余额审计快照:newapi 路径用 new-api raw quota;portal 路径用 ¥账本(applyLedgerEntry 返回)。
        let balanceBeforeRaw = 0;
        let balanceAfterRaw = 0;
        let portalBalanceBeforeCny: number | null = null;
        let portalBalanceAfterCny: number | null = null;

        if (isPortalRecharge) {
            // ── 阶段 3(portal 模式):钱进 portal ¥账本,**不**进 new-api quota ──
            //   首充 bonus 以 ¥ 计入同一条 recharge entry(金额含 bonus)。(recharge, ref=order.id)
            //   唯一约束 → 重复回调不双充(applyLedgerEntry 幂等)。
            //   ⚠️ 绝不 add_quota:portal 客户的 new-api quota 只是哑门开关(syncNewapiGate 控),
            //      不是余额、不计扣费 —— portal Account.balance_cny 是唯一余额事实源。
            const bonusCny = intent.bonusClaimed ? Number((cnyAmount * bonusRate).toFixed(8)) : 0;
            try {
                const led = await applyLedgerEntry(userId, {
                    kind: 'recharge',
                    amount_cny: cnyAmount + bonusCny,
                    ref: orderId, // (recharge, ref=order.id) 幂等:重复回调不双充
                    note:
                        bonusCny > 0
                            ? `recharge order:${orderId} (首充 bonus +¥${bonusCny})`
                            : `recharge order:${orderId}`,
                });
                portalBalanceAfterCny = Number(led.balance_after);
                portalBalanceBeforeCny = portalBalanceAfterCny - (cnyAmount + bonusCny);
            } catch (ledgerErr) {
                // 与 newapi NewApiError 回退同义:删占位行 + 撤 bonus claim → order FAILED →
                // webhook 重试时阶段 1 找不到占位行 → 干净重试。applyLedgerEntry (recharge,ref)
                // 幂等:即便上次其实写进去了,重试也只 dedup 返回、绝不双充。
                try {
                    await prisma.$transaction(async (tx) => {
                        await tx.rechargeLog.delete({ where: { id: intent.rechargeLogId } });
                        if (intent.bonusClaimed) {
                            await tx.user.updateMany({
                                where: { id: userId, first_recharge_bonus_granted: true },
                                data: { first_recharge_bonus_granted: false },
                            });
                        }
                    });
                } catch (rollbackErr) {
                    console.error(
                        `[executeRecharge] order ${orderId} portal-ledger placeholder rollback failed:`,
                        rollbackErr,
                    );
                }
                throw ledgerErr;
            }
            // 余额转正 → 立即开哑门(非致命:失败下一轮 meter 会再 sync)。
            try {
                await syncNewapiGate(userId);
            } catch (gateErr) {
                console.warn(
                    `[executeRecharge] order ${orderId} syncNewapiGate after recharge failed (next meter run reconciles):`,
                    gateErr,
                );
            }
        } else {
            // ── 阶段 3(newapi 模式,完全照旧,一字不改)──
            // balance_before 审计基线(raw quota,后续换算 ¥CNY)。best-effort,失败用 0。
            try {
                balanceBeforeRaw = (await newapiGetUser(newapiUserId)).quota;
            } catch (err) {
                console.warn(
                    `[executeRecharge] getUser(${newapiUserId}) before topup failed (continuing with 0 baseline):`,
                    err,
                );
            }

            // execute — applyTopup(HTTP 副作用,at-most-once)。占位行已 commit,本调用对同一
            // order 不会被 webhook 重试二次执行。
            try {
                await newapiApplyTopup({
                    newapi_user_id: newapiUserId,
                    cnyAmount,
                    extraBonusQuota: intent.bonusQuota,
                });
            } catch (topupErr) {
                // Smart-recovery 失败策略(operator W8 D8 决策):
                //   - NewApiError:new-api 明确返回错误响应 → add_quota 没生效 → 安全地把这
                //     次 attempt 整个回退(删占位行 + 撤 bonus claim),order 落 FAILED,
                //     webhook 重试时阶段 1 找不到占位行 → 干净重扣。
                //   - 非 NewApiError(fetch 网络层抛错 / 超时,没拿到响应)→ 入账结果未知 →
                //     保留占位行(null),order 落 FAILED,重试时阶段 1 命中 null 占位 →
                //     人工复核,不自动重扣(防双扣)。
                if (topupErr instanceof NewApiError) {
                    try {
                        await prisma.$transaction(async (tx) => {
                            await tx.rechargeLog.delete({ where: { id: intent.rechargeLogId } });
                            if (intent.bonusClaimed) {
                                // 撤回本次 claim(只在 granted 仍为 true 时,即没有别的流程介入)。
                                await tx.user.updateMany({
                                    where: { id: userId, first_recharge_bonus_granted: true },
                                    data: { first_recharge_bonus_granted: false },
                                });
                            }
                        });
                    } catch (rollbackErr) {
                        // 回退失败不致命:占位行残留只会让下次重试走人工复核(保守,不双扣)。
                        console.error(
                            `[executeRecharge] order ${orderId} placeholder rollback after NewApiError failed:`,
                            rollbackErr,
                        );
                    }
                }
                throw topupErr;
            }

            // balance_after 审计。失败兜底 before+totalQuota(入账已成功,审计不阻塞 finalize)。
            try {
                balanceAfterRaw = (await newapiGetUser(newapiUserId)).quota;
            } catch (err) {
                console.warn(
                    `[executeRecharge] getUser(${newapiUserId}) after topup failed (using before+delta):`,
                    err,
                );
                balanceAfterRaw = balanceBeforeRaw + totalQuota;
            }
        }

        // ── 阶段 4:confirm — 回填占位行 + finalize + commission + 缓存清零,一次 commit ──
        // tx timeout=15000ms(applyTopup 已在 tx 外,这里只剩 prisma 写,余量充足)。
        await prisma.$transaction(
            async (tx) => {
                await tx.rechargeLog.update({
                    where: { id: intent.rechargeLogId },
                    data: {
                        // W8 D8: balance_* 存 ¥CNY(与 amount 同单位)。
                        // portal:¥账本余额(applyLedgerEntry 返回);newapi:quotaToCny(raw quota)。
                        balance_before: new Prisma.Decimal(
                            (isPortalRecharge ? (portalBalanceBeforeCny ?? 0) : quotaToCny(balanceBeforeRaw)).toFixed(
                                4,
                            ),
                        ),
                        balance_after: new Prisma.Decimal(
                            (isPortalRecharge ? (portalBalanceAfterCny ?? 0) : quotaToCny(balanceAfterRaw)).toFixed(4),
                        ),
                        // newapi_quota_added 从 null → 落值 = 哨兵确认入账,阶段 1 据此幂等。
                        // portal:0(钱在 ¥账本,没动 new-api quota);newapi:totalQuota。
                        newapi_quota_added: BigInt(isPortalRecharge ? 0 : totalQuota),
                        bonus_quota_added: BigInt(intent.bonusQuota),
                        note:
                            intent.bonusQuota > 0
                                ? `recharge order:${orderId} (first-recharge bonus +${intent.bonusQuota})`
                                : `recharge order:${orderId}`,
                    },
                });

                await tx.order.updateMany({
                    where: { id: orderId, status: ORDER_STATUS.RECHARGING },
                    data: { status: ORDER_STATUS.COMPLETED, completedAt: new Date() },
                });

                await tx.auditLog.create({
                    data: {
                        orderId,
                        action: 'RECHARGE_SUCCESS',
                        detail: JSON.stringify({
                            cnyAmount,
                            mainQuota,
                            bonusQuota: intent.bonusQuota,
                            totalQuota,
                            firstRechargeBonus: intent.bonusQuota > 0,
                            newapiUserId,
                            balanceBefore: balanceBeforeRaw,
                            balanceAfter: balanceAfterRaw,
                        }),
                        operator: 'system',
                    },
                });

                // ── PR-U1 reseller commission hook ──
                // If user is currently attributed to an active reseller AND
                // the 24-month window hasn't expired, write a ResellerCommission
                // row + update Reseller.cumulative_gmv + maybe upgrade tier.
                // Re-check `isAttributionActive` inside the tx so a stale peek
                // can't write a commission past the window (defensive).
                if (
                    isAttributionActive({
                        inviter_reseller_id: portalUser.inviter_reseller_id,
                        attribution_expires_at: portalUser.attribution_expires_at,
                        now: new Date(),
                    })
                ) {
                    try {
                        await writeCommissionInTx(tx, {
                            reseller_id: portalUser.inviter_reseller_id!,
                            user_id: userId,
                            recharge_log_id: intent.rechargeLogId,
                            attributed_gmv_cny: cnyAmount,
                            now: new Date(),
                        });
                    } catch (commissionErr) {
                        // 沿用 PR-U1「commission 属 money path,不静默丢弃」语义:失败回滚
                        // confirm tx(rechargeLog.update 落 newapi_quota_added 一并回滚 →
                        // 占位行哨兵退回 null)→ 外层 catch 标 order FAILED。webhook 重试
                        // 时阶段 1 命中「null 占位行」→ 人工复核(applyTopup 已成功入账,
                        // 占位行阻断重扣,绝不双扣)。比改造前严格更安全 — 旧逻辑此处回滚
                        // 后重试会再次 applyTopup 造成双扣。
                        console.error(
                            `[executeRecharge] reseller commission write failed (rolling back confirm tx → manual review):`,
                            commissionErr,
                        );
                        throw commissionErr;
                    }
                }

                // Cache bust(W4-2 D6):applyTopup 已把 raw quota 涨到 new-api 那边,
                // 但 portal Prisma 上的 newapi_quota_cache 还是旧值。null 三个字段让
                // 下一次 /balance 渲染走 live fetch,看到最新余额。
                // W6 D2: 同时清 balance_alert_last_sent_at — 用户充值后如果很快
                // 又花光,提醒应立即可触发,不等 24h cooldown(充完又快花完是真实
                // 风险信号,值得提醒)。
                await tx.user.update({
                    where: { id: userId },
                    data: {
                        newapi_quota_cache: null,
                        newapi_used_quota_cache: null,
                        newapi_cached_at: null,
                        balance_alert_last_sent_at: null,
                    },
                });
            },
            { timeout: 15_000, maxWait: 5_000 },
        );
    } catch (error) {
        // 失败信息记在 Order.failedReason + AuditLog,与现有 RECHARGE_FAILED 流一致。
        // NewApiError.message already includes "new-api {endpoint} {status}: ..."
        // so plain `error.message` is sufficient for both NewApiError and other Error.
        const reason = error instanceof Error ? error.message : String(error);
        await prisma.order.update({
            where: { id: orderId },
            data: {
                status: ORDER_STATUS.FAILED,
                failedAt: new Date(),
                failedReason: reason,
            },
        });

        await prisma.auditLog.create({
            data: {
                orderId,
                action: 'RECHARGE_FAILED',
                detail: reason,
                operator: 'system',
            },
        });

        throw error;
    }
}

function assertRetryAllowed(order: { status: string; paidAt: Date | null }, locale: Locale): void {
    if (!order.paidAt) {
        throw new OrderError(
            'INVALID_STATUS',
            message(locale, '订单未支付，不允许重试', 'Order is not paid, retry denied'),
            400,
        );
    }

    if (isRefundStatus(order.status)) {
        throw new OrderError(
            'INVALID_STATUS',
            message(locale, '退款相关订单不允许重试', 'Refund-related order cannot retry'),
            400,
        );
    }

    if (order.status === ORDER_STATUS.FAILED || order.status === ORDER_STATUS.PAID) {
        return;
    }

    if (order.status === ORDER_STATUS.RECHARGING) {
        throw new OrderError(
            'CONFLICT',
            message(locale, '订单正在充值中，请稍后重试', 'Order is recharging, retry later'),
            409,
        );
    }

    if (order.status === ORDER_STATUS.COMPLETED) {
        throw new OrderError('INVALID_STATUS', message(locale, '订单已完成', 'Order already completed'), 400);
    }

    throw new OrderError(
        'INVALID_STATUS',
        message(locale, '仅已支付和失败订单允许重试', 'Only paid and failed orders can retry'),
        400,
    );
}

export async function retryRecharge(orderId: string, locale: Locale = 'zh'): Promise<void> {
    const order = await prisma.order.findUnique({
        where: { id: orderId },
        select: {
            id: true,
            status: true,
            paidAt: true,
            completedAt: true,
        },
    });

    if (!order) {
        throw new OrderError('NOT_FOUND', message(locale, '订单不存在', 'Order not found'), 404);
    }

    assertRetryAllowed(order, locale);

    const result = await prisma.order.updateMany({
        where: {
            id: orderId,
            status: { in: [ORDER_STATUS.FAILED, ORDER_STATUS.PAID] },
            paidAt: { not: null },
        },
        data: { status: ORDER_STATUS.PAID, failedAt: null, failedReason: null },
    });

    if (result.count === 0) {
        const latest = await prisma.order.findUnique({
            where: { id: orderId },
            select: {
                status: true,
                paidAt: true,
                completedAt: true,
            },
        });

        if (!latest) {
            throw new OrderError('NOT_FOUND', message(locale, '订单不存在', 'Order not found'), 404);
        }

        const derived = deriveOrderState(latest);
        if (derived.rechargeStatus === 'recharging' || latest.status === ORDER_STATUS.PAID) {
            throw new OrderError(
                'CONFLICT',
                message(locale, '订单正在充值中，请稍后重试', 'Order is recharging, retry later'),
                409,
            );
        }

        if (derived.rechargeStatus === 'success') {
            throw new OrderError('INVALID_STATUS', message(locale, '订单已完成', 'Order already completed'), 400);
        }

        if (isRefundStatus(latest.status)) {
            throw new OrderError(
                'INVALID_STATUS',
                message(locale, '退款相关订单不允许重试', 'Refund-related order cannot retry'),
                400,
            );
        }

        throw new OrderError(
            'CONFLICT',
            message(locale, '订单状态已变更，请刷新后重试', 'Order status changed, refresh and retry'),
            409,
        );
    }

    await prisma.auditLog.create({
        data: {
            orderId,
            action: 'RECHARGE_RETRY',
            detail: message(locale, '管理员手动重试充值', 'Admin manual retry recharge'),
            operator: 'admin',
        },
    });

    await executeFulfillment(orderId);
}

export interface RefundRequestInput {
    orderId: string;
    user_id: string | null;
    amount: number;
    reason?: string;
    locale?: Locale;
}

export async function requestRefund(input: RefundRequestInput): Promise<{ success: boolean }> {
    const locale = input.locale ?? 'zh';
    const order = await prisma.order.findUnique({ where: { id: input.orderId } });
    if (!order) throw new OrderError('NOT_FOUND', message(locale, '订单不存在', 'Order not found'), 404);
    if (order.user_id !== input.user_id) {
        throw new OrderError('FORBIDDEN', message(locale, '无权申请该订单退款', 'Forbidden'), 403);
    }
    if (order.orderType !== 'balance') {
        throw new OrderError(
            'INVALID_ORDER_TYPE',
            message(locale, '仅余额充值订单支持退款申请', 'Only balance orders can request refund'),
            400,
        );
    }
    if (order.status !== ORDER_STATUS.COMPLETED) {
        throw new OrderError(
            'INVALID_STATUS',
            message(locale, '仅已完成订单可申请退款', 'Only completed orders can request refund'),
            400,
        );
    }

    const refundAmount = input.amount;
    if (!Number.isFinite(refundAmount) || refundAmount <= 0) {
        throw new OrderError(
            'INVALID_REFUND_AMOUNT',
            message(locale, '退款金额必须大于 0', 'Refund amount must be greater than 0'),
            400,
        );
    }

    const maxRefundAmount = Number(order.amount);
    if (refundAmount > maxRefundAmount) {
        throw new OrderError(
            'REFUND_AMOUNT_EXCEEDED',
            message(locale, '退款金额不能超过充值金额', 'Refund amount cannot exceed recharge amount'),
            400,
        );
    }

    const user = await getUser(order.user_id);
    if (user.balance < refundAmount) {
        throw new OrderError(
            'BALANCE_NOT_ENOUGH',
            message(locale, '退款金额不能超过当前余额', 'Refund amount cannot exceed current balance'),
            400,
        );
    }

    const normalizedReason = input.reason?.trim() || null;

    const updated = await prisma.order.updateMany({
        where: { id: input.orderId, user_id: input.user_id, status: ORDER_STATUS.COMPLETED, orderType: 'balance' },
        data: {
            status: ORDER_STATUS.REFUND_REQUESTED,
            refundRequestedAt: new Date(),
            refundRequestReason: normalizedReason,
            // refundRequestedBy is still Int? in schema (legacy from Sub2API);
            // portal user_id is now a UUID string. Audit trail of who requested
            // is captured in the auditLog `requestedBy` JSON detail below.
            refundRequestedBy: null,
            refundAmount: new Prisma.Decimal(refundAmount.toFixed(2)),
        },
    });

    if (updated.count === 0) {
        throw new OrderError(
            'CONFLICT',
            message(locale, '订单状态已变更，请刷新后重试', 'Order status changed, refresh and retry'),
            409,
        );
    }

    await prisma.auditLog.create({
        data: {
            orderId: input.orderId,
            action: 'REFUND_REQUESTED',
            detail: JSON.stringify({
                amount: refundAmount,
                reason: normalizedReason,
                requestedBy: input.user_id,
            }),
            operator: `user:${input.user_id}`,
        },
    });

    return { success: true };
}

export interface RefundInput {
    orderId: string;
    amount?: number;
    reason?: string;
    force?: boolean;
    deductBalance?: boolean;
    locale?: Locale;
}

export interface RefundResult {
    success: boolean;
    warning?: string;
    requireForce?: boolean;
    balanceDeducted?: number;
    subscriptionDaysDeducted?: number;
}

// ── 退款内部类型与辅助函数 ──

function errorMessage(e: unknown): string {
    return e instanceof Error ? e.message : String(e);
}

interface DeductionPlan {
    type: 'balance' | 'subscription' | 'none';
    balanceAmount: number;
    subscriptionDays: number;
    subscriptionId: number | null;
}

/** 查询用户余额/订阅信息，计算扣减量。返回 DeductionPlan 或提前返回的 RefundResult。 */
async function prepareDeduction(
    order: {
        user_id: string | null;
        orderType: string | null;
        amount: Prisma.Decimal;
        subscriptionGroupId: number | null;
        subscriptionDays: number | null;
    },
    deductBalance: boolean,
    force: boolean,
    locale: Locale,
    overrideAmount?: number,
): Promise<DeductionPlan | RefundResult> {
    if (!deductBalance) return { type: 'none', balanceAmount: 0, subscriptionDays: 0, subscriptionId: null };

    const rechargeAmount = overrideAmount ?? Number(order.amount);

    if (order.orderType === 'subscription') {
        if (!order.subscriptionGroupId || !order.subscriptionDays) {
            return { type: 'subscription', balanceAmount: 0, subscriptionDays: 0, subscriptionId: null };
        }
        try {
            const userSubs = await getUserSubscriptions(order.user_id);
            const activeSub = userSubs.find((s) => s.group_id === order.subscriptionGroupId && s.status === 'active');
            if (!activeSub) {
                return { type: 'subscription', balanceAmount: 0, subscriptionDays: 0, subscriptionId: null };
            }
            const remainingDays = Math.max(
                0,
                Math.ceil((new Date(activeSub.expires_at).getTime() - Date.now()) / (1000 * 60 * 60 * 24)),
            );
            return {
                type: 'subscription',
                balanceAmount: 0,
                subscriptionDays: Math.min(order.subscriptionDays, remainingDays),
                subscriptionId: activeSub.id,
            };
        } catch {
            if (!force) {
                return {
                    success: false,
                    warning: message(
                        locale,
                        '无法获取订阅信息，请勾选强制退款',
                        'Cannot fetch subscription info, use force',
                    ),
                    requireForce: true,
                };
            }
            return { type: 'subscription', balanceAmount: 0, subscriptionDays: 0, subscriptionId: null };
        }
    }

    // 余额订单
    try {
        const user = await getUser(order.user_id);
        return {
            type: 'balance',
            balanceAmount: Math.min(rechargeAmount, user.balance),
            subscriptionDays: 0,
            subscriptionId: null,
        };
    } catch {
        if (!force) {
            return {
                success: false,
                warning: message(locale, '无法获取用户余额，请勾选强制退款', 'Cannot fetch user balance, use force'),
                requireForce: true,
            };
        }
        return { type: 'balance', balanceAmount: 0, subscriptionDays: 0, subscriptionId: null };
    }
}

function isDeductionPlan(v: DeductionPlan | RefundResult): v is DeductionPlan {
    return 'type' in v;
}

/** 执行扣减（先扣后退的"扣"步骤） */
async function executeDeduction(orderId: string, user_id: string | null, plan: DeductionPlan): Promise<void> {
    const ts = Date.now();
    if (plan.type === 'subscription' && plan.subscriptionId && plan.subscriptionDays > 0) {
        await extendSubscription(plan.subscriptionId, -plan.subscriptionDays, `sub2apipay:refund-sub:${orderId}:${ts}`);
    } else if (plan.type === 'balance' && plan.balanceAmount > 0) {
        await subtractBalance(
            user_id,
            plan.balanceAmount,
            `sub2apipay refund order:${orderId}`,
            `sub2apipay:refund:${orderId}:${ts}`,
        );
    }
}

/** 回滚已扣减的余额/订阅。返回 true 表示回滚成功，false 表示回滚也失败。 */
async function rollbackDeduction(
    orderId: string,
    user_id: string | null,
    plan: DeductionPlan,
    gatewayError: unknown,
): Promise<boolean> {
    const ts = Date.now();
    if (plan.type === 'subscription' && plan.subscriptionId && plan.subscriptionDays > 0) {
        try {
            await extendSubscription(
                plan.subscriptionId,
                plan.subscriptionDays,
                `sub2apipay:refund-sub-rollback:${orderId}:${ts}`,
            );
            return true;
        } catch (rollbackError) {
            console.error(
                `[CRITICAL] Subscription rollback failed for order ${orderId}: ${plan.subscriptionDays} days deducted but gateway refund failed. Manual intervention required.`,
            );
            await prisma.auditLog.create({
                data: {
                    orderId,
                    action: 'REFUND_ROLLBACK_FAILED',
                    detail: JSON.stringify({
                        gatewayError: errorMessage(gatewayError),
                        rollbackError: errorMessage(rollbackError),
                        subscriptionDaysDeducted: plan.subscriptionDays,
                    }),
                    operator: 'admin',
                },
            });
            return false;
        }
    }

    if (plan.type === 'balance' && plan.balanceAmount > 0) {
        try {
            await addBalance(
                user_id,
                plan.balanceAmount,
                `sub2apipay refund rollback order:${orderId}`,
                `sub2apipay:refund-rollback:${orderId}:${ts}`,
            );
            return true;
        } catch (rollbackError) {
            console.error(
                `[CRITICAL] Refund rollback failed for order ${orderId}: balance deducted ${plan.balanceAmount} but gateway refund and balance restoration both failed. Manual intervention required.`,
            );
            await prisma.auditLog.create({
                data: {
                    orderId,
                    action: 'REFUND_ROLLBACK_FAILED',
                    detail: JSON.stringify({
                        gatewayError: errorMessage(gatewayError),
                        rollbackError: errorMessage(rollbackError),
                        balanceDeducted: plan.balanceAmount,
                        needsBalanceCompensation: true,
                    }),
                    operator: 'admin',
                },
            });
            return false;
        }
    }

    // 无需回滚（未执行扣减）
    return true;
}

// ── processRefund 主流程 ──

export async function processRefund(input: RefundInput): Promise<RefundResult> {
    const locale = input.locale ?? 'zh';
    const deductBalance = input.deductBalance ?? true;
    const order = await prisma.order.findUnique({ where: { id: input.orderId } });
    if (!order) throw new OrderError('NOT_FOUND', message(locale, '订单不存在', 'Order not found'), 404);

    const allowedStatuses = [ORDER_STATUS.COMPLETED, ORDER_STATUS.REFUND_REQUESTED, ORDER_STATUS.REFUND_FAILED];
    if (!allowedStatuses.includes(order.status as (typeof allowedStatuses)[number])) {
        throw new OrderError(
            'INVALID_STATUS',
            message(
                locale,
                '仅已完成、已申请退款或退款失败的订单允许退款',
                'Only completed, refund-requested, or refund-failed orders can be refunded',
            ),
            400,
        );
    }

    const rechargeAmount = Number(order.amount);
    const maxGatewayRefund = Number(order.payAmount ?? order.amount);

    // 部分退款支持：优先使用传入金额，否则全额
    const refundAmount = input.amount ?? rechargeAmount;
    if (!Number.isFinite(refundAmount) || refundAmount <= 0) {
        throw new OrderError(
            'INVALID_REFUND_AMOUNT',
            message(locale, '退款金额必须大于 0', 'Refund amount must be greater than 0'),
            400,
        );
    }
    if (refundAmount > rechargeAmount) {
        throw new OrderError(
            'REFUND_AMOUNT_EXCEEDED',
            message(locale, '退款金额不能超过充值金额', 'Refund amount cannot exceed recharge amount'),
            400,
        );
    }

    // 网关退款金额：部分退款时用 refundAmount，全额时用 payAmount
    const gatewayRefundAmount = input.amount ?? maxGatewayRefund;
    const refundReason =
        input.reason?.trim() || order.refundRequestReason?.trim() || `sub2apipay refund order:${order.id}`;

    // 1. 准备扣减计划（可能提前返回 requireForce）
    const planOrResult = await prepareDeduction(order, deductBalance, input.force ?? false, locale, input.amount);
    if (!isDeductionPlan(planOrResult)) return planOrResult;
    const plan = planOrResult;

    // 2. CAS 乐观锁
    const lockResult = await prisma.order.updateMany({
        where: {
            id: input.orderId,
            status: { in: [ORDER_STATUS.COMPLETED, ORDER_STATUS.REFUND_REQUESTED, ORDER_STATUS.REFUND_FAILED] },
        },
        data: { status: ORDER_STATUS.REFUNDING },
    });
    if (lockResult.count === 0) {
        throw new OrderError(
            'CONFLICT',
            message(locale, '订单状态已变更，请刷新后重试', 'Order status changed, refresh and retry'),
            409,
        );
    }

    try {
        // 3. 执行扣减（安全方向：先扣后退）
        await executeDeduction(order.id, order.user_id, plan);

        // 4. 调用支付网关退款
        if (order.paymentTradeNo) {
            let provider;
            if (order.providerInstanceId) {
                const instConfig = await getInstanceConfig(order.providerInstanceId);
                if (instConfig) {
                    const { EasyPayProvider } = await import('@/lib/easy-pay/provider');
                    provider = new EasyPayProvider(order.providerInstanceId, instConfig);
                }
            }
            if (!provider) {
                await ensureDBProviders();
                provider = paymentRegistry.getProvider(order.paymentType as PaymentType);
            }

            try {
                await provider.refund({
                    tradeNo: order.paymentTradeNo,
                    orderId: order.id,
                    amount: gatewayRefundAmount,
                    reason: refundReason,
                });
            } catch (gatewayError) {
                // 网关退款失败 — 回滚扣减
                const rollbackOk = await rollbackDeduction(input.orderId, order.user_id, plan, gatewayError);

                if (rollbackOk) {
                    // 回滚成功 — 恢复原状态，返回失败结果（不 throw）
                    const restoreStatus =
                        order.status === ORDER_STATUS.REFUND_REQUESTED
                            ? ORDER_STATUS.REFUND_REQUESTED
                            : ORDER_STATUS.COMPLETED;
                    await prisma.order.update({ where: { id: input.orderId }, data: { status: restoreStatus } });
                    await prisma.auditLog.create({
                        data: {
                            orderId: input.orderId,
                            action: 'REFUND_GATEWAY_FAILED',
                            detail: `Gateway refund failed, deduction rolled back: ${errorMessage(gatewayError)}`,
                            operator: 'admin',
                        },
                    });
                    return {
                        success: false,
                        warning: message(
                            locale,
                            `支付网关退款失败：${errorMessage(gatewayError)}，已回滚扣减`,
                            `Gateway refund failed: ${errorMessage(gatewayError)}, deduction rolled back`,
                        ),
                    };
                }

                // 回滚失败 — 标记 REFUND_FAILED，需人工介入
                await prisma.order.update({
                    where: { id: input.orderId },
                    data: {
                        status: ORDER_STATUS.REFUND_FAILED,
                        failedAt: new Date(),
                        failedReason: errorMessage(gatewayError),
                    },
                });
                await prisma.auditLog.create({
                    data: {
                        orderId: input.orderId,
                        action: 'REFUND_FAILED',
                        detail: `Gateway refund failed and rollback also failed: ${errorMessage(gatewayError)}`,
                        operator: 'admin',
                    },
                });
                throw new OrderError('REFUND_FAILED', errorMessage(gatewayError), 500);
            }
        } else {
            await prisma.auditLog.create({
                data: {
                    orderId: input.orderId,
                    action: 'REFUND_NO_TRADE_NO',
                    detail: 'No paymentTradeNo, skipped gateway refund',
                    operator: 'admin',
                },
            });
        }

        // 5. 标记退款成功（部分/全额）
        const finalStatus = refundAmount < rechargeAmount ? ORDER_STATUS.PARTIALLY_REFUNDED : ORDER_STATUS.REFUNDED;

        await prisma.order.update({
            where: { id: input.orderId },
            data: {
                status: finalStatus,
                refundAmount: new Prisma.Decimal(refundAmount.toFixed(2)),
                refundReason: refundReason,
                refundAt: new Date(),
                forceRefund: input.force || false,
            },
        });

        await prisma.auditLog.create({
            data: {
                orderId: input.orderId,
                action: finalStatus === ORDER_STATUS.PARTIALLY_REFUNDED ? 'PARTIAL_REFUND_SUCCESS' : 'REFUND_SUCCESS',
                detail: JSON.stringify({
                    rechargeAmount,
                    refundAmount,
                    gatewayRefundAmount,
                    reason: refundReason,
                    force: input.force,
                    deductBalance,
                    balanceDeducted: plan.balanceAmount,
                    subscriptionDaysDeducted: plan.subscriptionDays,
                }),
                operator: 'admin',
            },
        });

        return { success: true, balanceDeducted: plan.balanceAmount, subscriptionDaysDeducted: plan.subscriptionDays };
    } catch (error) {
        // 未被内部处理的异常（如扣减阶段失败）— 标记 REFUND_FAILED
        if (!(error instanceof OrderError && error.code === 'REFUND_FAILED')) {
            await prisma.order.update({
                where: { id: input.orderId },
                data: { status: ORDER_STATUS.REFUND_FAILED, failedAt: new Date(), failedReason: errorMessage(error) },
            });
            await prisma.auditLog.create({
                data: {
                    orderId: input.orderId,
                    action: 'REFUND_FAILED',
                    detail: errorMessage(error),
                    operator: 'admin',
                },
            });
        }
        throw error;
    }
}

export class OrderError extends Error {
    code: string;
    statusCode: number;
    data?: Record<string, unknown>;

    constructor(code: string, message: string, statusCode: number = 400, data?: Record<string, unknown>) {
        super(message);
        this.name = 'OrderError';
        this.code = code;
        this.statusCode = statusCode;
        this.data = data;
    }
}
