/** Format imported numbers, never text that the operator is currently editing.
 * Only remove an obvious floating-point tail within machine precision. A fixed
 * number of decimal places would erase small, but valid, supplier prices. */
export function pricingNumberInput(value: number | null | undefined): string {
    if (value == null || !Number.isFinite(value)) return '';
    const original = String(value);
    if (value === 0) return original;
    const tolerance = Math.abs(value) * Number.EPSILON;
    for (let precision = 1; precision <= 15; precision += 1) {
        const candidate = Number(value.toPrecision(precision));
        const text = String(candidate);
        if (text.length + 4 <= original.length && Math.abs(candidate - value) <= tolerance) return text;
    }
    return original;
}

/** Keep unchanged imported numbers exact when saving an unrelated draft field. */
export function pricingNumberFromInput(text: string, original?: number): number | null {
    const trimmed = text.trim();
    if (!trimmed || !Number.isFinite(Number(trimmed))) return null;
    if (original !== undefined && Number.isFinite(original) && trimmed === pricingNumberInput(original))
        return original;
    return Number(trimmed);
}
