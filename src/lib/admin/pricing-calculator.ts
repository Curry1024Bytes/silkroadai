/**
 * Pure pricing calculator for operators.
 *
 * The calculator treats the upstream credit exchange as an explicit business
 * input: `upstreamCreditsPerCny = 10` means ¥1 buys $10 of upstream credit.
 * It never writes Portal or new-api state.
 */

export interface CalculatorTokenPrices {
    inputUsdPer1m: number;
    outputUsdPer1m: number;
    cacheReadUsdPer1m: number;
    cacheWriteUsdPer1m: number;
}

export interface CalculatorTokens {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
}

export interface PricingCalculatorInput {
    upstreamCreditsPerCny: number;
    upstreamChannelRatio: number;
    official: CalculatorTokenPrices;
    markupRate: number;
    groupRatio: number;
    portalChatFxCnyPer1mQuota: number;
    quotaPerUsd: number;
    sample?: CalculatorTokens;
}

export interface CalculatorMoney {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    total: number;
}

export interface PricingCalculatorResult {
    upstreamCostCnyPer1m: CalculatorMoney;
    retailCnyPer1m: CalculatorMoney;
    profitCnyPer1m: CalculatorMoney;
    ratios: {
        modelRatio: number;
        completionRatio: number;
        cacheRatio: number;
        createCacheRatio: number;
    };
    sample?: {
        upstreamCostCny: number;
        retailCny: number;
        profitCny: number;
        marginRate: number;
        technicalUnit: number;
        quota: number;
    };
}

function round(value: number, digits = 6): number {
    const factor = 10 ** digits;
    return Math.round((value + Number.EPSILON) * factor) / factor;
}

function requirePositive(name: string, value: number): void {
    if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be greater than zero`);
}

function requireNonNegative(name: string, value: number): void {
    if (!Number.isFinite(value) || value < 0) throw new Error(`${name} must not be negative`);
}

export function calculatePricing(input: PricingCalculatorInput): PricingCalculatorResult {
    requirePositive('upstreamCreditsPerCny', input.upstreamCreditsPerCny);
    requirePositive('upstreamChannelRatio', input.upstreamChannelRatio);
    requirePositive('official input price', input.official.inputUsdPer1m);
    requirePositive('official output price', input.official.outputUsdPer1m);
    requireNonNegative('official cache read price', input.official.cacheReadUsdPer1m);
    requireNonNegative('official cache write price', input.official.cacheWriteUsdPer1m);
    requireNonNegative('markupRate', input.markupRate);
    requirePositive('groupRatio', input.groupRatio);
    requirePositive('portalChatFxCnyPer1mQuota', input.portalChatFxCnyPer1mQuota);
    requirePositive('quotaPerUsd', input.quotaPerUsd);

    const cost = (usd: number) => (usd * input.upstreamChannelRatio) / input.upstreamCreditsPerCny;
    const upstreamCostCnyPer1m: CalculatorMoney = {
        input: cost(input.official.inputUsdPer1m),
        output: cost(input.official.outputUsdPer1m),
        cacheRead: cost(input.official.cacheReadUsdPer1m),
        cacheWrite: cost(input.official.cacheWriteUsdPer1m),
        total: 0,
    };
    upstreamCostCnyPer1m.total =
        upstreamCostCnyPer1m.input +
        upstreamCostCnyPer1m.output +
        upstreamCostCnyPer1m.cacheRead +
        upstreamCostCnyPer1m.cacheWrite;

    const retailCnyPer1m: CalculatorMoney = {
        input: upstreamCostCnyPer1m.input * (1 + input.markupRate),
        output: upstreamCostCnyPer1m.output * (1 + input.markupRate),
        cacheRead: upstreamCostCnyPer1m.cacheRead * (1 + input.markupRate),
        cacheWrite: upstreamCostCnyPer1m.cacheWrite * (1 + input.markupRate),
        total: 0,
    };
    retailCnyPer1m.total =
        retailCnyPer1m.input + retailCnyPer1m.output + retailCnyPer1m.cacheRead + retailCnyPer1m.cacheWrite;

    const profitCnyPer1m: CalculatorMoney = {
        input: retailCnyPer1m.input - upstreamCostCnyPer1m.input,
        output: retailCnyPer1m.output - upstreamCostCnyPer1m.output,
        cacheRead: retailCnyPer1m.cacheRead - upstreamCostCnyPer1m.cacheRead,
        cacheWrite: retailCnyPer1m.cacheWrite - upstreamCostCnyPer1m.cacheWrite,
        total: retailCnyPer1m.total - upstreamCostCnyPer1m.total,
    };

    const ratios = {
        // Must match pricing-sync.ts: retail = CHAT_FX × ModelRatio × GroupRatio.
        modelRatio: round(retailCnyPer1m.input / (input.portalChatFxCnyPer1mQuota * input.groupRatio)),
        completionRatio: round(retailCnyPer1m.output / retailCnyPer1m.input, 4),
        cacheRatio: round(retailCnyPer1m.cacheRead / retailCnyPer1m.input),
        createCacheRatio: round(retailCnyPer1m.cacheWrite / retailCnyPer1m.input),
    };

    let sample: PricingCalculatorResult['sample'];
    if (input.sample) {
        for (const [name, value] of Object.entries(input.sample)) requireNonNegative(`sample ${name}`, value);
        const sampleCost =
            (input.sample.input * upstreamCostCnyPer1m.input +
                input.sample.output * upstreamCostCnyPer1m.output +
                input.sample.cacheRead * upstreamCostCnyPer1m.cacheRead +
                input.sample.cacheWrite * upstreamCostCnyPer1m.cacheWrite) /
            1_000_000;
        const sampleRetail =
            (input.sample.input * retailCnyPer1m.input +
                input.sample.output * retailCnyPer1m.output +
                input.sample.cacheRead * retailCnyPer1m.cacheRead +
                input.sample.cacheWrite * retailCnyPer1m.cacheWrite) /
            1_000_000;
        // portalChatFxCnyPer1mQuota is the CNY value of 1M raw quota. Convert
        // the request charge back to raw quota first, then express it in
        // new-api technical billing units (QuotaPerUnit). The old formula
        // skipped the 1M-quota scale and therefore under-reported both values.
        const rawQuota = (sampleRetail / input.portalChatFxCnyPer1mQuota) * 1_000_000;
        sample = {
            upstreamCostCny: sampleCost,
            retailCny: sampleRetail,
            profitCny: sampleRetail - sampleCost,
            marginRate: sampleRetail > 0 ? (sampleRetail - sampleCost) / sampleRetail : 0,
            technicalUnit: rawQuota / input.quotaPerUsd,
            quota: Math.round(rawQuota),
        };
    }

    return { upstreamCostCnyPer1m, retailCnyPer1m, profitCnyPer1m, ratios, sample };
}
