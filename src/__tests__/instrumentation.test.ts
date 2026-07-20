import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const setGlobalDispatcher = vi.fn();
const Agent = vi.fn();
vi.mock('undici', () => ({ setGlobalDispatcher, Agent }));

describe('instrumentation register()', () => {
    const orig = process.env.NEXT_RUNTIME;
    beforeEach(() => {
        setGlobalDispatcher.mockClear();
        Agent.mockClear();
    });
    afterEach(() => {
        if (orig === undefined) delete process.env.NEXT_RUNTIME;
        else process.env.NEXT_RUNTIME = orig;
    });

    it('nodejs runtime → 装 headersTimeout/bodyTimeout=600s 的 dispatcher', async () => {
        process.env.NEXT_RUNTIME = 'nodejs';
        const { register } = await import('../../instrumentation');
        await register();
        expect(Agent).toHaveBeenCalledWith({ headersTimeout: 600_000, bodyTimeout: 600_000 });
        expect(setGlobalDispatcher).toHaveBeenCalledTimes(1);
    });

    it('非 nodejs runtime(edge)→ 不装 dispatcher', async () => {
        process.env.NEXT_RUNTIME = 'edge';
        const { register } = await import('../../instrumentation');
        await register();
        expect(setGlobalDispatcher).not.toHaveBeenCalled();
        expect(Agent).not.toHaveBeenCalled();
    });
});
