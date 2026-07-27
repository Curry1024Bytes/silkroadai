/** 企业门户查询参数公共件(2026-07-26):日期解析 + CSV 组装(logs/billing 页与导出 route 共用)。 */

/** YYYY-MM-DD → Date(北京时区当日 00:00 / 23:59:59.999);非法返回 null。
 *  客户心智是北京时间(CLAUDE.md gotcha #20 同源)。 */
export function parseDay(s: string | undefined | null, endOfDay = false): Date | null {
    if (!s || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
    const d = new Date(`${s}T${endOfDay ? '23:59:59.999' : '00:00:00.000'}+08:00`);
    return Number.isNaN(d.getTime()) ? null : d;
}

/** CSV 单元格转义(含逗号/引号/换行时加引号,内部引号翻倍)。 */
function csvCell(v: string | number | null | undefined): string {
    if (v == null) return '';
    const s = String(v);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** rows → CSV 文本(带 UTF-8 BOM,Excel 打开中文不乱码)。 */
export function toCsv(header: string[], rows: Array<Array<string | number | null | undefined>>): string {
    const lines = [header.map(csvCell).join(','), ...rows.map((r) => r.map(csvCell).join(','))];
    return '\uFEFF' + lines.join('\r\n');
}

/** 北京时间字符串(CSV 用,不带本地化分隔差异)。 */
export function bjTimeStr(d: Date): string {
    return new Date(d.getTime() + 8 * 3600_000).toISOString().replace('T', ' ').slice(0, 19);
}
