/**
 * A non-evaluating reader for new-api peak/off-peak token expressions, the shape aipg uses for
 * DeepSeek (2026-11-06, channel 14):
 *
 *   let t = now(); (!(t >= date("…+08:00") && t < date("…+08:00")) && (weekday("Asia/Shanghai") >= 1 && …))
 *     ? tier("peak", p * 3 + cr * 0.1 + c * 9) : tier("off_peak", p * 1.5 + cr * 0.05 + c * 4.5)
 *
 * Only a whitelist is read: one optional `let x = now();`, then `condition ? tier(…) : tier(…)`, where the
 * condition combines `weekday("Asia/Shanghai")` / `hour("Asia/Shanghai")` against integers and `now()`
 * against `date("…")` with `!`, `&&`, `||` and parentheses. Each tier is the same linear `p/c/cr/cc/cc1h`
 * term the length-tier reader accepts. Anything else is refused in full, never guessed.
 *
 * Semantics follow new-api's billing expression runtime: `weekday()` is Go's `time.Weekday` (0 = Sunday),
 * `hour()` is 0–23 in the named zone, `now()` / `date()` are absolute instants. The condition is evaluated
 * here only over a synthetic week grid to describe the schedule; no customer request is ever evaluated.
 * No new-api source is copied here.
 */
import {
    parseTieredPricingExpression,
    TieredPricingExpressionError,
    type TieredPricingRates,
} from './pricing-tiered-expression';

export const TIME_TOKEN_TIMEZONE = 'Asia/Shanghai';

/** ISO weekdays (1 = Monday … 7 = Sunday) sharing one set of hour ranges. `end_hour` is exclusive. */
export interface TimeTokenWindow {
    weekdays: number[];
    start_hour: number;
    end_hour: number;
}

/** A date range whose weekly schedule differs from the regular one. `from` null = before `until`. */
export interface TimeTokenException {
    from: string | null;
    until: string;
    schedule: TimeTokenWindow[];
}

export interface ParsedTimeTokenExpression {
    timezone: typeof TIME_TOKEN_TIMEZONE;
    /** The tier billed while the condition holds, and the one billed otherwise. */
    window: { name: string; rates: TieredPricingRates };
    otherwise: { name: string; rates: TieredPricingRates };
    /** Weekly hours, in Asia/Shanghai, when `window` applies from the last date boundary onward. */
    schedule: TimeTokenWindow[];
    exceptions: TimeTokenException[];
}

export class TimeTokenExpressionError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'TimeTokenExpressionError';
    }
}

const MAX_LENGTH = 16_384;
const MAX_TOKENS = 2_048;
const MAX_DEPTH = 64;
const MAX_DATE_ATOMS = 32;
const RESERVED = new Set(['now', 'date', 'weekday', 'hour', 'minute', 'month', 'day', 'tier', 'let', 'len']);
const UNSUPPORTED_CLOCKS = new Set(['minute', 'month', 'day']);
const OPERATORS = ['>=', '<=', '==', '!=', '>', '<'] as const;
type Operator = (typeof OPERATORS)[number];

