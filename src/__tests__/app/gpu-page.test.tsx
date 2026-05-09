/**
 * /gpu — public GPU rental landing page (W7 PR-P) SSR smoke.
 *
 * Same shallow `react-dom/server` pattern used elsewhere — assert the
 * contract surface (3 SKUs render, contact strings present, anchor hub
 * links work). No client JS / hydration / fetch is exercised.
 */
import { describe, expect, it } from 'vitest';
import { renderToString } from 'react-dom/server';
import GpuPage, { metadata } from '@/app/gpu/page';
import { GPU_SKUS, CONTACT, CUSTOMER_TYPES, ADVANTAGES, SERVICE_STEPS } from '@/data/gpu-pricing';
import { GPU_PAGE_STRINGS, t } from '@/i18n/gpu-page';

describe('/gpu page — header + chrome', () => {
    it('renders the brand <Logo /> + 首页 + API 控制台 nav (W7 D4 PR-Q — no /pricing, no scattered "注册")', () => {
        const html = renderToString(<GpuPage />);
        expect(html).toMatch(/<img[^>]*alt="Silk Road AI"/);
        expect(html).toMatch(/href="\/"[^>]*>[^<]*首页/);
        expect(html).toMatch(/href="\/portal\/register"/);
        // Single brand-accent solid CTA replaced the old trio.
        expect(html).toContain('API 控制台');
        // /pricing page does not exist yet — link removed to stop 404s.
        expect(html).not.toMatch(/href="\/pricing"/);
        expect(html).not.toContain('API 价格');
        // Bare "注册" wording was merged into "API 控制台".
        expect(html).not.toMatch(/>注册</);
    });

    it('exposes the hero title + subtitle + CTA + WeChat handle', () => {
        const html = renderToString(<GpuPage />);
        expect(html).toContain(t('hero_title'));
        expect(html).toContain(t('hero_subtitle'));
        expect(html).toContain(t('hero_cta'));
        expect(html).toContain(CONTACT.wechat);
    });

    it('hero CTA anchors to #contact (the in-page contact section)', () => {
        const html = renderToString(<GpuPage />);
        expect(html).toMatch(/href="#contact"/);
        expect(html).toMatch(/id="contact"/);
    });
});

describe('/gpu page — pricing cards', () => {
    it('renders all 3 SKUs from data/gpu-pricing.ts in display order', () => {
        const html = renderToString(<GpuPage />);
        // Each SKU's name surfaces verbatim
        for (const sku of GPU_SKUS) {
            expect(html, `SKU ${sku.name} should render`).toContain(sku.name);
        }
        // Order check — use the SKU's `memory` field as a card-specific
        // anchor (the names alone collide with the hero copy "从 H100 到
        // B300" which surfaces "B300" before any card).
        const positions = GPU_SKUS.map((sku) => html.indexOf(sku.memory));
        for (let i = 0; i < positions.length - 1; i++) {
            expect(
                positions[i] >= 0 && positions[i + 1] >= 0 && positions[i] < positions[i + 1],
                `${GPU_SKUS[i].name} should render before ${GPU_SKUS[i + 1].name}`,
            ).toBe(true);
        }
    });

    it('renders SKU architecture + memory specs', () => {
        const html = renderToString(<GpuPage />);
        for (const sku of GPU_SKUS) {
            expect(html).toContain(sku.architecture);
            expect(html).toContain(sku.memory);
        }
    });

    it('renders monthly price ranges for SKUs with `from + to`', () => {
        const html = renderToString(<GpuPage />);
        // H100: ¥80,000 .. ¥120,000
        expect(html).toMatch(/¥80,000/);
        expect(html).toMatch(/¥120,000/);
        // H200: ¥120,000 .. ¥180,000
        expect(html).toMatch(/¥180,000/);
    });

    it('renders the "询价 / 预订" customLabel for B300 (no published price)', () => {
        const html = renderToString(<GpuPage />);
        expect(html).toContain('询价 / 预订');
    });

    it('renders min lease term + min quantity per SKU', () => {
        const html = renderToString(<GpuPage />);
        for (const sku of GPU_SKUS) {
            expect(html).toContain(sku.minQuantity);
        }
        // 月起 from H100 + H200, 季起 from B300
        expect(html).toContain('月起');
        expect(html).toContain('季起');
    });

    it('renders use-case chips per SKU', () => {
        const html = renderToString(<GpuPage />);
        // HTML serializer escapes `&` → `&amp;`. Compare against a
        // normalized version to keep the test resilient to future
        // entity-set differences without losing accuracy.
        const normalized = html.replace(/&amp;/g, '&');
        for (const sku of GPU_SKUS) {
            for (const uc of sku.useCases) {
                expect(normalized).toContain(uc);
            }
        }
    });

    it('renders highlight ribbons when `highlight` is set', () => {
        const html = renderToString(<GpuPage />);
        // H200 + B300 both have highlights; H100 doesn't
        expect(html).toContain('高显存 · 大模型推理首选');
        expect(html).toContain('旗舰 · 最新一代');
    });
});

