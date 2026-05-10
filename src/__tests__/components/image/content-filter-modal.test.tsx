/**
 * PR-T3 — ContentFilterModal SSR smoke.
 */
import { describe, expect, it } from 'vitest';
import { renderToString } from 'react-dom/server';
import { ContentFilterModal } from '@/components/image/ContentFilterModal';

describe('<ContentFilterModal />', () => {
    it('renders nothing when open=false', () => {
        const html = renderToString(<ContentFilterModal open={false} onClose={() => {}} />);
        expect(html).toBe('');
    });

    it('shows the content-filter copy + the 4 disallowed categories when open', () => {
        const html = renderToString(<ContentFilterModal open={true} onClose={() => {}} />);
        expect(html).toContain('内容审核未通过');
        expect(html).toContain('您的提示词触发了内容审核');
        // 4 categories
        expect(html).toContain('暴力');
        expect(html).toContain('色情');
        expect(html).toContain('真人脸');
        expect(html).toContain('政治敏感');
        // No-charge reassurance
        expect(html).toContain('本次未扣费');
    });

    it('does NOT leak raw upstream error message (3rd-party brand names etc.)', () => {
        const html = renderToString(<ContentFilterModal open={true} onClose={() => {}} />);
        // The component takes no props that surface raw errors — the
        // friendly copy is fixed. Sanity check that no obvious leak
        // pattern shows up.
        expect(html).not.toMatch(/openai|google|gemini|sub2api|nano-banana/i);
    });
});
