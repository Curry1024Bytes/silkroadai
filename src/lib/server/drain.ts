/**
 * 滚动部署排空钩子(2026-10-20)。
 *
 * 问题:每次 deploy-image-adapter.sh 逐台 `--force-recreate` 十个副本,new-api 在 3 分钟内记
 * 3,000+ 条 `502 bad response status code`(在途生图被掐断,同渠道重试又撞下一台重启副本)。
 * Next standalone 收 SIGTERM 本就会 `server.close()` 等在途请求做完再 `process.exit(0)`,
 * 但两件事让它没用上:
 *  1. compose 默认 stop_grace_period 10s → SIGKILL(生图 20–600s)—— 由 compose `stop_grace_period`
 *     + deploy 脚本 `docker stop -t` 解决;
 *  2. Node `server.close()` 只关【空闲】长连接;Caddy 池里已有的 keep-alive 连接在响应完成后仍会被
 *     复用送新请求进来(实测 Node 22/25 均如此),排空永远收不住 → 最终还是被 SIGKILL。
 *     本模块解决这一条:SIGTERM 之后每个响应头带 `Connection: close`,Caddy 响应完即弃连,
 *     新请求只能重新拨号 → 监听已关 → Caddy `lb_try_duration` 立刻换副本。
 *  3. (2026-11-06)Next 自己的 SIGTERM 处理只在 **dev** 调 `server.closeAllConnections()`
 *     (`next/dist/server/lib/start-server.js`),生产只 `server.close()`。空闲 keep-alive 连接
 *     不会再收到响应,第 2 条的 `Connection: close` 碰不到它们,`close()` 于是一直等对端 →
 *     主站 Portal(单容器、nginx `Connection ""` 长连接)实测被 compose 等满 630s 才 SIGKILL,
 *     公网 502 持续 246 秒。本模块现在在排空时调 `server.closeIdleConnections()`:只关空闲连接,
 *     在途请求照常做完(由第 2 条带 `Connection: close` 收尾)。
 *
 * 实现:包一层 `http.ServerResponse.prototype.writeHead`(显式 writeHead 与隐式 flush 都经它),
 * 排空中且头未发则 setHeader('Connection','close');同时记下响应所属的 server,排空时关其空闲连接。
 * 只在 nodejs runtime 装;幂等。
 */
import type http from 'node:http';

type Opts = {
    /** 触发排空的信号;默认 SIGTERM(docker stop / compose 发的就是它)。 */
    signal?: NodeJS.Signals;
    /** 不传则不挂信号监听(测试用 startDraining 手动触发)。 */
    proc?: NodeJS.Process | null;
    log?: (msg: string) => void;
};

export type DrainHook = {
    isDraining: () => boolean;
    startDraining: () => void;
    /** 测试用:已观察到的 server 数量。 */
    trackedServers: () => number;
    /** 测试用:还原 prototype。 */
    uninstall: () => void;
};

const INSTALLED = Symbol.for('silkroadai.drainHook');

export function installDrainHook(httpMod: typeof http, opts: Opts = {}): DrainHook {
    const proto = httpMod.ServerResponse.prototype as typeof http.ServerResponse.prototype & {
        [INSTALLED]?: DrainHook;
    };
    if (proto[INSTALLED]) return proto[INSTALLED];

    let draining = false;
    const log = opts.log ?? ((m: string) => console.log(m));
    const origWriteHead = proto.writeHead;
    /** Servers seen through a response, so draining can close their idle connections. */
    const servers = new Set<http.Server>();

    proto.writeHead = function (this: http.ServerResponse, ...args: unknown[]) {
        // `socket.server` is the http.Server that accepted the connection.
        const server = (this.socket as { server?: http.Server } | null)?.server;
        if (server) servers.add(server);
        if (draining && !this.headersSent) {
            this.shouldKeepAlive = false;
            this.setHeader('Connection', 'close');
            // Explicit writeHead headers take precedence over setHeader, including
            // the raw alternating-name/value form and the statusMessage overload.
            const headersIndex = typeof args[1] === 'string' ? 2 : 1;
            const headers = args[headersIndex];
            if (Array.isArray(headers)) {
                const replacement: unknown[] = [];
                for (let i = 0; i < headers.length; i += 2) {
                    if (String(headers[i]).toLowerCase() !== 'connection') replacement.push(headers[i], headers[i + 1]);
                }
                args[headersIndex] = [...replacement, 'Connection', 'close'];
            } else if (headers && typeof headers === 'object') {
                args[headersIndex] = {
                    ...Object.fromEntries(
                        Object.entries(headers).filter(([name]) => name.toLowerCase() !== 'connection'),
                    ),
                    Connection: 'close',
                };
            }
        }
        return Reflect.apply(origWriteHead, this, args) as http.ServerResponse;
    } as typeof proto.writeHead;

    const startDraining = () => {
        if (draining) return;
        draining = true;
        // Next closes idle connections only in dev, so in production server.close()
        // waits for nginx's idle keep-alive sockets and the stop grace period runs
        // out. Close exactly those; in-flight requests finish and the header above
        // keeps their connection from being reused.
        let closed = 0;
        for (const server of servers) {
            try {
                server.closeIdleConnections();
                closed += 1;
            } catch {
                /* Older runtimes without closeIdleConnections; the header still applies. */
            }
        }
        log(
            `[drain] SIGTERM received: responses now carry Connection: close; closed idle connections on ${closed} server(s), waiting for in-flight requests`,
        );
    };

    const proc = opts.proc === undefined ? process : opts.proc;
    const signal = opts.signal ?? 'SIGTERM';
    if (proc) proc.once(signal, startDraining);

    const hook: DrainHook = {
        isDraining: () => draining,
        startDraining,
        trackedServers: () => servers.size,
        uninstall: () => {
            proto.writeHead = origWriteHead;
            delete proto[INSTALLED];
            servers.clear();
            if (proc) proc.off(signal, startDraining);
        },
    };
    proto[INSTALLED] = hook;
    return hook;
}
