/** 企业 dashboard 展示格式化(纯函数)。时间显示一律北京时间(CLAUDE.md gotcha #20)。 */

export function fmtTime(d: Date | string | null | undefined): string {
    if (!d) return '—';
    return new Date(d).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
}

/** number/string/Prisma.Decimal(任何有 toString 的)都收。 */
type NumLike = number | string | { toString(): string };

function toNum(v: NumLike): number {
    return typeof v === 'number' ? v : Number(v.toString());
}

export function fmtCny(v: NumLike | null | undefined): string {
    if (v == null) return '—';
    return `¥${toNum(v).toFixed(2)}`;
}

/** 精确 ¥(计费明细用,留 4 位小数展示单笔小额)。 */
export function fmtCnyPrecise(v: NumLike | null | undefined): string {
    if (v == null) return '—';
    return `¥${toNum(v).toFixed(4)}`;
}

export function fmtTokens(v: bigint | number | null | undefined): string {
    if (v == null) return '—';
    return Number(v).toLocaleString('en-US');
}

const TASK_STATUS_LABEL: Record<string, string> = {
    queued: '排队中',
    completed: '已完成',
    failed: '失败',
};

export function taskStatusLabel(s: string): string {
    return TASK_STATUS_LABEL[s] ?? s;
}
