import { Prisma } from '@prisma/client';

/** P1 CSV 单次导入边界：控制事务大小，也避免误把完整供应商账库拖进请求。 */
export const MAX_UPSTREAM_COST_IMPORT_BYTES = 1_024 * 1_024;
export const MAX_UPSTREAM_COST_IMPORT_ROWS = 1_000;

export const UPSTREAM_COST_STATUSES = ['verified', 'estimated', 'unmatched'] as const;
export type UpstreamCostStatusValue = (typeof UPSTREAM_COST_STATUSES)[number];

/** CSV 固定列；顺序可变，但不能漏列或悄悄接受未知列。 */
export const UPSTREAM_COST_CSV_HEADERS = [
    'newapi_log_id',
    'newapi_request_id',
    'upstream_request_id',
    'upstream_provider',
    'upstream_route',
    'upstream_model',
    'upstream_amount',
    'currency',
    'cny_per_unit',
    'cost_multiplier',
    'status',
    'evidence_hash',
    'evidence_summary',
] as const;

type RecordLike = Record<string, unknown>;

export interface NormalizedUpstreamCostInput {
    newapi_log_id: number | null;
    newapi_request_id: string | null;
    upstream_request_id: string | null;
    upstream_provider: string | null;
    upstream_route: string;
    upstream_model: string | null;
    upstream_amount: Prisma.Decimal;
    currency: string;
    cny_per_unit: Prisma.Decimal;
    cost_multiplier: Prisma.Decimal;
    cost_cny: Prisma.Decimal;
    status: UpstreamCostStatusValue;
    evidence_hash: string | null;
    evidence_summary: string | null;
}

