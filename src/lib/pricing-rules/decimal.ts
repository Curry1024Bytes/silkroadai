/**
 * Exact decimal arithmetic for compiling sale rules into new-api ratios.
 *
 * Inputs are Prisma Decimal strings or JSON numbers. A number is converted
 * through its shortest decimal form (what JSON.stringify prints), never through
 * its binary value, so 0.1 stays 1/10. All results are reduced fractions.
 */
export interface Rational {
    n: bigint;
    d: bigint;
}

const ZERO = BigInt(0);
const ONE = BigInt(1);
const TEN = BigInt(10);

function gcd(a: bigint, b: bigint): bigint {
    let x = a < ZERO ? -a : a;
    let y = b < ZERO ? -b : b;
    while (y !== ZERO) [x, y] = [y, x % y];
    return x === ZERO ? ONE : x;
}

function reduce(n: bigint, d: bigint): Rational {
    if (d === ZERO) throw new Error('division by zero');
    const sign = d < ZERO ? -ONE : ONE;
    const g = gcd(n, d);
    return { n: (n / g) * sign, d: (d / g) * sign };
}

/** Plain (non-exponent) decimal text for a finite number's shortest form. */
export function plainNumber(value: number): string {
    if (!Number.isFinite(value)) throw new Error('non-finite number');
    const text = String(value);
    if (!/e/i.test(text)) return text;
    const [mantissa, exponentText] = text.toLowerCase().split('e');
    const negative = mantissa.startsWith('-');
    const body = negative ? mantissa.slice(1) : mantissa;
    const point = body.indexOf('.');
    const digits = body.replace('.', '');
    const position = (point === -1 ? body.length : point) + Number(exponentText);
    let plain: string;
    if (position <= 0) plain = `0.${'0'.repeat(-position)}${digits}`;
    else if (position >= digits.length) plain = digits + '0'.repeat(position - digits.length);
    else plain = `${digits.slice(0, position)}.${digits.slice(position)}`;
    return negative ? `-${plain}` : plain;
}

export function parseDecimal(value: string | number): Rational {
    const text = typeof value === 'number' ? plainNumber(value) : value.trim();
    const match = /^(-?)(\d+)(?:\.(\d+))?$/.exec(text);
    if (!match) throw new Error(`invalid decimal: ${text}`);
    const [, sign, whole, fraction = ''] = match;
    const magnitude = BigInt(whole + fraction);
    return reduce(sign ? -magnitude : magnitude, TEN ** BigInt(fraction.length));
}

export function multiply(a: Rational, b: Rational): Rational {
    return reduce(a.n * b.n, a.d * b.d);
}

export function divide(a: Rational, b: Rational): Rational {
    if (b.n === ZERO) throw new Error('division by zero');
    return reduce(a.n * b.d, a.d * b.n);
}

export function compare(a: Rational, b: Rational): number {
    const difference = a.n * b.d - b.n * a.d;
    return difference < ZERO ? -1 : difference > ZERO ? 1 : 0;
}

export function equal(a: Rational, b: Rational): boolean {
    return compare(a, b) === 0;
}

export function max(a: Rational, b: Rational): Rational {
    return compare(a, b) >= 0 ? a : b;
}

export function isOne(value: Rational): boolean {
    return value.n === value.d;
}

/** Smallest multiple of 10^-scale that is >= value. */
export function ceilToScale(value: Rational, scale: number): Rational {
    const factor = TEN ** BigInt(scale);
    const scaled = value.n * factor;
    let quotient = scaled / value.d;
    if (quotient * value.d !== scaled && scaled > ZERO) quotient += ONE;
    return reduce(quotient, factor);
}

/** Largest multiple of 10^-scale that is <= value. */
export function floorToScale(value: Rational, scale: number): Rational {
    const factor = TEN ** BigInt(scale);
    const scaled = value.n * factor;
    let quotient = scaled / value.d;
    if (quotient * value.d !== scaled && scaled < ZERO) quotient -= ONE;
    return reduce(quotient, factor);
}

/** Exact decimal text when the denominator is a power of ten, else rounded half up at `scale`. */
export function toDecimalString(value: Rational, scale = 12): string {
    let { n, d } = value;
    let digits = 0;
    let probe = d;
    while (probe % TEN === ZERO) {
        probe /= TEN;
        digits += 1;
    }
    if (probe !== ONE) {
        const factor = TEN ** BigInt(scale);
        const scaled = n * factor;
        const twice = (scaled * BigInt(2)) / d;
        n = (twice + (twice >= ZERO ? ONE : -ONE)) / BigInt(2);
        d = factor;
        digits = scale;
    }
    const negative = n < ZERO;
    const magnitude = (negative ? -n : n).toString().padStart(digits + 1, '0');
    const whole = magnitude.slice(0, magnitude.length - digits);
    const fraction = digits ? magnitude.slice(-digits).replace(/0+$/, '') : '';
    return `${negative ? '-' : ''}${whole}${fraction ? `.${fraction}` : ''}`;
}

export function toNumber(value: Rational): number {
    return Number(toDecimalString(value));
}
