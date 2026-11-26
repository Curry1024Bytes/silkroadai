import { describe, expect, it, vi } from 'vitest';
import { buildActualMargin, type MarginCost, type MarginEvent, type MarginTask } from '@/lib/billing/actual-margin';
import { marginImportSchema } from '@/lib/billing/margin-import';

vi.mock('@/lib/newapi/quota-units', () => ({ QUOTA_PER_USD: 500_000, USD_TO_CNY_RATE: 1 }));

const event = (id: number, rest: Partial<MarginEvent> = {}): MarginEvent => ({
    id: String(id),
    user_id: '10',
    created_at: '120',
    type: '2',
    channel_id: '24',
    channel_name: '官转',
    group_name: 'SD官转',
    model_name: 'doubao-seedance-2-0-260128',
    quota: '0',
    request_id: null,
    upstream_request_id: null,
    task_id: null,
    is_task: false,
    ...rest,
});
const task = (id: string, rest: Partial<MarginTask> = {}): MarginTask => ({
    task_id: id,
    user_id: '10',
    channel_id: '24',
    submit_time: '120',
    finish_time: '150',
    first_charge_at: '120',
    last_charge_at: '150',
    status: 'SUCCESS',
    upstream_task_id: 'supplier-' + id,
    ...rest,
});
const cost = (id: string, amount: string, rest: Partial<MarginCost> = {}): MarginCost => ({
    channel_id: 24,
    reference_kind: 'task',
    reference_id: id,
    status: 'verified',
    amount,
    cny_per_unit: '1',
    ...rest,
});
const run = (events: MarginEvent[], tasks: MarginTask[], costs: MarginCost[]) =>
    buildActualMargin(events, tasks, costs, 100, 200, { activeModels: [{ model: 'new-model', name: '新模型' }] });

describe('actual margin', () => {
    it('reproduces the six verified SD invoices as six settlements', () => {
        const net = [6359220, 6359220, 6359220, 4242420, 5089140, 5089140];
        const amounts = ['13.6269', '13.6269', '13.6269', '9.0909', '10.9053', '10.9053'];
        const refs = net.map((_, i) => String(i));
        const events = net.flatMap((quota, i) => [
            event(i * 2, { task_id: refs[i], quota: '1000000' }),
            event(i * 2 + 1, { task_id: refs[i], quota: String(quota - 1000000), created_at: '150' }),
        ]);
        const report = run(
            events,
            refs.map((id) => task(id)),
            amounts.map((amount, i) => cost('supplier-' + refs[i], amount)),
        );
        expect(report.summary).toMatchObject({
            calls: 6,
            verifiedCalls: 6,
            netCny: '66.99672',
            verifiedCostCny: '71.7822',
            profitCny: '-4.78548',
            marginPct: '-7.1429',
        });
        expect(report.models.find((model) => model.model === 'new-model')?.calls).toBe(0);
    });

    it('subtracts refunds, charges paid failures, and uses the same revenue population for verified margins', () => {
        const events = [
            event(1, { task_id: 'fail', quota: '4000000' }),
            event(2, { task_id: 'fail', type: '6', quota: '4000000' }),
            event(3, { model_name: 'text', request_id: 'text-request', quota: '1000000' }),
            event(4, { model_name: 'image', request_id: 'image-request', quota: '1000000' }),
        ];
        const costs = [
            cost('supplier-fail', '1'),
            cost('image-request', '5', { reference_kind: 'request', status: 'estimated', cny_per_unit: '0.1' }),
        ];
        const report = run(events, [task('fail', { status: 'FAILURE' })], costs);
        expect(report.summary).toMatchObject({
            netCny: '4',
            verifiedNetCny: '0',
            verifiedCostCny: '1',
            profitCny: '-1',
            marginPct: null,
            pendingNetCny: '2',
            pendingCalls: 1,
            estimatedCostCny: '0.5',
            estimatedProfitCny: '1.5',
        });
    });

    it('keeps cross-period, ambiguous and refund-only costs pending', () => {
        const events = [
            event(1, { task_id: 'ongoing', quota: '500000' }),
            event(2, { request_id: 'refund-only', type: '6', quota: '250000' }),
            event(3, { request_id: 'collision', upstream_request_id: 'shared', quota: '500000' }),
            event(4, { request_id: 'another', upstream_request_id: 'shared', quota: '500000' }),
        ];
        const costs = [
            cost('supplier-ongoing', '1'),
            cost('refund-only', '1', { reference_kind: 'request' }),
            cost('shared', '1', { reference_kind: 'upstream' }),
        ];
        const report = run(events, [task('ongoing', { last_charge_at: '250' })], costs);
        expect(report.summary).toMatchObject({
            calls: 4,
            verifiedCalls: 0,
            netCny: '2.5',
            pendingCalls: 4,
            verifiedCostCny: null,
            profitCny: null,
        });
    });
});

it('validates invoice pricing units and numeric strings', () => {
    const row = {
        channel_id: 2,
        reference_kind: 'upstream',
        reference_id: 'example-1234',
        amount: '1.23456789',
        currency: 'USD',
        cny_per_unit: '0.1',
        status: 'verified',
        evidence: 'invoice-1',
    };
    expect(marginImportSchema.safeParse({ entries: [row] }).success).toBe(true);
    expect(marginImportSchema.safeParse({ entries: [{ ...row, currency: 'CNY' }] }).success).toBe(false);
    expect(marginImportSchema.safeParse({ entries: [{ ...row, amount: '1e-4' }] }).success).toBe(false);
});
