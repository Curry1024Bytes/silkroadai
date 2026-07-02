import 'server-only';
import { NodeHttpHandler } from '@smithy/node-http-handler';
import { SocksProxyAgent } from 'socks-proxy-agent';

/**
 * 图像存储(S3 / R2 / 客户 OSS 上传)的 requestHandler。
 *
 * 背景:2026-07-01 事故 —— VPS 提供商上游线路(Hurricane Electric)路由黑洞,
 * 所有存储 endpoint(平台 R2 + 客户阿里/腾讯 OSS + 客户 R2)直连全部 ETIMEDOUT。
 * 之前只给 new-api 出图配了代理,存图这步漏了,导致图秒出但卡在"存储"→客户超时。
 *
 * 两个作用:
 *  1. 可选走 SOCKS5 代理(env `IMAGE_STORAGE_PROXY`)绕过坏线路;线路修好后清空
 *     该 env 即回直连,无需改代码/重新部署逻辑。
 *  2. 无论有无代理都带**短超时** —— 存储连不上时快速失败,让 storeGeneratedImage
 *     的三级降级(客户OSS→平台R2→data URL)及时兜底,而不是干等几十秒把整个图像
 *     请求拖垮(本次事故根因)。
 */
export function storageRequestHandler(): NodeHttpHandler {
    const proxy = process.env.IMAGE_STORAGE_PROXY;
    const connectionTimeout = 8_000;
    const requestTimeout = 25_000;
    if (!proxy) {
        return new NodeHttpHandler({ connectionTimeout, requestTimeout });
    }
    const agent = new SocksProxyAgent(proxy);
    return new NodeHttpHandler({ httpAgent: agent, httpsAgent: agent, connectionTimeout, requestTimeout });
}
