import { afterEach, describe, expect, it, vi } from 'vitest';
import { pollSvcinfTask } from '../svcinf-client';
const cfg = { base: 'http://fixture.test', key: 'fixture', api: 'v2' as const };
const tag = { log: 'version-test', errType: 'seedance_adapter_error' };
const absent = () => new Response(JSON.stringify({ error: { message: 'Task not found' } }), { status: 404 });
afterEach(() => vi.restoreAllMocks());

describe('unknown API version lookup does not turn outages into task absence', () => {
    it.each([503, 429, 401])('preserves fallback HTTP %s after the configured version returned 404', async (status) => {
        const send = vi
            .spyOn(global, 'fetch')
            .mockResolvedValueOnce(absent())
            .mockResolvedValueOnce(
                new Response(JSON.stringify({ error: { message: 'temporarily unavailable or unauthorized' } }), {
                    status,
                }),
            );
        const response = await pollSvcinfTask(cfg, 'cgt-fixture', 'mvt-fixture', tag, { apiVersion: null });
        expect(response.status).toBe(status);
        expect((await response.json()).error.category).not.toBe('task_gone');
        expect(send).toHaveBeenCalledTimes(2);
        expect(String(send.mock.calls[0][0])).toContain('/v2/');
        expect(String(send.mock.calls[1][0])).toContain('/v1/');
    });
    it('reports absence only when both API versions explicitly return not found', async () => {
        const send = vi.spyOn(global, 'fetch').mockImplementation(async () => absent());
        const response = await pollSvcinfTask(cfg, 'cgt-fixture', 'mvt-fixture', tag, { apiVersion: null });
        expect(response.status).toBe(404);
        expect(send).toHaveBeenCalledTimes(2);
    });
    it('a fallback network failure remains retryable rather than returning the earlier 404', async () => {
        vi.spyOn(global, 'fetch')
            .mockResolvedValueOnce(absent())
            .mockRejectedValueOnce(new Error('network interrupted'));
        const response = await pollSvcinfTask(cfg, 'cgt-fixture', 'mvt-fixture', tag, { apiVersion: null });
        expect(response.status).toBe(502);
        expect((await response.json()).error.code).toBe('upstream_unreachable');
    });
    it('an unstructured fallback 404 page does not prove that the task is gone', async () => {
        vi.spyOn(global, 'fetch')
            .mockResolvedValueOnce(absent())
            .mockResolvedValueOnce(new Response('<html>route unavailable</html>', { status: 404 }));
        const response = await pollSvcinfTask(cfg, 'cgt-fixture', 'mvt-fixture', tag, { apiVersion: null });
        expect((await response.json()).error.category).not.toBe('task_gone');
    });
});
