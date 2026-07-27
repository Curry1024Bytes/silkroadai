/**
 * /tools 工具箱索引页 SSR smoke — 控制台侧边栏「工具箱」指向此页(不跳落地页)。
 * 断言 5 张工具卡的标题 + href 都在。next/link 在 renderToString 下渲染为 <a href>。
 */
import { describe, expect, it } from 'vitest';
import { renderToString } from 'react-dom/server';
import ToolsIndexPage from '@/app/(authenticated)/tools/page';

describe('工具箱 /tools index', () => {
    it('renders the 5 tool cards with correct hrefs', () => {
        const html = renderToString(<ToolsIndexPage />);
        expect(html).toContain('工具箱');
        expect(html).toContain('Seedance 视频测试');
        expect(html).toContain('AI 对话测试');
        expect(html).toContain('AI 生图测试');
        expect(html).toMatch(/href="\/tools\/seedance"/);
        expect(html).toMatch(/href="\/tools\/chat"/);
        expect(html).toMatch(/href="\/tools\/image"/);
        expect(html).toMatch(/href="\/workspace\/docs#codex-cli"/);
        expect(html).toMatch(/href="\/workspace\/docs#claude-code"/);
    });
});
