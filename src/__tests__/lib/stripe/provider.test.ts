import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/config', () => ({
    getEnv: () => ({
        STRIPE_SECRET_KEY: 'sk_test_fake_key',
        STRIPE_WEBHOOK_SECRET: 'whsec_test_fake_secret',
        NEXT_PUBLIC_APP_URL: 'https://pay.example.com',
        ORDER_TIMEOUT_MINUTES: 5,
    }),
}));

const mockPaymentIntentCreate = vi.fn();
const mockPaymentIntentRetrieve = vi.fn();
const mockPaymentIntentCancel = vi.fn();
const mockRefundCreate = vi.fn();
const mockWebhooksConstructEvent = vi.fn();

vi.mock('stripe', () => {
    const StripeMock = function (this: Record<string, unknown>) {
        this.paymentIntents = {
            create: mockPaymentIntentCreate,
            retrieve: mockPaymentIntentRetrieve,
            cancel: mockPaymentIntentCancel,
        };
        this.refunds = {
            create: mockRefundCreate,
        };
        this.webhooks = {
            constructEvent: mockWebhooksConstructEvent,
        };
    };
    return { default: StripeMock };
});

import { StripeProvider } from '@/lib/stripe/provider';
import type { CreatePaymentRequest, RefundRequest } from '@/lib/payment/types';

describe('StripeProvider', () => {
    let provider: StripeProvider;

    beforeEach(() => {
        vi.clearAllMocks();
        provider = new StripeProvider();
    });

    describe('metadata', () => {
        it('should have name "stripe"', () => {
            expect(provider.name).toBe('stripe');
        });

        it('should support "stripe" payment type', () => {
            expect(provider.supportedTypes).toEqual(['stripe']);
        });
    });

    describe('createPayment', () => {
        it('should create a PaymentIntent and return clientSecret', async () => {
            mockPaymentIntentCreate.mockResolvedValue({
                id: 'pi_test_abc123',
                client_secret: 'pi_test_abc123_secret_xyz',
            });

            const request: CreatePaymentRequest = {
                orderId: 'order-001',
                amount: 99.99,
                paymentType: 'stripe',
                subject: 'Sub2API Balance Recharge 99.99 CNY',
                clientIp: '127.0.0.1',
            };

            const result = await provider.createPayment(request);

            expect(result.tradeNo).toBe('pi_test_abc123');
            expect(result.clientSecret).toBe('pi_test_abc123_secret_xyz');
            expect(mockPaymentIntentCreate).toHaveBeenCalledWith(
                expect.objectContaining({
                    amount: 9999,
                    currency: 'cny',
                    automatic_payment_methods: { enabled: true },
                    metadata: { orderId: 'order-001' },
                    description: 'Sub2API Balance Recharge 99.99 CNY',
                }),
                expect.objectContaining({
                    idempotencyKey: 'pi-order-001',
                }),
            );
        });

        it('should handle null client_secret', async () => {
            mockPaymentIntentCreate.mockResolvedValue({
                id: 'pi_test_no_secret',
                client_secret: null,
            });

            const request: CreatePaymentRequest = {
                orderId: 'order-002',
                amount: 10,
                paymentType: 'stripe',
                subject: 'Test',
            };

            const result = await provider.createPayment(request);
            expect(result.tradeNo).toBe('pi_test_no_secret');
            expect(result.clientSecret).toBeUndefined();
        });
    });

    describe('queryOrder', () => {
        it('should return paid status for succeeded PaymentIntent', async () => {
            mockPaymentIntentRetrieve.mockResolvedValue({
                id: 'pi_test_abc123',
                status: 'succeeded',
                amount: 9999,
            });

            const result = await provider.queryOrder('pi_test_abc123');
            expect(result.tradeNo).toBe('pi_test_abc123');
            expect(result.status).toBe('paid');
            expect(result.amount).toBe(99.99);
        });

        it('should return failed status for canceled PaymentIntent', async () => {
            mockPaymentIntentRetrieve.mockResolvedValue({
                id: 'pi_test_canceled',
                status: 'canceled',
                amount: 5000,
            });

            const result = await provider.queryOrder('pi_test_canceled');
            expect(result.status).toBe('failed');
            expect(result.amount).toBe(50);
        });

        it('should return pending status for requires_payment_method', async () => {
            mockPaymentIntentRetrieve.mockResolvedValue({
                id: 'pi_test_pending',
                status: 'requires_payment_method',
                amount: 1000,
            });

            const result = await provider.queryOrder('pi_test_pending');
            expect(result.status).toBe('pending');
        });
    });

    describe('verifyNotification', () => {
        it('should verify and parse payment_intent.succeeded event', async () => {
            const mockEvent = {
                type: 'payment_intent.succeeded',
                data: {
                    object: {
                        id: 'pi_test_abc123',
                        metadata: { orderId: 'order-001' },
                        amount: 9999,
                    },
                },
            };

            mockWebhooksConstructEvent.mockReturnValue(mockEvent);

            const result = await provider.verifyNotification('{"raw":"body"}', { 'stripe-signature': 'sig_test_123' });

            expect(result).not.toBeNull();
            expect(result!.tradeNo).toBe('pi_test_abc123');
            expect(result!.orderId).toBe('order-001');
            expect(result!.amount).toBe(99.99);
            expect(result!.status).toBe('success');
        });

        it('should return failed status for payment_intent.payment_failed', async () => {
            const mockEvent = {
                type: 'payment_intent.payment_failed',
                data: {
                    object: {
                        id: 'pi_test_failed',
                        metadata: { orderId: 'order-002' },
                        amount: 5000,
                    },
                },
            };

            mockWebhooksConstructEvent.mockReturnValue(mockEvent);

            const result = await provider.verifyNotification('body', { 'stripe-signature': 'sig' });
            expect(result).not.toBeNull();
            expect(result!.status).toBe('failed');
        });

        it('should return null for unhandled event types', async () => {
            mockWebhooksConstructEvent.mockReturnValue({
                type: 'payment_intent.created',
                data: { object: {} },
            });

            const result = await provider.verifyNotification('body', { 'stripe-signature': 'sig' });
            expect(result).toBeNull();
        });
    });

    describe('refund', () => {
        it('should refund directly using PaymentIntent ID', async () => {
            mockRefundCreate.mockResolvedValue({
                id: 're_test_refund_001',
                status: 'succeeded',
            });

            const request: RefundRequest = {
                tradeNo: 'pi_test_abc123',
                orderId: 'order-001',
                amount: 50,
                reason: 'customer request',
            };

            const result = await provider.refund(request);
            expect(result.refundId).toBe('re_test_refund_001');
            expect(result.status).toBe('success');
            expect(mockRefundCreate).toHaveBeenCalledWith({
                payment_intent: 'pi_test_abc123',
                amount: 5000,
                reason: 'requested_by_customer',
            });
        });

        it('should handle pending refund status', async () => {
            mockRefundCreate.mockResolvedValue({
                id: 're_test_refund_002',
                status: 'pending',
            });

            const result = await provider.refund({
                tradeNo: 'pi_test_abc123',
                orderId: 'order-002',
                amount: 100,
            });

            expect(result.status).toBe('pending');
        });
    });

    describe('cancelPayment', () => {
        it('should cancel a PaymentIntent', async () => {
            mockPaymentIntentCancel.mockResolvedValue({ id: 'pi_test_abc123', status: 'canceled' });

            await provider.cancelPayment('pi_test_abc123');
            expect(mockPaymentIntentCancel).toHaveBeenCalledWith('pi_test_abc123');
        });
    });
});