function isRecord(value: unknown): value is RecordLike {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function text(value: unknown, field: string, max: number, required = false): string | null {
    if (value == null) {
        if (required) throw new Error(`${field} 为必填项`);
        return null;
    }
    if (typeof value !== 'string' && typeof value !== 'number') throw new Error(`${field} 必须是文本`);
    const normalized = String(value).trim();
    if (!normalized) {
        if (required) throw new Error(`${field} 为必填项`);
        return null;
    }
    if (normalized.length > max) throw new Error(`${field} 最长 ${max} 个字符`);
    return normalized;
}

function decimal(value: unknown, field: string, defaultValue?: string): Prisma.Decimal {
    const raw = value == null || value === '' ? defaultValue : value;
    if (typeof raw !== 'string' && typeof raw !== 'number') throw new Error(`${field} 必须是正数`);
    try {
        const out = new Prisma.Decimal(raw);
        if (!out.isFinite() || !out.gt(0)) throw new Error('not_positive');
        if (out.decimalPlaces() > 8) throw new Error('too_precise');
        if (out.gt('1000000000000')) throw new Error('too_large');
        return out;
    } catch {
        throw new Error(`${field} 必须是最多 8 位小数的正数`);
    }
}

function positiveInt(value: unknown, field: string): number | null {
    if (value == null || value === '') return null;
    const raw = typeof value === 'number' ? value : typeof value === 'string' ? Number(value.trim()) : Number.NaN;
    if (!Number.isSafeInteger(raw) || raw <= 0 || raw > 2_147_483_647) {
        throw new Error(`${field} 必须是有效的 new-api 日志 ID`);
    }
    return raw;
}

/**
 * 统一校验手工输入和 CSV 行。CNY 成本只由原始金额与两个快照参数计算，避免
 * 操作员输入的展示金额与可审计换算规则不一致。
 */
export function normalizeUpstreamCostInput(value: unknown): NormalizedUpstreamCostInput {
    if (!isRecord(value)) throw new Error('成本记录必须是对象');

    const newapi_log_id = positiveInt(value.newapi_log_id, 'newapi_log_id');
    const newapi_request_id = text(value.newapi_request_id, 'newapi_request_id', 256);
    const upstream_request_id = text(value.upstream_request_id, 'upstream_request_id', 256);
    const upstream_provider = text(value.upstream_provider, 'upstream_provider', 128);
    const upstream_route = text(value.upstream_route, 'upstream_route', 160, true)!;
    const upstream_model = text(value.upstream_model, 'upstream_model', 160);
    const upstream_amount = decimal(value.upstream_amount, 'upstream_amount');
    const currency = text(value.currency, 'currency', 3, true)!.toUpperCase();
    if (!/^[A-Z]{3}$/.test(currency)) throw new Error('currency 必须是 3 位 ISO 货币代码');
    const cny_per_unit = decimal(value.cny_per_unit, 'cny_per_unit');
    const cost_multiplier = decimal(value.cost_multiplier, 'cost_multiplier', '1');
    const status = text(value.status, 'status', 16, true) as UpstreamCostStatusValue;
    if (!UPSTREAM_COST_STATUSES.includes(status)) {
        throw new Error('status 必须是 verified、estimated 或 unmatched');
    }
    const evidence_hash = text(value.evidence_hash, 'evidence_hash', 64);
    if (evidence_hash && !/^[a-fA-F0-9]{64}$/.test(evidence_hash)) {
        throw new Error('evidence_hash 必须是 64 位 SHA-256 十六进制摘要');
    }
    const evidence_summary = text(value.evidence_summary, 'evidence_summary', 2_000);

    const hasRequestReference = newapi_log_id != null || newapi_request_id != null || upstream_request_id != null;
    if (status !== 'unmatched' && !hasRequestReference) {
        throw new Error('verified 或 estimated 记录必须包含至少一个请求关联 ID；未关联记录请标记 unmatched');
    }

    const cost_cny = upstream_amount
        .mul(cny_per_unit)
        .mul(cost_multiplier)
        .toDecimalPlaces(8, Prisma.Decimal.ROUND_HALF_UP);
    if (!cost_cny.gt(0)) throw new Error('换算后的 cost_cny 过小，无法按 8 位小数入账');

    return {
        newapi_log_id,
        newapi_request_id,
        upstream_request_id,
        upstream_provider,
        upstream_route,
        upstream_model,
        upstream_amount,
        currency,
        cny_per_unit,
        cost_multiplier,
        cost_cny,
        status,
        evidence_hash: evidence_hash?.toLowerCase() ?? null,
        evidence_summary,
    };
}

interface CsvRow {
    line: number;
    values: string[];
}

/** 小型 RFC4180 解析器：支持引号、逗号、CRLF 与带换行的证据摘要。 */
function parseCsvRows(raw: string): CsvRow[] {
    const rows: CsvRow[] = [];
    let values: string[] = [];
    let current = '';
    let quoted = false;
    let line = 1;
    let rowStartLine = 1;

    const pushRow = () => {
        values.push(current);
        if (values.some((value) => value.trim() !== '')) rows.push({ line: rowStartLine, values });
        values = [];
        current = '';
        rowStartLine = line + 1;
    };

    for (let i = 0; i < raw.length; i++) {
        const char = raw[i]!;
        if (quoted) {
            if (char === '"') {
                if (raw[i + 1] === '"') {
                    current += '"';
                    i++;
                } else {
                    quoted = false;
                }
            } else {
                current += char;
                if (char === '\n') line++;
            }
            continue;
        }
        if (char === '"') {
            if (current !== '') throw new Error(`CSV 第 ${line} 行的引号位置无效`);
            quoted = true;
        } else if (char === ',') {
            values.push(current);
            current = '';
        } else if (char === '\n') {
            pushRow();
            line++;
        } else if (char !== '\r') {
            current += char;
        }
    }
    if (quoted) throw new Error('CSV 存在未闭合的引号');
    if (current !== '' || values.length > 0) pushRow();
    return rows;
}

export interface ParsedUpstreamCostCsvRow {
    line: number;
    value: NormalizedUpstreamCostInput;
}

/** 解析并全量校验 CSV；调用方只可在此成功后启动数据库事务。 */
export function parseUpstreamCostCsv(raw: string): ParsedUpstreamCostCsvRow[] {
    const rows = parseCsvRows(raw.replace(/^\uFEFF/, ''));
    if (rows.length < 2) throw new Error('CSV 至少需要表头和一条成本记录');

    const [header, ...dataRows] = rows;
    const fields = header!.values.map((value) => value.trim());
    const duplicates = fields.filter((value, index) => fields.indexOf(value) !== index);
    if (duplicates.length) throw new Error(`CSV 表头重复：${duplicates[0]}`);
    const missing = UPSTREAM_COST_CSV_HEADERS.filter((field) => !fields.includes(field));
    if (missing.length) throw new Error(`CSV 缺少列：${missing.join(', ')}`);
    const unknown = fields.filter(
        (field) => !UPSTREAM_COST_CSV_HEADERS.includes(field as (typeof UPSTREAM_COST_CSV_HEADERS)[number]),
    );
    if (unknown.length) throw new Error(`CSV 包含未知列：${unknown.join(', ')}`);
    if (dataRows.length > MAX_UPSTREAM_COST_IMPORT_ROWS) {
        throw new Error(`单次最多导入 ${MAX_UPSTREAM_COST_IMPORT_ROWS} 条成本记录`);
    }

    return dataRows.map((row) => {
        if (row.values.length !== fields.length) {
            throw new Error(`CSV 第 ${row.line} 行的列数与表头不一致`);
        }
        const input = Object.fromEntries(fields.map((field, index) => [field, row.values[index] ?? '']));
        try {
            return { line: row.line, value: normalizeUpstreamCostInput(input) };
        } catch (error) {
            const message = error instanceof Error ? error.message : '格式无效';
            throw new Error(`CSV 第 ${row.line} 行：${message}`);
        }
    });
}
