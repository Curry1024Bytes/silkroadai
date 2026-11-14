/**
 * A strict, non-evaluating reader for new-api task-usage price matrices of the
 * Seedance video plugin: one `tier()` per (resolution × reference video) pair,
 * each priced `u("tokens") * <coefficient> / 1000000`. This is the form new-api's
 * matrix editor generates. Coefficients are new-api base units (currency per 1M
 * tokens, before the group ratio). Anything else is rejected in full, never
 * partially read or guessed. No new-api source is copied here.
 */
export const VIDEO_TOKEN_RESOLUTIONS = ['480p', '720p', '1080p', '4k'] as const;
export const VIDEO_TOKEN_INPUTS = ['none', 'video'] as const;
export type VideoTokenResolution = (typeof VIDEO_TOKEN_RESOLUTIONS)[number];
export type VideoTokenInput = (typeof VIDEO_TOKEN_INPUTS)[number];
export type VideoTokenCombo = { resolution: VideoTokenResolution; video_input: VideoTokenInput };

export interface VideoTokenCell {
    resolution: VideoTokenResolution;
    video_input: VideoTokenInput;
    price: number;
}

export interface ParsedVideoTokenExpression {
    /** Canonical model-supported order: resolution, then reference video. */
    cells: VideoTokenCell[];
    /** The pair priced by the trailing unconditioned tier. */
    fallback: { resolution: VideoTokenResolution; video_input: VideoTokenInput };
}

export const VIDEO_TOKEN_COMBOS: VideoTokenCombo[] = VIDEO_TOKEN_RESOLUTIONS.flatMap((resolution) =>
    VIDEO_TOKEN_INPUTS.map((video_input) => ({ resolution, video_input })),
);

/** Seedance 2.0 Mini's official token matrix supports only 480p and 720p. */
export const VIDEO_TOKEN_MINI_COMBOS: VideoTokenCombo[] = VIDEO_TOKEN_COMBOS.filter(
    (combo) => combo.resolution === '480p' || combo.resolution === '720p',
);

/**
 * Return the supported matrix cells for a model. Unknown models keep the
 * historical eight-cell contract so existing non-Mini pricing remains strict.
 * Global and promax Mini names use a different upstream price table and must
 * not be silently treated as the domestic Seedance 2.0 Mini model.
 */
export function isSeedanceMiniModel(model: string | undefined): boolean {
    const name = String(model ?? '')
        .trim()
        .toLowerCase();
    if (!name || name.includes('global') || name.includes('promax')) return false;
    return (
        /^doubao-seedance-2-0-mini(?:-\d{6})?$/.test(name) ||
        name === 'doubao-seedance-2.0-mini' ||
        name === 'seedance-2-0-mini' ||
        /^seedance2\.0-mini(?:-(?:480p|720p)(?:-ref)?)?$/.test(name)
    );
}

export function videoTokenCombosForModel(model?: string): readonly VideoTokenCombo[] {
    return isSeedanceMiniModel(model) ? VIDEO_TOKEN_MINI_COMBOS : VIDEO_TOKEN_COMBOS;
}

export const videoTokenKey = (cell: { resolution: string; video_input: string }) =>
    `${cell.resolution}·${cell.video_input}`;

export function videoTokenInputLabel(input: VideoTokenInput, en = false): string {
    if (input === 'none') return en ? 'no reference video' : '无参考视频';
    return en ? 'with reference video' : '有参考视频';
}

export class VideoTokenExpressionError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'VideoTokenExpressionError';
    }
}

const MAX_LENGTH = 4_096;
const MAX_TOKENS = 512;
export const VIDEO_TOKEN_MAX_PRICE = 1_000_000;
const NUMBER = /^(?:0|[1-9]\d{0,9})(?:\.\d{1,12})?$/;

function fail(message = '只支持按分辨率和参考视频分档、按 token 计价的视频公式。'): never {
    throw new VideoTokenExpressionError(message);
}

