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
 *
 * 实现:包一层 `http.ServerResponse.prototype.writeHead`(显式 writeHead 与隐式 flush 都经它),
 * 排空中且头未发则 setHeader('Connection','close')。只在 nodejs runtime 装;幂等。
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

    proto.writeHead = function (this: http.ServerResponse, ...args: unknown[]) {
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
        log('[drain] SIGTERM received: responses now carry Connection: close; waiting for in-flight requests');
    };

    const proc = opts.proc === undefined ? process : opts.proc;
    const signal = opts.signal ?? 'SIGTERM';
    if (proc) proc.once(signal, startDraining);

    const hook: DrainHook = {
        isDraining: () => draining,
        startDraining,
        uninstall: () => {
            proto.writeHead = origWriteHead;
            delete proto[INSTALLED];
            if (proc) proc.off(signal, startDraining);
        },
    };
    proto[INSTALLED] = hook;
    return hook;
}
