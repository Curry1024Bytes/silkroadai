/**
 * /models — 模型广场页壳 SSR smoke(2026-10-22,vendored new-api plaza)。
 *
 * 广场本体是 `ssr:false` 客户端岛(浏览器里才跑),这里只断言 portal 负责的
 * 服务端部分:页面壳 + 运行时配置读取 + metadata。next/dynamic 在 vitest node
 * 环境下不可用,直接 mock 成占位。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderToString } from 'react-dom/server';

const mockLoadPlazaRuntime = vi.fn();
vi.mock('@/app/models/runtime', () => ({
    loadPlazaRuntime: (...a: unknown[]) => mockLoadPlazaRuntime(...a),
}));
vi.mock('@/app/models/plaza-loader', () => ({
    PlazaLoader: (props: { runtime: { price: number; server_address: string } }) => (
        <div data-testid="plaza-island" data-price={props.runtime.price} data-server={props.runtime.server_address} />
    ),
}));

import ModelsPage, { generateMetadata } from '@/app/models/page';
import { DEFAULT_PLAZA_RUNTIME } from '@newapi/lib/plaza-runtime';

beforeEach(() => {
    mockLoadPlazaRuntime.mockResolvedValue({ ...DEFAULT_PLAZA_RUNTIME, price: 7.2 });
});
afterEach(() => {
    vi.clearAllMocks();
});

describe('/models page shell', () => {
    it('renders the portal chrome and mounts the plaza island with the server-resolved runtime', async () => {
        const html = renderToString(await ModelsPage());
        expect(html).toContain('返回首页');
        expect(html).toContain('Connecting Global Intelligence.');
        expect(html).toContain('data-testid="plaza-island"');
        expect(html).toContain('data-price="7.2"');
        expect(html).toContain('data-server="https://ai.silkroadai.io"');
        expect(mockLoadPlazaRuntime).toHaveBeenCalledTimes(1);
    });

    it('declares 模型广场 metadata', async () => {
        const metadata = await generateMetadata();
        expect(metadata.title).toContain('模型广场');
        expect(metadata.description).toContain('模型');
    });

    it('still renders when the runtime loader falls back to defaults', async () => {
        mockLoadPlazaRuntime.mockResolvedValue({ ...DEFAULT_PLAZA_RUNTIME });
        const html = renderToString(await ModelsPage());
        expect(html).toContain(`data-price="${DEFAULT_PLAZA_RUNTIME.price}"`);
    });
});