/** True for any expression that reads task usage, i.e. is not a plain token formula. */
export function isTaskUsageExpression(expression: unknown): boolean {
    return typeof expression === 'string' && /\bu\s*\(/.test(expression);
}

interface Token {
    kind: 'identifier' | 'number' | 'string' | 'symbol';
    text: string;
    start: number;
    end: number;
}

const LEXEMES: Array<[Token['kind'], RegExp]> = [
    ['identifier', /^[A-Za-z_][A-Za-z0-9_]*/],
    ['number', /^\d[\d.]*/],
    // No escapes, quotes or spaces inside a string literal.
    ['string', /^"[A-Za-z0-9_.·-]{1,32}"/],
    ['symbol', /^(?:==|&&|[?:(),*/])/],
];

function tokenize(expression: string): Token[] {
    if (typeof expression !== 'string' || !expression.trim() || expression.length > MAX_LENGTH)
        fail('计费公式为空或过长。');
    const tokens: Token[] = [];
    let position = expression.startsWith('v1:') ? 3 : 0;
    while (position < expression.length) {
        if (/[ \t\r\n]/.test(expression[position])) {
            position++;
            continue;
        }
        const rest = expression.slice(position);
        let token: Token | null = null;
        for (const [kind, pattern] of LEXEMES) {
            const match = pattern.exec(rest);
            if (match) {
                token = { kind, text: match[0], start: position, end: position + match[0].length };
                break;
            }
        }
        if (!token) fail();
        tokens.push(token);
        if (tokens.length > MAX_TOKENS) fail('计费公式超过复杂度限制。');
        position = token.end;
    }
    return tokens;
}

const TEN = BigInt(10);

function exact(text: string): { n: bigint; d: bigint } {
    const [whole, digits = ''] = text.split('.');
    return { n: BigInt(whole + digits), d: TEN ** BigInt(digits.length) };
}

/** A non-negative decimal literal whose JS number round-trips to the same exact value. */
export function readVideoTokenPrice(text: string): number {
    if (!NUMBER.test(text)) fail('单价须为不带指数的非负小数。');
    const value = Number(text);
    if (!Number.isFinite(value) || value > VIDEO_TOKEN_MAX_PRICE) fail('单价超出范围。');
    const shown = String(value);
    if (!NUMBER.test(shown)) fail('单价无法无损表示。');
    const a = exact(text);
    const b = exact(shown);
    if (a.n * b.d !== b.n * a.d) fail('单价无法无损表示。');
    return value;
}

interface PriceSpan {
    key: string;
    start: number;
    end: number;
}

function parseWithSpans(
    expression: string,
    model?: string,
): { parsed: ParsedVideoTokenExpression; spans: PriceSpan[] } {
    const tokens = tokenize(expression);
    let cursor = 0;
    const peek = () => tokens[cursor];
    const take = (text: string): Token => {
        const token = tokens[cursor];
        if (!token || token.text !== text) fail();
        cursor++;
        return token;
    };
    const literal = (): string => {
        const token = tokens[cursor++];
        if (!token || token.kind !== 'string') fail();
        return token.text.slice(1, -1);
    };
    const usage = (field: string) => {
        take('u');
        take('(');
        if (literal() !== field) fail('公式只能按 resolution 和 video_input 分档，按 tokens 计价。');
        take(')');
    };
    const condition = () => {
        usage('resolution');
        take('==');
        const resolution = literal();
        take('&&');
        usage('video_input');
        take('==');
        const videoInput = literal();
        if (!(VIDEO_TOKEN_RESOLUTIONS as readonly string[]).includes(resolution))
            fail(`不认识的分辨率「${resolution}」。`);
        if (!(VIDEO_TOKEN_INPUTS as readonly string[]).includes(videoInput))
            fail(`不认识的参考视频取值「${videoInput}」。`);
        return { resolution: resolution as VideoTokenResolution, video_input: videoInput as VideoTokenInput };
    };
    const call = () => {
        take('tier');
        take('(');
        const label = literal();
        take(',');
        usage('tokens');
        take('*');
        const priceToken = tokens[cursor++];
        if (!priceToken || priceToken.kind !== 'number') fail('单价须为数字。');
        const price = readVideoTokenPrice(priceToken.text);
        take('/');
        const scale = tokens[cursor++];
        if (!scale || scale.text !== '1000000') fail('token 单价须按每百万计。');
        take(')');
        return { label, price, start: priceToken.start, end: priceToken.end };
    };

    const branches: Array<VideoTokenCell & { start: number; end: number }> = [];
    while (peek()?.text === 'u') {
        const pair = condition();
        take('?');
        const tier = call();
        take(':');
        if (tier.label !== videoTokenKey(pair)) fail(`档位「${tier.label}」的名称与条件不一致。`);
        if (branches.some((row) => videoTokenKey(row) === videoTokenKey(pair)))
            fail(`档位「${videoTokenKey(pair)}」重复。`);
        branches.push({ ...pair, price: tier.price, start: tier.start, end: tier.end });
    }
    const last = call();
    if (cursor !== tokens.length) fail('公式包含不支持的额外规则。');
    // Mini models are officially limited to 480p/720p. Older production
    // formulas can still contain all 8 cells, so accept either a complete
    // four-cell Mini expression or a complete legacy eight-cell expression.
    // In the latter case the caller receives and edits only the four supported
    // cells; the other four formula branches remain intact.
    const expected = videoTokenCombosForModel(model);
    const formulaCombos =
        isSeedanceMiniModel(model) && branches.length + 1 === VIDEO_TOKEN_COMBOS.length ? VIDEO_TOKEN_COMBOS : expected;
    const seen = new Set(branches.map((row) => videoTokenKey(row)));
    const missing = formulaCombos.filter((combo) => !seen.has(videoTokenKey(combo)));
    if (
        missing.length !== 1 ||
        branches.some((row) => !formulaCombos.some((combo) => videoTokenKey(combo) === videoTokenKey(row)))
    )
        fail(
            isSeedanceMiniModel(model)
                ? 'Mini 公式须恰好覆盖 480p/720p 的 4 档，或完整的 8 档兼容公式。'
                : '公式须恰好覆盖 4 种分辨率 × 有无参考视频的全部 8 档。',
        );
    const fallback = missing[0];
    if (last.label !== videoTokenKey(fallback))
        fail(`最后一档「${last.label}」与剩余的「${videoTokenKey(fallback)}」不一致。`);
    const all = [...branches, { ...fallback, price: last.price, start: last.start, end: last.end }];
    const cells = expected.map((combo) => {
        const row = all.find((item) => videoTokenKey(item) === videoTokenKey(combo))!;
        return { resolution: row.resolution, video_input: row.video_input, price: row.price };
    });
    return {
        parsed: { cells, fallback },
        spans: all.map((row) => ({ key: videoTokenKey(row), start: row.start, end: row.end })),
    };
}

export function parseVideoTokenExpression(expression: string, model?: string): ParsedVideoTokenExpression {
    return parseWithSpans(expression, model).parsed;
}

/** Shortest exact decimal for a positive coefficient; rejects anything the reader would not accept back. */
export function formatVideoTokenPrice(value: number): string {
    if (!Number.isFinite(value) || value <= 0 || value > VIDEO_TOKEN_MAX_PRICE) fail('单价须为正数且不超过上限。');
    const text = String(value);
    readVideoTokenPrice(text);
    return text;
}

function buildMiniVideoTokenExpression(cells: VideoTokenCell[], hasVersionPrefix: boolean): string {
    const prices = new Map(cells.map((cell) => [videoTokenKey(cell), cell.price]));
    const combos = videoTokenCombosForModel('seedance2.0-mini');
    let result = '';
    for (let index = combos.length - 1; index >= 0; index--) {
        const combo = combos[index];
        const key = videoTokenKey(combo);
        const tier = `tier("${key}", u("tokens") * ${formatVideoTokenPrice(prices.get(key)!)} / 1000000)`;
        if (index === combos.length - 1) {
            result = tier;
            continue;
        }
        result = `u("resolution") == "${combo.resolution}" && u("video_input") == "${combo.video_input}" ? ${tier} : ${result}`;
    }
    return `${hasVersionPrefix ? 'v1:' : ''}${result}`;
}

/**
 * Replace only the supported price literals; conditions, labels, order and
 * keep the current expression structure. A legacy eight-cell Mini expression
 * is canonicalized to four supported cells so new-api cannot keep billing its
 * retired 1080p/4K branches after an operator saves the Mini quote.
 */
export function rewriteVideoTokenExpression(expression: string, cells: VideoTokenCell[], model?: string): string {
    const { spans } = parseWithSpans(expression, model);
    const next = new Map(cells.map((cell) => [videoTokenKey(cell), cell.price]));
    const expected = videoTokenCombosForModel(model);
    if (cells.length !== expected.length || next.size !== expected.length)
        fail(`须给出全部 ${expected.length} 档的单价。`);
    for (const combo of expected) if (!next.has(videoTokenKey(combo))) fail(`须给出全部 ${expected.length} 档的单价。`);
    if (isSeedanceMiniModel(model) && spans.length === VIDEO_TOKEN_COMBOS.length) {
        const canonicalCells = expected.map((combo) => ({ ...combo, price: next.get(videoTokenKey(combo))! }));
        const result = buildMiniVideoTokenExpression(canonicalCells, expression.startsWith('v1:'));
        const reread = parseVideoTokenExpression(result, model);
        for (const cell of reread.cells)
            if (cell.price !== next.get(videoTokenKey(cell))) fail('改写后的公式回读不一致。');
        return result;
    }
    let result = expression;
    for (const span of [...spans].filter((item) => next.has(item.key)).sort((a, b) => b.start - a.start))
        result = `${result.slice(0, span.start)}${formatVideoTokenPrice(next.get(span.key)!)}${result.slice(span.end)}`;
    const reread = parseVideoTokenExpression(result, model);
    for (const cell of reread.cells) if (cell.price !== next.get(videoTokenKey(cell))) fail('改写后的公式回读不一致。');
    return result;
}
