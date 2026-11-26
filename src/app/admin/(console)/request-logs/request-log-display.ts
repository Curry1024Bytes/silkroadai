export interface LogRow {
    id: string;
    created_at: string;
    user_id: string | null;
    tenant_id: string | null;
    model: string | null;
    path: string;
    method: string;
    status_code: number | null;
    success: boolean;
    streamed: boolean;
    incomplete: boolean;
    input_tokens: number | null;
    output_tokens: number | null;
    input_bytes: number;
    output_bytes: number;
    duration_ms: number | null;
    input_r2_key: string | null;
    output_r2_key: string | null;
}

export const time = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Shanghai',
    hourCycle: 'h23',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
});
const date = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai', dateStyle: 'short' });
export const logDate = (iso: string) => date.format(new Date(iso));
export const logTime = (iso: string) => time.format(new Date(iso));
export const number = new Intl.NumberFormat('zh-CN');
export const formatNumber = (value: number | null) => (value == null ? '—' : number.format(value));
export const formatDuration = (value: number | null) =>
    value == null ? '—' : value < 1000 ? value + ' ms' : (value / 1000).toFixed(2) + ' s';
export const formatBytes = (value: number) =>
    value < 1024
        ? value + ' B'
        : value < 1048576
          ? (value / 1024).toFixed(1) + ' KB'
          : (value / 1048576).toFixed(1) + ' MB';

export const EMPTY_FILTERS = {
    path: '',
    user_id: '',
    model: '',
    method: '',
    status_code: '',
    streamed: '',
    from: '',
    to: '',
};
export type Filters = typeof EMPTY_FILTERS;
export type View = 'all' | 'failed' | 'incomplete';

export function buildLogQuery(filters: Filters, view: View, page: number, pageSize: number) {
    const query = new URLSearchParams({ page: String(page), page_size: String(pageSize) });
    for (const [key, value] of Object.entries(filters)) {
        if (!value.trim()) continue;
        if (key === 'from') query.set(key, value + 'T00:00:00+08:00');
        else if (key === 'to') query.set(key, value + 'T23:59:59.999+08:00');
        else query.set(key, value.trim());
    }
    if (view === 'failed') query.set('success', 'false');
    if (view === 'incomplete') query.set('incomplete', 'true');
    return query;
}

const taskPath = /^\/(?:(?:v1\/)?videos|(?:doubao\/)?api\/v3\/contents\/generations\/tasks)\/([^/?#]+)\/?$/;
export const isVideoPoll = (row: LogRow) => row.method === 'GET' && taskPath.test(row.path);
export const taskId = (row: LogRow) => (isVideoPoll(row) ? row.path.match(taskPath)?.[1] : undefined);

export function groupLogs(logs: LogRow[], enabled: boolean) {
    const groups: LogRow[][] = [];
    const byTask = new Map<string, LogRow[]>();
    for (const row of logs) {
        if (!enabled || !row.user_id || !isVideoPoll(row)) {
            groups.push([row]);
            continue;
        }
        const key = JSON.stringify([
            row.tenant_id,
            row.user_id,
            row.path,
            row.model,
            row.status_code,
            row.success,
            row.incomplete,
            row.streamed,
        ]);
        const existing = byTask.get(key);
        if (existing) existing.push(row);
        else {
            const group = [row];
            byTask.set(key, group);
            groups.push(group);
        }
    }
    return groups;
}

export function statusFor(row: LogRow) {
    if (row.incomplete) return { kind: 'warning', label: '中断' };
    if (row.success) return { kind: 'success', label: '成功' };
    return { kind: 'error', label: '失败' };
}
