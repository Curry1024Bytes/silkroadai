/**
 * <BackButton /> SSR smoke — 渲染为可点击的 <button>(浏览器后退,无 useRouter context 依赖)。
 * 点击行为(window.history.back / fallback)无 testing-library 不便单测;此处覆盖渲染契约。
 */
import { describe, expect, it } from 'vitest';
import { renderToString } from 'react-dom/server';
import { BackButton } from '@/components/BackButton';

describe('<BackButton />', () => {
    it('renders a type=button with the given label + className (not an <a href>)', () => {
        const html = renderToString(
            <BackButton className="text-sm text-brand-accent cursor-pointer">← 返回</BackButton>,
        );
        expect(html).toMatch(/<button[^>]*type="button"/);
        expect(html).toContain('← 返回');
        expect(html).toContain('cursor-pointer');
        expect(html).not.toContain('href=');
    });
});