/** True when an expression uses new-api time functions, so it belongs to this reader, not the length one. */
export function isTimeOfDayExpression(expression: unknown): boolean {
    return typeof expression === 'string' && /\b(?:hour|minute|weekday|month|day|now|date)\s*\(/.test(expression);
}

function refuse(message = '分时段公式只支持 weekday/hour（北京时间）与 now()/date() 组合的高峰、非高峰两档。'): never {
    throw new TimeTokenExpressionError(message);
}

interface Token {
    kind: 'identifier' | 'number' | 'string' | 'symbol';
    text: string;
    start: number;
    end: number;
}

const SYMBOLS = ['&&', '||', '>=', '<=', '==', '!=', '>', '<', '!', '(', ')', '?', ':', ',', ';', '=', '+', '*'];

function tokenize(expression: string): Token[] {
    if (expression.length === 0 || expression.length > MAX_LENGTH) refuse('表达式为空或超过长度限制。');
    const tokens: Token[] = [];
    let position = expression.startsWith('v1:') ? 3 : 0;
    while (position < expression.length) {
        if (/\s/.test(expression[position])) {
            position++;
            continue;
        }
        const rest = expression.slice(position);
        const identifier = /^[A-Za-z_][A-Za-z0-9_]*/.exec(rest);
        const number = /^(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(rest);
        const string = /^"[A-Za-z0-9_.:+\- /]{1,64}"/.exec(rest);
        const symbol = SYMBOLS.find((s) => rest.startsWith(s));
        let kind: Token['kind'];
        let text: string;
        if (identifier) [kind, text] = ['identifier', identifier[0]];
        else if (number) [kind, text] = ['number', number[0]];
        else if (rest[0] === '"') {
            if (!string) refuse('字符串只能是不含转义符的日期、时区或档位名。');
            [kind, text] = ['string', string[0]];
        } else if (symbol) [kind, text] = ['symbol', symbol];
        else refuse();
        tokens.push({ kind, text, start: position, end: position + text.length });
        if (tokens.length > MAX_TOKENS) refuse('表达式超过复杂度限制。');
        position += text.length;
    }
    return tokens;
}

type Condition =
    | { kind: 'not'; inner: Condition }
    | { kind: 'and' | 'or'; left: Condition; right: Condition }
    | { kind: 'clock'; field: 'weekday' | 'hour'; op: Operator; value: number }
    | { kind: 'instant'; op: Operator; value: number };

/** Strict RFC 3339 with an explicit offset; the calendar date must exist. Returns epoch milliseconds. */
function readDate(literal: string): number {
    const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(Z|([+-])(\d{2}):(\d{2}))$/.exec(literal);
    if (!m) refuse('date() 只接受带时区偏移的完整时间，例如 "2026-10-01T00:00:00+08:00"。');
    const [y, mo, d, h, mi, s] = [m[1], m[2], m[3], m[4], m[5], m[6]].map(Number);
    if (h > 23 || mi > 59 || s > 59) refuse('date() 的时间不合法。');
    const offset = m[7] === 'Z' ? 0 : (m[8] === '-' ? -1 : 1) * (Number(m[9]) * 60 + Number(m[10]));
    const local = Date.UTC(y, mo - 1, d, h, mi, s);
    const check = new Date(local);
    if (check.getUTCFullYear() !== y || check.getUTCMonth() !== mo - 1 || check.getUTCDate() !== d)
        refuse('date() 的日期不存在。');
    return local - offset * 60_000;
}

function flip(op: Operator): Operator {
    return ({ '>=': '<=', '<=': '>=', '>': '<', '<': '>', '==': '==', '!=': '!=' } as const)[op];
}

interface RawProgram {
    condition: Condition;
    window: { name: string; rates: TieredPricingRates };
    otherwise: { name: string; rates: TieredPricingRates };
}

function parse(expression: string): RawProgram {
    const tokens = tokenize(expression);
    let cursor = 0;
    let bound: string | null = null;
    let depth = 0;
    const peek = (offset = 0) => tokens[cursor + offset];
    const take = (text: string) => {
        if (peek()?.text !== text) refuse();
        return tokens[cursor++];
    };
    const enter = () => {
        if (++depth > MAX_DEPTH) refuse('表达式超过嵌套深度限制。');
    };

    if (peek()?.text === 'let') {
        take('let');
        const name = tokens[cursor++];
        if (name?.kind !== 'identifier' || RESERVED.has(name.text)) refuse('let 只能绑定一个普通变量名。');
        take('=');
        take('now');
        take('(');
        take(')');
        take(';');
        bound = name.text;
    }

    /** `tier("name", p * … + c * …)`, read by the length-tier reader so the rate grammar stays identical. */
    function tierCall(): { name: string; rates: TieredPricingRates } {
        let wraps = 0;
        while (peek()?.text === '(') {
            take('(');
            wraps++;
        }
        if (peek()?.text !== 'tier' || peek(1)?.text !== '(') refuse('两个分支都必须是 tier(...)。');
        const start = peek().start;
        let open = 0;
        let end = -1;
        for (let i = cursor + 1; i < tokens.length; i++) {
            if (tokens[i].text === '(') open++;
            else if (tokens[i].text === ')' && --open === 0) {
                end = i;
                break;
            }
        }
        if (end < 0) refuse();
        const text = expression.slice(start, tokens[end].end);
        cursor = end + 1;
        for (let i = 0; i < wraps; i++) take(')');
        let parsed;
        try {
            parsed = parseTieredPricingExpression(text);
        } catch (error) {
            if (error instanceof TieredPricingExpressionError) refuse(`分支单价无法读取：${error.message}`);
            throw error;
        }
        if (parsed.tiers.length !== 1) refuse('每个分支只能是一个 tier(...)，不能再按输入长度分档。');
        return { name: parsed.tiers[0].name, rates: { ...parsed.tiers[0].rates } };
    }

    function instantOperand(): boolean {
        const t = peek();
        if (t?.kind === 'identifier' && t.text === bound) {
            cursor++;
            return true;
        }
        if (t?.text === 'now' && peek(1)?.text === '(' && peek(2)?.text === ')') {
            cursor += 3;
            return true;
        }
        return false;
    }

    function dateOperand(): number | null {
        if (peek()?.text !== 'date' || peek(1)?.text !== '(') return null;
        cursor += 2;
        const literal = tokens[cursor++];
        if (literal?.kind !== 'string') refuse('date() 只接受字符串常量。');
        take(')');
        return readDate(literal.text.slice(1, -1));
    }

    function clockOperand(): 'weekday' | 'hour' | null {
        const t = peek();
        if (t?.kind !== 'identifier' || peek(1)?.text !== '(') return null;
        if (UNSUPPORTED_CLOCKS.has(t.text)) refuse(`暂不支持 ${t.text}()，只支持 weekday() 和 hour()。`);
        if (t.text !== 'weekday' && t.text !== 'hour') return null;
        cursor += 2;
        const zone = tokens[cursor++];
        if (zone?.kind !== 'string' || zone.text.slice(1, -1) !== TIME_TOKEN_TIMEZONE)
            refuse(`时段只支持 ${TIME_TOKEN_TIMEZONE}。`);
        take(')');
        return t.text;
    }

    function integer(): number | null {
        const t = peek();
        if (t?.kind !== 'number') return null;
        if (!/^(?:0|[1-9]\d{0,2})$/.test(t.text)) refuse('时段比较只接受 0–999 的整数。');
        cursor++;
        return Number(t.text);
    }

    function operator(): Operator {
        const t = tokens[cursor++];
        if (!t || !(OPERATORS as readonly string[]).includes(t.text)) refuse();
        return t.text as Operator;
    }

    /** `clock OP int`, `int OP clock`, `instant OP date`, `date OP instant`; nothing else compares. */
    function comparison(): Condition {
        const clock = clockOperand();
        if (clock) {
            const op = operator();
            const value = integer();
            if (value === null) refuse('weekday()/hour() 只能和整数常量比较。');
            return { kind: 'clock', field: clock, op, value };
        }
        const left = integer();
        if (left !== null) {
            const op = operator();
            const field = clockOperand();
            if (!field) refuse('整数只能和 weekday()/hour() 比较。');
            return { kind: 'clock', field, op: flip(op), value: left };
        }
        if (instantOperand()) {
            const op = operator();
            const value = dateOperand();
            if (value === null) refuse('now() 只能和 date("…") 比较。');
            return { kind: 'instant', op, value };
        }
        const date = dateOperand();
        if (date !== null) {
            const op = operator();
            if (!instantOperand()) refuse('date("…") 只能和 now() 比较。');
            return { kind: 'instant', op: flip(op), value: date };
        }
        return refuse();
    }

    function unary(): Condition {
        enter();
        let result: Condition;
        if (peek()?.text === '!') {
            take('!');
            result = { kind: 'not', inner: unary() };
        } else if (peek()?.text === '(') {
            take('(');
            result = or();
            take(')');
        } else result = comparison();
        depth--;
        return result;
    }

    function and(): Condition {
        let left = unary();
        while (peek()?.text === '&&') {
            take('&&');
            left = { kind: 'and', left, right: unary() };
        }
        return left;
    }

    function or(): Condition {
        let left = and();
        while (peek()?.text === '||') {
            take('||');
            left = { kind: 'or', left, right: and() };
        }
        return left;
    }

    /** `cond ? tier : tier`, or the whole ternary wrapped in parentheses. */
    function ternary(): RawProgram {
        enter();
        const [savedCursor, savedDepth] = [cursor, depth];
        let first: unknown = null;
        try {
            const condition = or();
            take('?');
            const window = tierCall();
            take(':');
            const otherwise = tierCall();
            depth--;
            return { condition, window, otherwise };
        } catch (error) {
            if (!(error instanceof TimeTokenExpressionError)) throw error;
            first = error;
        }
        [cursor, depth] = [savedCursor, savedDepth];
        if (peek()?.text !== '(') throw first;
        try {
            take('(');
            const inner = ternary();
            take(')');
            depth--;
            return inner;
        } catch (error) {
            if (error instanceof TimeTokenExpressionError) throw first;
            throw error;
        }
    }

    const program = ternary();
    if (cursor !== tokens.length) refuse('表达式包含不支持的额外规则。');
    if (program.window.name === program.otherwise.name) refuse('两个时段的档位名不能相同。');
    return program;
}

type Moment = { weekday: number; hour: number; instant: number };

function compare(left: number, op: Operator, right: number): boolean {
    if (op === '>=') return left >= right;
    if (op === '<=') return left <= right;
    if (op === '>') return left > right;
    if (op === '<') return left < right;
    if (op === '==') return left === right;
    return left !== right;
}

function evaluate(c: Condition, at: Moment): boolean {
    switch (c.kind) {
        case 'not':
            return !evaluate(c.inner, at);
        case 'and':
            return evaluate(c.left, at) && evaluate(c.right, at);
        case 'or':
            return evaluate(c.left, at) || evaluate(c.right, at);
        case 'clock':
            return compare(c.field === 'weekday' ? at.weekday : at.hour, c.op, c.value);
        case 'instant':
            return compare(at.instant, c.op, c.value);
    }
}

function instants(c: Condition, into: Set<number>): Set<number> {
    switch (c.kind) {
        case 'not':
            return instants(c.inner, into);
        case 'and':
        case 'or':
            instants(c.left, into);
            return instants(c.right, into);
        case 'instant':
            into.add(c.value);
            return into;
        case 'clock':
            return into;
    }
}

/** 7 × 24 truth grid, indexed by Go weekday (0 = Sunday) then hour, at one instant. */
function grid(c: Condition, instant: number): boolean[][] {
    return Array.from({ length: 7 }, (_, weekday) =>
        Array.from({ length: 24 }, (__, hour) => evaluate(c, { weekday, hour, instant })),
    );
}

function windows(cells: boolean[][]): TimeTokenWindow[] {
    const groups = new Map<string, TimeTokenWindow[]>();
    for (let iso = 1; iso <= 7; iso++) {
        const row = cells[iso % 7];
        const runs: Array<[number, number]> = [];
        for (let hour = 0; hour < 24; hour++) {
            if (!row[hour]) continue;
            if (runs.length && runs[runs.length - 1][1] === hour) runs[runs.length - 1][1] = hour + 1;
            else runs.push([hour, hour + 1]);
        }
        if (!runs.length) continue;
        const key = JSON.stringify(runs);
        const existing = groups.get(key);
        if (existing) for (const window of existing) window.weekdays.push(iso);
        else
            groups.set(
                key,
                runs.map(([start_hour, end_hour]) => ({ weekdays: [iso], start_hour, end_hour })),
            );
    }
    return [...groups.values()].flat();
}

/** Unsupported or ambiguous syntax is refused in full; nothing is partially read or evaluated on a request. */
export function parseTimeTokenExpression(expression: string): ParsedTimeTokenExpression {
    const program = parse(expression);
    const boundaries = [...instants(program.condition, new Set())].sort((a, b) => a - b);
    if (boundaries.length > MAX_DATE_ATOMS) refuse('date() 边界过多。');
    // One representative instant per segment between boundaries; 1 ms off a boundary so strict and
    // non-strict comparisons both land inside the segment they describe.
    const points = boundaries.length ? [boundaries[0] - 1, ...boundaries.map((b) => b + 1)] : [0];
    const grids = points.map((point) => grid(program.condition, point));
    const keys = grids.map((g) => JSON.stringify(g));
    const all = grids.flat(2);
    if (all.every(Boolean) || !all.some(Boolean)) refuse('时段条件恒成立或恒不成立，另一档永远不会被计费。');
    const base = keys.length - 1;
    const exceptions: TimeTokenException[] = [];
    for (let i = 0; i < base; i++) {
        if (keys[i] === keys[base]) continue;
        const from = i === 0 ? null : new Date(boundaries[i - 1]).toISOString();
        const until = new Date(boundaries[i]).toISOString();
        const previous = exceptions[exceptions.length - 1];
        if (previous && previous.until === from && keys[i] === keys[i - 1]) previous.until = until;
        else exceptions.push({ from, until, schedule: windows(grids[i]) });
    }
    return {
        timezone: TIME_TOKEN_TIMEZONE,
        window: program.window,
        otherwise: program.otherwise,
        schedule: windows(grids[base]),
        exceptions,
    };
}
