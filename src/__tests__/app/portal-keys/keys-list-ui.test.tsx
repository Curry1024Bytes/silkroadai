/**
 * W4-2 D5 + W6 D4 — <KeysList /> initial render smoke (react-dom/server).
 *
 * Same pattern as src/__tests__/app/pay-form.test.tsx — no jsdom + RTL
 * setup; assert on initial markup. Interactivity (reveal / copy / revoke /
 * create-flow) covered by manual smoke + future RTL adoption.
 *
 * W6 D4 additions:
 *   - usage subline (累计 + 最近调用) renders per row
 *   - "从未调用" copy when last_used_at is null
 *   - API key creation remains available regardless of the current count
 */
import { describe, expect, it } from 'vitest';
import { renderToString } from 'react-dom/server';
import { KeysList, TierSelect, type KeyRow, type TierOption } from '@/app/(authenticated)/keys/keys-list';

const VALID_TIERS: TierOption[] = [
    {
        key: 'pool',
        display_name: '低价号池',
        description: null,
        is_default: true,
        newapi_group: 'default',
        ratio: 1,
    },
];

const SAMPLE_ROWS: KeyRow[] = [
    {
        id: 'tok-aaa',
        key_alias: 'production',
        masked_key: 'sk-1234****abcd',
        created_at: '2026-05-01T10:00:00.000Z',
        used_quota: 0,
        usedCny: 0,
        last_used_at: null,
        tier: 'pool',
    },
    {
        id: 'tok-bbb',
        key_alias: 'mobile-app',
        masked_key: 'sk-5678****wxyz',
        created_at: '2026-05-02T10:00:00.000Z',
        used_quota: 0,
        usedCny: 0,
        last_used_at: null,
        tier: 'pool',
    },
];

describe('<KeysList /> SSR smoke', () => {
    it('renders empty-state hint when initialRows is []', () => {
        const html = renderToString(<KeysList initialRows={[]} tiers={VALID_TIERS} />);
        // W7 P2: empty-state copy moved into the <EmptyState> primitive.
        // Title + body together; the title is the primary affordance.
        expect(html).toContain('还没有 API Key');
        expect(html).toContain('创建新 Key');
        // Create button present + enabled (no row count yet). Tighten the
        // regex to the actual HTML `disabled=""` attribute since the new
        // Tailwind class strings contain the substring "disabled" (in
        // utility classes like `disabled:opacity-50`).
        expect(html).not.toMatch(/<button[^>]*disabled=""[^>]*>[\s\S]*?创建新 Key/);
    });

    it('renders one row per token with alias + masked key + 显示/复制/撤销 actions', () => {
        const html = renderToString(<KeysList initialRows={SAMPLE_ROWS} />);
        expect(html).toContain('production');
        expect(html).toContain('mobile-app');
        expect(html).toContain('sk-1234****abcd');
        expect(html).toContain('sk-5678****wxyz');
        // Each row has one mobile and one desktop rendering; CSS exposes
        // exactly one at a time, while SSR contains both responsive variants.
        const showCount = (html.match(/>显示</g) ?? []).length;
        const copyCount = (html.match(/>复制</g) ?? []).length;
        const revokeCount = (html.match(/>撤销</g) ?? []).length;
        expect(showCount).toBe(SAMPLE_ROWS.length * 2);
        expect(copyCount).toBe(SAMPLE_ROWS.length * 2);
        expect(revokeCount).toBe(SAMPLE_ROWS.length * 2);
    });

    it('does NOT leak full sk- in masked rendering (only the masked variant)', () => {
        const html = renderToString(<KeysList initialRows={SAMPLE_ROWS} />);
        // Masked form shows sk-XXXX****YYYY but the actual full middle is
        // never present client-side until user clicks 显示
        expect(html).not.toContain('sk-1234567');
        expect(html).not.toContain('sk-5678abc');
    });

    it('keeps the create button enabled when the account already has 10+ keys', () => {
        const fullList: KeyRow[] = Array.from({ length: 12 }, (_, i) => ({
            id: `tok-${i}`,
            key_alias: `key-${i}`,
            masked_key: `sk-aaaa****0000`,
            created_at: '2026-05-01T10:00:00.000Z',
            used_quota: 0,
            usedCny: 0,
            last_used_at: null,
            tier: 'pool',
        }));
        const html = renderToString(<KeysList initialRows={fullList} tiers={VALID_TIERS} />);
        expect(html).not.toContain('已达上限');
        expect(html).toContain('创建新 Key');
        // Tighten to the HTML `disabled=""` attribute (Tailwind utility
        // classes like `disabled:opacity-50` would false-match a looser
        // `[^>]*disabled[^>]*` regex on the new className string).
        expect(html).not.toMatch(/<button[^>]*disabled=""[^>]*>[\s\S]*?创建新 Key/);
    });

    it('does NOT auto-show the create form (open=false initially)', () => {
        const html = renderToString(<KeysList initialRows={SAMPLE_ROWS} />);
        // Brand-new placeholder format introduced in W6 D4
        expect(html).not.toContain('prod-openai');
    });
});