describe('/gpu page — service flow', () => {
    it('renders all 4 service steps in order', () => {
        const html = renderToString(<GpuPage />);
        for (const step of SERVICE_STEPS) {
            expect(html).toContain(step.title);
            expect(html).toContain(step.body);
        }
    });
});

describe('/gpu page — advantages + customers', () => {
    it('renders 3 advantage cards', () => {
        const html = renderToString(<GpuPage />);
        // Same entity-normalization as above — `"` becomes `&quot;` in
        // the SSR output for the inner advantage copy ("东数西算"
        // quotes etc.).
        const normalized = html.replace(/&amp;/g, '&').replace(/&quot;/g, '"');
        for (const adv of ADVANTAGES) {
            expect(normalized).toContain(adv.title);
            expect(normalized).toContain(adv.body);
        }
        expect(normalized).toContain('东数西算');
    });

    it('renders 4 customer-type chips', () => {
        const html = renderToString(<GpuPage />);
        const normalized = html.replace(/&amp;/g, '&');
        for (const c of CUSTOMER_TYPES) {
            expect(normalized).toContain(c);
        }
    });
});

describe('/gpu page — contact section', () => {
    it('renders WeChat handle + email + overseas note', () => {
        const html = renderToString(<GpuPage />);
        expect(html).toContain(CONTACT.wechat);
        expect(html).toContain(CONTACT.email);
        expect(html).toContain(CONTACT.overseasNote);
        // mailto: link wired
        expect(html).toMatch(new RegExp(`href="mailto:${CONTACT.email}"`));
    });

    it('renders the back-to-landing link', () => {
        const html = renderToString(<GpuPage />);
        // Anchor href="/" appears at least once (header has one too — that's fine)
        expect(html).toMatch(/href="\/"/);
        expect(html).toContain(t('contact_back_to_landing'));
    });

    it('renders the ← 返回首页 affordance next to the hero h1 (W7 D4 PR-R Item D)', () => {
        const html = renderToString(<GpuPage />);
        // PR-R Item D adds a small muted-ink ← back-to-landing link
        // above the hero h1 to match /models + /docs. The page chrome
        // already has a 首页 link on the right, but the left-aligned
        // affordance helps deep-linked visitors who scan the hero
        // first.
        expect(html).toContain('返回首页');
    });
});

describe('/gpu page — meta tags + SEO', () => {
    it('exports metadata with title + description + GPU keywords', () => {
        expect(metadata.title).toMatch(/GPU 租赁/);
        expect(metadata.title).toMatch(/Silk Road AI/);
        expect(typeof metadata.description).toBe('string');
        expect(metadata.description).toMatch(/H100/);
        expect(metadata.description).toMatch(/H200/);
        expect(metadata.description).toMatch(/B300/);
    });

    it('keyword set covers brief-required terms (GPU 租赁 / H100 / H200 / B300 / AI 算力 / 东数西算)', () => {
        const required = ['GPU 租赁', 'H100', 'H200', 'B300', 'AI 算力', '东数西算'];
        const kw = (metadata.keywords as string[]) ?? [];
        const flat = kw.join(' ');
        for (const r of required) {
            expect(flat, `keywords should include "${r}"`).toContain(r);
        }
    });

    it('has openGraph + twitter blocks pointing at /gpu', () => {
        expect(metadata.openGraph).toBeTruthy();
        expect(metadata.openGraph?.url).toBe('/gpu');
        expect(metadata.twitter).toBeTruthy();
        expect(metadata.alternates?.canonical).toBe('/gpu');
    });
});

describe('/gpu page — i18n hook (W7 PR-P)', () => {
    it('all entries in GPU_PAGE_STRINGS have a non-empty `zh` field', () => {
        for (const [id, entry] of Object.entries(GPU_PAGE_STRINGS)) {
            expect(typeof entry.zh, `${id}.zh should be a string`).toBe('string');
            expect(entry.zh.length, `${id}.zh should not be empty`).toBeGreaterThan(0);
        }
    });

    it('en field is reserved (entries optionally carry it; today none do)', () => {
        for (const [id, entry] of Object.entries(GPU_PAGE_STRINGS)) {
            // en can be present or absent; if present it must be a string.
            if (entry.en !== undefined) {
                expect(typeof entry.en, `${id}.en if set should be a string`).toBe('string');
            }
        }
    });

    it('t(id) returns the zh value', () => {
        expect(t('hero_title')).toBe(GPU_PAGE_STRINGS.hero_title.zh);
        expect(t('contact_section_title')).toBe(GPU_PAGE_STRINGS.contact_section_title.zh);
    });

    it('t(id) throws on unknown id (catches typos at SSR)', () => {
        expect(() => t('this_does_not_exist' as keyof typeof GPU_PAGE_STRINGS)).toThrow(/unknown string id/);
    });
});
