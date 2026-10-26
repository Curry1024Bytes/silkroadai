import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockReconcile = vi.fn();
vi.mock('@/lib/newapi/customer-ratio', () => ({ reconcileCustomerRatios: (...a: unknown[]) => mockReconcile(...a) }));
const mockCapture = vi.fn();
vi.mock('@sentry/nextjs', () => ({ captureMessage: (...a: unknown[]) => mockCapture(...a) }));

import { runRatioReconcile } from '../ratio-reconcile';

beforeEach(() => {
    vi.clearAllMocks();
});

describe('runRatioReconcile', () => {
    it('quiet when in sync', async () => {
        mockReconcile.mockResolvedValue({ checked: 3, drifts: [] });
        const r = await runRatioReconcile();
        expect(r).toEqual({ checked: 3, drifts: 0 });
        expect(mockCapture).not.toHaveBeenCalled();
    });
    it('reports drift to Sentry with details', async () => {
        const drifts = [{ userId: 'u-1', newapiUsername: 'c-x', detail: ['矩阵缺 oai image 2(期望 1.7)'] }];
        mockReconcile.mockResolvedValue({ checked: 1, drifts });
        const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
        const r = await runRatioReconcile();
        expect(r.drifts).toBe(1);
        expect(mockCapture).toHaveBeenCalledWith(
            'customer special-ratio drift',
            expect.objectContaining({ level: 'error', extra: { drifts } }),
        );
        spy.mockRestore();
    });
});