describe('<KeysList /> W6 D4 — per-key usage subline', () => {
    it('shows "从未调用" + ¥0.00 when last_used_at is null', () => {
        const rows: KeyRow[] = [
            {
                id: 'tok-fresh',
                key_alias: 'freshly-created',
                masked_key: 'sk-1111****2222',
                created_at: '2026-05-05T10:00:00.000Z',
                used_quota: 0,
                usedCny: 0,
                last_used_at: null,
                tier: 'pool',
            },
        ];
        const html = renderToString(<KeysList initialRows={rows} />);
        expect(html).toContain('从未调用');
        // React 19 SSR inserts <!-- --> between adjacent text + dynamic
        // nodes (the literal "¥" plus the formatted CNY number).
        expect(html).toMatch(/累计 ¥(<!-- -->)?0\.00/);
    });

    it('renders ¥X.XX accumulated (server usedCny, not client-derived) + relative last-used time', () => {
        // usedCny is computed server-side (correct FX) and passed in; rendered verbatim.
        const aboutADayAgo = new Date(Date.now() - 26 * 60 * 60 * 1000).toISOString();
        const rows: KeyRow[] = [
            {
                id: 'tok-active',
                key_alias: 'prod-openai',
                masked_key: 'sk-3333****4444',
                created_at: '2026-04-01T10:00:00.000Z',
                used_quota: 695_000,
                usedCny: 4.87,
                last_used_at: aboutADayAgo,
                tier: 'pool',
            },
        ];
        const html = renderToString(<KeysList initialRows={rows} />);
        // React 19 inserts <!-- --> between literal ¥ and dynamic value.
        expect(html).toMatch(/累计 ¥(<!-- -->)?4\.87/);
        // client-side quotaToCny(695000) with stale defaults would render ¥10.01 — guard against regression
        expect(html).not.toContain('10.01');
        // 26h ago → "1 天前" (with optional comment)
        expect(html).toMatch(/最近调用 (<!-- -->)?1 天前/);
    });

    it('shows "用量数据暂不可用" when used_quota is null (server fetch failed)', () => {
        const rows: KeyRow[] = [
            {
                id: 'tok-broken',
                key_alias: 'experimental',
                masked_key: 'sk-9999****eeee',
                created_at: '2026-05-04T10:00:00.000Z',
                used_quota: null,
                usedCny: null,
                last_used_at: null,
                tier: 'pool',
            },
        ];
        const html = renderToString(<KeysList initialRows={rows} />);
        expect(html).toContain('用量数据暂不可用');
        // The fallback hides the 累计/最近调用 line entirely
        expect(html).not.toMatch(/累计 ¥/);
    });
});

describe('<KeysList /> W6 D4 — alias placeholder hint', () => {
    // The create form is hidden initially, so an SSR snapshot can't see
    // the alias input directly. Asserting on the unrendered state:
    it('does not render the env-purpose hint until the create form opens', () => {
        const html = renderToString(<KeysList initialRows={[]} />);
        expect(html).not.toContain('env-purpose');
        expect(html).not.toContain('prod-openai');
    });
});

describe('<KeysList /> P3 — 档次 badge', () => {
    const TIERS = [
        {
            key: 'pool',
            display_name: '低价号池',
            description: null,
            is_default: true,
            newapi_group: 'default',
            ratio: 1.3,
        },
        {
            key: 'official',
            display_name: '官方稳定',
            description: '更稳更贵',
            is_default: false,
            newapi_group: 'official',
            ratio: 3.5,
        },
    ];

    it('renders the tier display_name badge per row', () => {
        const rows: KeyRow[] = [
            {
                id: 't1',
                key_alias: 'prod',
                masked_key: 'sk-aaaa****bbbb',
                created_at: '2026-06-01T00:00:00.000Z',
                used_quota: 0,
                usedCny: 0,
                last_used_at: null,
                tier: 'official',
            },
            {
                id: 't2',
                key_alias: 'dev',
                masked_key: 'sk-cccc****dddd',
                created_at: '2026-06-02T00:00:00.000Z',
                used_quota: 0,
                usedCny: 0,
                last_used_at: null,
                tier: 'pool',
            },
        ];
        const html = renderToString(<KeysList initialRows={rows} tiers={TIERS} />);
        expect(html).toContain('官方稳定');
        expect(html).toContain('低价号池');
    });

    it('falls back to the raw tier key when it is not in the tiers list', () => {
        const rows: KeyRow[] = [
            {
                id: 't3',
                key_alias: 'x',
                masked_key: 'sk-eeee****ffff',
                created_at: '2026-06-03T00:00:00.000Z',
                used_quota: 0,
                usedCny: 0,
                last_used_at: null,
                tier: 'legacy',
            },
        ];
        const html = renderToString(<KeysList initialRows={rows} tiers={TIERS} />);
        expect(html).toContain('legacy');
    });

    // ── TierSelect(new-api 风格档次下拉)SSR 渲染 ──
    // 交互(开合 / 搜索 / 点选)是 client 行为,SSR smoke 只守渲染契约。

    it('TierSelect 未选(必选态)→ placeholder「选择一个档次」,不预选任何档', () => {
        const html = renderToString(<TierSelect tiers={TIERS} value={null} onChange={() => {}} />);
        expect(html).toContain('选择一个档次');
        expect(html).not.toContain('低价号池'); // 关闭态不渲染选项列表
    });

    it('TierSelect 已选 → 显示名 + 「Nx 倍率」徽章(与 new-api 同款)', () => {
        const html = renderToString(<TierSelect tiers={TIERS} value="official" onChange={() => {}} />);
        expect(html).toContain('官方稳定');
        expect(html).toContain('3.5x 倍率');
    });

    it('ratio=null(new-api 不可达降级)→ 不渲染倍率徽章', () => {
        const tiers = [{ ...TIERS[0], ratio: null }];
        const html = renderToString(<TierSelect tiers={tiers} value="pool" onChange={() => {}} />);
        expect(html).toContain('低价号池');
        expect(html).not.toContain('倍率');
    });
});
