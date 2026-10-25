/** #558 page-shell regressions, adapted to the shared LLmRoute catalog and fail-closed identity. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderToString } from 'react-dom/server';

const mockLoadPlazaRuntime = vi.fn();
const mockLoadPlazaData = vi.fn();
const mockHeaders = vi.fn();
const mockCurrentUser = vi.fn();
vi.mock('@/app/models/runtime', () => ({ loadPlazaRuntime: (...args: unknown[]) => mockLoadPlazaRuntime(...args) }));
vi.mock('@/lib/models/plaza-data', () => ({ loadPlazaData: (...args: unknown[]) => mockLoadPlazaData(...args) }));
vi.mock('next/headers', () => ({ headers: () => mockHeaders() }));
vi.mock('@/lib/auth/session', () => ({ getCurrentUser: (...args: unknown[]) => mockCurrentUser(...args) }));
vi.mock('@/app/models/plaza-loader', () => ({
    PlazaLoader: (props: {
        runtime: { price: number; server_address: string };
        embedded?: boolean;
        initialData: { data: { model_name: string }[] };
    }) => (
        <div
            data-testid="plaza-island"
            data-price={props.runtime.price}
            data-server={props.runtime.server_address}
            data-embedded={String(Boolean(props.embedded))}
        >
            {props.initialData.data.map((model) => model.model_name).join(',')}
        </div>
    ),
}));
import ModelsPage, { metadata } from '@/app/models/page';
import WorkspaceModelsPage from '@/app/(authenticated)/workspace/models/page';
import { DEFAULT_PLAZA_RUNTIME } from '@newapi/lib/plaza-runtime';

beforeEach(() => {
    vi.clearAllMocks();
    mockLoadPlazaRuntime.mockResolvedValue(DEFAULT_PLAZA_RUNTIME);
    mockLoadPlazaData.mockResolvedValue({ data: [{ model_name: 'gpt-5.5' }], portal_snapshot: 1 });
    mockHeaders.mockResolvedValue(new Headers());
    mockCurrentUser.mockResolvedValue(null);
});
afterEach(() => vi.restoreAllMocks());

describe('/models page shell', () => {
    it('renders the portal chrome and mounts the plaza island with the server-resolved runtime', async () => {
        const html = renderToString(await ModelsPage());
        expect(html).toContain('返回');
        expect(html).toContain('One route. Every model.');
        expect(html).toContain('data-testid="plaza-island"');
        expect(html).toContain('data-price="1"');
        expect(html).toContain('data-server="https://api.llmroute.club"');
        expect(mockLoadPlazaRuntime).toHaveBeenCalledTimes(1);
        expect(mockLoadPlazaData).toHaveBeenCalledWith(null);
    });
    it('declares 模型广场 metadata', () => {
        expect(metadata.title).toBe('模型广场 — LLmRoute');
        expect(metadata.description).toContain('模型');
    });
    it('still renders when the runtime loader falls back to defaults', async () => {
        const html = renderToString(await ModelsPage());
        expect(html).toContain(`data-price="${DEFAULT_PLAZA_RUNTIME.price}"`);
        expect(html).not.toContain('silkroadai.io');
    });
    it('keeps request-context failures closed instead of substituting public prices', async () => {
        mockHeaders.mockRejectedValueOnce(new Error('context unavailable'));
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        const html = renderToString(await ModelsPage());
        expect(html).toContain('当前无法获取模型清单与价格');
        expect(mockLoadPlazaData).not.toHaveBeenCalled();
        expect(html).not.toContain('plaza-island');
    });
    it('passes the signed-in customer to the price loader and does not reuse it for guests', async () => {
        const user = { id: 'customer-a', newapi_user_id: 7, newapi_access_token: 'test' };
        mockHeaders.mockResolvedValueOnce(new Headers({ cookie: 'session=test' }));
        mockCurrentUser.mockResolvedValueOnce(user);
        await ModelsPage();
        expect(mockLoadPlazaData).toHaveBeenLastCalledWith(user);
        await ModelsPage();
        expect(mockLoadPlazaData).toHaveBeenLastCalledWith(null);
    });
    it('does not mount an old public quote after the dedicated price loader fails', async () => {
        mockLoadPlazaData.mockRejectedValueOnce(new Error('Cannot verify dedicated customer price'));
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        const html = renderToString(await ModelsPage());
        expect(html).toContain('当前无法获取模型清单与价格');
        expect(html).not.toContain('plaza-island');
    });
    it('renders empty-data state without inventing models', async () => {
        mockLoadPlazaData.mockResolvedValueOnce({ data: [] });
        const html = renderToString(await ModelsPage());
        expect(html).toContain('plaza-island');
        expect(html).not.toContain('gpt-5.5');
    });
});
describe('<WorkspaceModelsPage /> SSR', () => {
    it('renders the same plaza and tariffs without public-page chrome', async () => {
        const html = renderToString(await WorkspaceModelsPage());
        expect(html).toContain('data-embedded="true"');
        expect(html).toContain('gpt-5.5');
        expect(html).not.toContain('One route. Every model.');
        expect(html).not.toContain('返回');
    });
});
