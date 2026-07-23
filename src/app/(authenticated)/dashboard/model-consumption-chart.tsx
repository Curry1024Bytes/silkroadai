'use client';

/**
 * 模型消耗分布图 — daily consumption stacked by model (new-api 看板 风格).
 *
 * Data comes from `getUsageAggregate().byDay` (raw quota per model per day,
 * Asia/Shanghai buckets) + `.chartModels` (ordered stack keys, top-N + '其他').
 * Quota → ¥ uses `cnyPerQuota` passed from the server (= quotaToCny(1)).
 *
 * ⚠️ This is a 'use client' island, so it must NOT call quotaToCny directly:
 * NEWAPI_QUOTA_PER_USD / USD_TO_CNY_RATE are server-only env (not NEXT_PUBLIC_),
 * undefined in the client bundle → quota-units falls back to stale defaults
 * (500k / 7.2) and over-displays ¥ by ~2×. The server passes the real rate.
 *
 * recharts is already a portal dependency (admin DailyChart). This is a
 * client island — recharts needs the DOM (ResponsiveContainer measures width).
 * The custom tooltip is typed in-file to avoid recharts' loose ValueType
 * generics, matching the DailyChart pattern.
 */
import { ResponsiveContainer, AreaChart, Area, XAxis, YAxis, Tooltip, Legend, CartesianGrid } from 'recharts';

export interface ModelConsumptionChartProps {
    byDay: Array<{ date: string; values: Record<string, number> }>;
    /** Ordered stack keys (top-N model names, '其他' last when present). */
    models: string[];
    /** ¥ per 1 raw quota, computed server-side (= quotaToCny(1)). Multiplied
     *  client-side so this island never reads server-only FX env. */
    cnyPerQuota: number;
}

const OTHER_LABEL = '其他';

/** Stack colors. '其他' is always the muted grey; real models cycle the
 *  brand-leaning palette by index. */
const PALETTE = ['#1e3a8a', '#a16207', '#0f766e', '#b45309', '#6d28d9', '#be123c'];
const OTHER_COLOR = '#8c94a1';

function colorFor(model: string, idx: number): string {
    if (model === OTHER_LABEL) return OTHER_COLOR;
    return PALETTE[idx % PALETTE.length];
}

/** YYYY-MM-DD → M/D for the axis. */
function shortDate(date: string): string {
    const [, m, d] = date.split('-');
    return m && d ? `${Number(m)}/${Number(d)}` : date;
}

/** Compact ¥ for the Y axis ticks (input is already ¥). */
function formatCnyTick(cny: number): string {
    if (cny >= 1000) return `¥${(cny / 1000).toFixed(1)}k`;
    if (cny >= 1) return `¥${cny.toFixed(0)}`;
    return `¥${cny.toFixed(2)}`;
}

interface TooltipPayloadEntry {
    value: number;
    dataKey: string;
    color: string;
}

function ChartTooltip({
    active,
    payload,
    label,
    cnyPerQuota,
}: {
    active?: boolean;
    payload?: TooltipPayloadEntry[];
    label?: string;
    cnyPerQuota: number;
}) {
    if (!active || !payload?.length) return null;
    // Skip zero stacks so a busy day's tooltip stays readable.
    const rows = payload.filter((p) => p.value > 0);
    const total = rows.reduce((a, p) => a + p.value, 0);
    return (
        <div className="rounded-md border border-portal-line bg-portal-panel px-3 py-2 text-xs shadow-portal">
            <p className="m-0 mb-1.5 font-medium text-portal-ink">{label}</p>
            {rows.map((p) => (
                <p key={p.dataKey} className="m-0 flex items-center justify-between gap-3 text-portal-muted">
                    <span className="flex items-center gap-1.5">
                        <span className="inline-block h-2 w-2 rounded-sm" style={{ backgroundColor: p.color }} />
                        <span className="font-mono">{p.dataKey}</span>
                    </span>
                    <span className="tabular-nums text-portal-ink">¥{(p.value * cnyPerQuota).toFixed(2)}</span>
                </p>
            ))}
            <p className="m-0 mt-1.5 flex justify-between gap-3 border-t border-portal-line pt-1.5 font-medium text-portal-ink">
                <span>合计</span>
                <span className="tabular-nums">¥{(total * cnyPerQuota).toFixed(2)}</span>
            </p>
        </div>
    );
}

export function ModelConsumptionChart({ byDay, models, cnyPerQuota }: ModelConsumptionChartProps) {
    if (byDay.length === 0 || models.length === 0) {
        return (
            <div className="flex h-[260px] items-center justify-center rounded-md border border-dashed border-portal-line bg-portal-soft px-6 text-center text-sm text-portal-subtle sm:h-[300px]">
                该时间段内暂无消耗数据。完成首次调用后,趋势会显示在这里。
            </div>
        );
    }

    // Flatten to recharts rows, ensuring every stack key exists (default 0)
    // so stacking is gap-free.
    const data = byDay.map((d) => {
        const row: Record<string, number | string> = { date: shortDate(d.date) };
        for (const m of models) row[m] = d.values[m] ?? 0;
        return row;
    });

    // Thin out ticks when the window is long (mirrors DailyChart).
    const tickInterval = data.length > 30 ? Math.ceil(data.length / 12) - 1 : 0;

    return (
        <div className="h-[260px] w-full sm:h-[300px]">
            <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={data} margin={{ top: 12, right: 8, bottom: 0, left: 0 }}>
                    <CartesianGrid stroke="#eceef1" strokeDasharray="3 4" vertical={false} />
                    <XAxis
                        dataKey="date"
                        tick={{ fill: '#7b8492', fontSize: 11 }}
                        axisLine={{ stroke: '#e3e6ea' }}
                        tickLine={false}
                        interval={tickInterval}
                    />
                    <YAxis
                        tickFormatter={(v) => formatCnyTick(v * cnyPerQuota)}
                        tick={{ fill: '#7b8492', fontSize: 11 }}
                        axisLine={false}
                        tickLine={false}
                        width={52}
                    />
                    <Tooltip
                        content={<ChartTooltip cnyPerQuota={cnyPerQuota} />}
                        cursor={{ stroke: '#c6cad0', strokeWidth: 1 }}
                    />
                    <Legend wrapperStyle={{ fontSize: 11, color: '#5d6675' }} iconType="plainline" />
                    {models.map((m, idx) => (
                        <Area
                            key={m}
                            type="monotone"
                            dataKey={m}
                            stackId="quota"
                            stroke={colorFor(m, idx)}
                            fill={colorFor(m, idx)}
                            fillOpacity={0.1}
                            strokeWidth={1.8}
                            strokeDasharray={idx === 0 ? undefined : idx % 2 === 0 ? '3 2' : undefined}
                            activeDot={{ r: 3, strokeWidth: 0 }}
                        />
                    ))}
                </AreaChart>
            </ResponsiveContainer>
        </div>
    );
}
