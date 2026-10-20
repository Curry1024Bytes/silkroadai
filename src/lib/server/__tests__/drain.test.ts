/**
 * drain.ts —— 排空钩子:SIGTERM 之后响应头带 Connection: close(Caddy 不再复用长连接送新请求)。
 * 用真 http server + keep-alive agent 验证,不 mock Node。
 */
import { describe, it, expect, afterEach } from 'vitest';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import { installDrainHook, type DrainHook } from '@/lib/server/drain';

function request(port: number, agent: http.Agent, path: string) {
    return new Promise<{ status: number; connection: string | undefined; body: string }>((resolve, reject) => {
        const req = http.request({ port, path, method: 'POST', agent }, (res) => {
            let body = '';
            res.on('data', (d) => (body += d));
            res.on('end', () => resolve({ status: res.statusCode ?? 0, connection: res.headers.connection, body }));
        });
        req.on('error', reject);
        req.end('x');
    });
}

describe('installDrainHook', () => {
    let hook: DrainHook | null = null;
    let server: http.Server | null = null;
    afterEach(async () => {
        hook?.uninstall();
        hook = null;
        if (server) await new Promise((r) => server!.close(r));
        server = null;
    });

    it('未排空:响应保持 keep-alive;排空后:显式与隐式 writeHead 都带 Connection: close', async () => {
        hook = installDrainHook(http, { proc: null, log: () => {} });
        server = http.createServer((req, res) => {
            if (req.url === '/explicit') {
                res.writeHead(200, { 'content-type': 'text/plain' });
                res.end('e');
            } else {
                res.end('i'); // 隐式头
            }
        });
        await new Promise<void>((r) => server!.listen(0, r));
        const port = (server.address() as { port: number }).port;
        const agent = new http.Agent({ keepAlive: true });

        const before = await request(port, agent, '/implicit');
        expect(before.connection).toBe('keep-alive');
        expect(hook.isDraining()).toBe(false);

        hook.startDraining();
        expect(hook.isDraining()).toBe(true);
        const a = await request(port, agent, '/implicit');
        const b = await request(port, agent, '/explicit');
        expect(a).toMatchObject({ status: 200, connection: 'close', body: 'i' });
        expect(b).toMatchObject({ status: 200, connection: 'close', body: 'e' });
        agent.destroy();
    });

    it('幂等:重复 install 返回同一钩子;信号触发排空', () => {
        const proc = new EventEmitter();
        hook = installDrainHook(http, { proc: proc as unknown as NodeJS.Process, log: () => {} });
        const again = installDrainHook(http, { proc: proc as unknown as NodeJS.Process, log: () => {} });
        expect(again).toBe(hook);
        expect(hook.isDraining()).toBe(false);
        proc.emit('SIGTERM');
        expect(hook.isDraining()).toBe(true);
    });
});
