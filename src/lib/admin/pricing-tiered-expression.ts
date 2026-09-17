/**
 * A deliberately small, non-evaluating reader for new-api's v1 token expressions.
 * Coefficients are nominal USD per million tokens, before new-api's group ratio,
 * quota conversion and scheduled discounts. A selected tier prices the whole
 * request; it is not a marginal/slab charge. No new-api source is copied here.
 */
export interface TieredPricingRates {
    input: number;
    output: number;
    cache_read: number | null;
    cache_write: number | null;
    cache_write_1h: number | null;
}

export interface TieredPricingTier {
    name: string;
    min_input_tokens: number | null;
    max_input_tokens: number | null;
    min_inclusive: boolean;
    max_inclusive: boolean;
    rates: TieredPricingRates;
}

export type TieredPricingVariable = 'p' | 'c' | 'cr' | 'cc' | 'cc1h';

export interface ParsedTieredPricingExpression {
    version: 1;
    unit: 'usd_per_million_tokens';
    semantics: 'whole_request';
    /** `len` is full input length, including cached input, before cache exclusion. */
    input_length: 'full_input_tokens';
    /** A cache variable present in any branch affects normalization in all branches. */
    cache_normalization: 'expression_wide';
    used_variables: TieredPricingVariable[];
    tiers: TieredPricingTier[];
}

export type TieredPricingExpressionErrorCode =
    | 'pricing_tiered_expression_unsupported'
    | 'pricing_tiered_expression_invalid'
    | 'pricing_tiered_expression_scale'
    | 'pricing_tiered_expression_precision';

export class TieredPricingExpressionError extends Error {
    constructor(
        public readonly code: TieredPricingExpressionErrorCode,
        message: string,
    ) {
        super(message);
        this.name = 'TieredPricingExpressionError';
    }
}

const MAX_EXPRESSION_LENGTH = 16_384;
const MAX_TOKENS = 2_048;
const MAX_TIERS = 32;
const MAX_DEPTH = 64;
const DECIMAL_PLACES = 12;
const VARIABLES = ['p', 'c', 'cr', 'cc', 'cc1h'] as const;
const RATE_KEYS = {
    p: 'input',
    c: 'output',
    cr: 'cache_read',
    cc: 'cache_write',
    cc1h: 'cache_write_1h',
} as const;
const ZERO = BigInt(0);
const ONE = BigInt(1);
const TEN = BigInt(10);

interface Token {
    kind: 'identifier' | 'number' | 'name' | 'symbol';
    text: string;
    start: number;
    end: number;
}
interface PriceSpan {
    start: number;
    end: number;
    literal: string;
    variable: TieredPricingVariable;
}
interface RawTier {
    name: string;
    maximum: { tokens: number; inclusive: boolean } | null;
    rates: TieredPricingRates;
}
interface Rational {
    n: bigint;
    d: bigint;
}

function unsupported(message = '仅支持按完整输入长度分档的线性 Token 计费表达式。'): never {
    throw new TieredPricingExpressionError('pricing_tiered_expression_unsupported', message);
}

function invalid(message: string): never {
    throw new TieredPricingExpressionError('pricing_tiered_expression_invalid', message);
}

function reduce(n: bigint, d: bigint): Rational {
    let a = n;
    let b = d;
    while (b !== ZERO) [a, b] = [b, a % b];
    const divisor = a === ZERO ? ONE : a;
    return { n: n / divisor, d: d / divisor };
}

function decimal(literal: string): Rational {
    const [coefficient, exponentText = '0'] = literal.toLowerCase().split('e');
    const [whole, digits = ''] = coefficient.split('.');
    const exponent = Number(exponentText) - digits.length;
    const n = BigInt(whole + digits);
    return exponent >= 0 ? reduce(n * TEN ** BigInt(exponent), ONE) : reduce(n, TEN ** BigInt(-exponent));
}

function readPrice(token: Token): number {
    const value = Number(token.text);
    const exponentText = token.text.toLowerCase().split('e')[1];
    if (
        token.text.length > 80 ||
        (exponentText !== undefined && Math.abs(Number(exponentText)) > 308) ||
        !Number.isFinite(value) ||
        value < 0 ||
        value > Number.MAX_SAFE_INTEGER
    ) {
        invalid('表达式单价超出可安全表示的范围。');
    }
    const exact = decimal(token.text);
    const displayed = decimal(String(value));
    if (exact.n * displayed.d !== displayed.n * exact.d) {
        invalid('表达式单价不能无损转换为展示数值。');
    }
    return value;
}

function tokenize(expression: string): Token[] {
    if (typeof expression !== 'string' || expression.length === 0 || expression.length > MAX_EXPRESSION_LENGTH) {
        invalid('表达式为空或超过长度限制。');
    }
    const tokens: Token[] = [];
    let position = expression.startsWith('v1:') ? 3 : 0;
    while (position < expression.length) {
        const char = expression[position];
        if (/[ \t\r\n]/.test(char)) {
            position++;
            continue;
        }
        const rest = expression.slice(position);
        let text: string;
        let kind: Token['kind'];
        const identifier = /^[A-Za-z_][A-Za-z0-9_]*/.exec(rest);
        const number = /^(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(rest);
        if (identifier) {
            text = identifier[0];
            kind = 'identifier';
        } else if (number) {
            text = number[0];
            kind = 'number';
        } else if (char === '"') {
            const name = /^"[A-Za-z0-9][A-Za-z0-9_. -]{0,63}"/.exec(rest);
            if (!name) unsupported('档位名称须为不含转义符的简短字母、数字、空格或 ._-。');
            text = name[0];
            kind = 'name';
        } else if (rest.startsWith('<=')) {
            text = '<=';
            kind = 'symbol';
        } else if ('<+*(),?:'.includes(char)) {
            text = char;
            kind = 'symbol';
        } else {
            unsupported();
        }
        tokens.push({ kind, text, start: position, end: position + text.length });
        if (tokens.length > MAX_TOKENS) invalid('表达式超过复杂度限制。');
        position += text.length;
    }
    return tokens;
}

function parseWithSpans(expression: string): {
    parsed: ParsedTieredPricingExpression;
    spans: PriceSpan[];
} {
    const tokens = tokenize(expression);
    const spans: PriceSpan[] = [];
    const names = new Set<string>();
    let cursor = 0;

    function consume(text: string): Token {
        const token = tokens[cursor];
        if (!token || token.text !== text) unsupported();
        cursor++;
        return token;
    }

    function tier(): RawTier {
        consume('tier');
        consume('(');
        const nameToken = tokens[cursor++];
        if (nameToken?.kind !== 'name') unsupported();
        const name = nameToken.text.slice(1, -1);
        if (names.has(name)) invalid('表达式中的档位名称重复。');
        names.add(name);
        if (names.size > MAX_TIERS) invalid('表达式超过档位数量限制。');
        consume(',');
        const variables = new Set<TieredPricingVariable>();
        const rates: TieredPricingRates = {
            input: 0,
            output: 0,
            cache_read: null,
            cache_write: null,
            cache_write_1h: null,
        };
        for (;;) {
            const variableToken = tokens[cursor++];
            if (
                variableToken?.kind !== 'identifier' ||
                !VARIABLES.includes(variableToken.text as TieredPricingVariable)
            ) {
                unsupported('仅支持 p、c、cr、cc、cc1h 的独立线性单价。');
            }
            const variable = variableToken.text as TieredPricingVariable;
            if (variables.has(variable)) invalid('同一档位不能重复计价同一 Token 类别。');
            variables.add(variable);
            consume('*');
            const priceToken = tokens[cursor++];
            if (priceToken?.kind !== 'number') unsupported('Token 单价必须是非负数字字面量。');
            rates[RATE_KEYS[variable]] = readPrice(priceToken);
            spans.push({ start: priceToken.start, end: priceToken.end, literal: priceToken.text, variable });
            if (tokens[cursor]?.text !== '+') break;
            consume('+');
        }
        consume(')');
        if (!variables.has('p') || !variables.has('c')) invalid('每一档必须明确包含输入和输出单价。');
        return { name, maximum: null, rates };
    }

    function selection(depth = 0): RawTier[] {
        if (depth > MAX_DEPTH) invalid('表达式超过嵌套深度限制。');
        if (tokens[cursor]?.text === '(') {
            consume('(');
            const nested = selection(depth + 1);
            consume(')');
            return nested;
        }
        if (tokens[cursor]?.text !== 'len') return [tier()];
        consume('len');
        const operator = tokens[cursor++];
        if (operator?.text !== '<' && operator?.text !== '<=') {
            unsupported('分档条件仅支持 len < 阈值或 len <= 阈值。');
        }
        const threshold = tokens[cursor++];
        if (threshold?.kind !== 'number' || !/^[1-9]\d*$/.test(threshold.text)) {
            unsupported('输入长度阈值须为正整数字面量。');
        }
        const maximum = Number(threshold.text);
        if (!Number.isSafeInteger(maximum)) invalid('输入长度阈值超出安全整数范围。');
        consume('?');
        const branch = tier();
        branch.maximum = { tokens: maximum, inclusive: operator.text === '<=' };
        consume(':');
        return [branch, ...selection(depth + 1)];
    }

    const rawTiers = selection();
    if (cursor !== tokens.length) unsupported('表达式包含不支持的额外规则。');
    let previous: RawTier['maximum'] = null;
    const tiers = rawTiers.map((rawTier): TieredPricingTier => {
        if (rawTier.maximum && previous && rawTier.maximum.tokens <= previous.tokens) {
            invalid('阶梯阈值必须严格递增。');
        }
        if (rawTier.maximum && previous) {
            const firstTokenCount = previous.tokens + (previous.inclusive ? 1 : 0);
            const lastTokenCount = rawTier.maximum.tokens - (rawTier.maximum.inclusive ? 0 : 1);
            if (lastTokenCount < firstTokenCount) invalid('阶梯包含无法命中的整数输入长度区间。');
        }
        const result: TieredPricingTier = {
            name: rawTier.name,
            min_input_tokens: previous?.tokens ?? null,
            max_input_tokens: rawTier.maximum?.tokens ?? null,
            min_inclusive: previous ? !previous.inclusive : false,
            max_inclusive: rawTier.maximum?.inclusive ?? false,
            rates: rawTier.rates,
        };
        previous = rawTier.maximum;
        return result;
    });
    return {
        parsed: {
            version: 1,
            unit: 'usd_per_million_tokens',
            semantics: 'whole_request',
            input_length: 'full_input_tokens',
            cache_normalization: 'expression_wide',
            used_variables: VARIABLES.filter((variable) => spans.some((span) => span.variable === variable)),
            tiers,
        },
        spans,
    };
}

/** Unknown syntax is rejected in full, never partially parsed or evaluated. */
export function parseTieredPricingExpression(expression: string): ParsedTieredPricingExpression {
    return parseWithSpans(expression).parsed;
}

function roundedDecimal(value: Rational): string {
    const scale = TEN ** BigInt(DECIMAL_PLACES);
    const scaled = (value.n * scale * BigInt(2) + value.d) / (value.d * BigInt(2));
    if (value.n !== ZERO && scaled === ZERO) {
        throw new TieredPricingExpressionError(
            'pricing_tiered_expression_precision',
            '单价缩放后低于十二位小数精度，不能将收费项变为免费。',
        );
    }
    const fraction = (scaled % scale).toString().padStart(DECIMAL_PLACES, '0').replace(/0+$/, '');
    return `${scaled / scale}${fraction ? `.${fraction}` : ''}`;
}

/**
 * Scale only price literals, preserving every condition, name and cache term.
 * Non-terminating decimal results round half up to 12 decimal places. The caller
 * must separately handle group/quota conversion and review all affected groups.
 */
export function scaleTieredPricingExpression(expression: string, numerator: number, denominator: number): string {
    const { spans } = parseWithSpans(expression);
    for (const factor of [numerator, denominator]) {
        if (!Number.isFinite(factor) || factor <= 0 || factor > Number.MAX_SAFE_INTEGER) {
            throw new TieredPricingExpressionError(
                'pricing_tiered_expression_scale',
                '缩放分子与分母必须是安全范围内的正数。',
            );
        }
    }
    if (numerator === denominator) return expression;
    const n = decimal(String(numerator));
    const d = decimal(String(denominator));
    let result = expression;
    for (const span of [...spans].reverse()) {
        const price = decimal(span.literal);
        const scaled = roundedDecimal(reduce(price.n * n.n * d.d, price.d * n.d * d.n));
        readPrice({ kind: 'number', text: scaled, start: 0, end: scaled.length });
        result = `${result.slice(0, span.start)}${scaled}${result.slice(span.end)}`;
    }
    // Includes size/precision/finite-value guards on the complete generated result.
    parseWithSpans(result);
    return result;
}

/** Build an absolute, length-independent customer tariff. Each category is
 * converted independently; neither existing tiers nor their price ratios apply. */
export function uniformTokenPricingExpression(
    rates: Pick<TieredPricingRates, 'input' | 'output' | 'cache_read'>,
    groupRatio: number,
    currencyFactor: number,
): string {
    const denominators = [groupRatio, currencyFactor].map((value) => {
        if (!Number.isFinite(value) || value <= 0 || value > Number.MAX_SAFE_INTEGER)
            invalid('分组倍率或金额换算因子无效。');
        return decimal(String(value));
    });
    const coefficient = (value: number): string => {
        if (!Number.isFinite(value) || value < 0 || value > Number.MAX_SAFE_INTEGER)
            invalid('统一售价必须是安全范围内的非负数。');
        const price = decimal(String(value));
        const [group, currency] = denominators;
        const literal = roundedDecimal(reduce(price.n * group.d * currency.d, price.d * group.n * currency.n));
        readPrice({ kind: 'number', text: literal, start: 0, end: literal.length });
        return literal;
    };
    const terms = [`p * ${coefficient(rates.input)}`, `c * ${coefficient(rates.output)}`];
    if (rates.cache_read !== null) terms.push(`cr * ${coefficient(rates.cache_read)}`);
    const expression = `tier("uniform", ${terms.join(' + ')})`;
    parseWithSpans(expression);
    return expression;
}
