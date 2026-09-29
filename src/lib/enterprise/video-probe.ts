/**
 * 成片实测元数据(时长 / 宽高比)—— 给「上游不回显已推导值」的渠道兜底。
 *
 * 国内版 xinhankr 线的查询响应只有 {status, data[].url, usage},不带 duration / ratio / resolution
 * (2026-09-30 生产 key 直查实锤)。客户传 duration=-1(智能时长)或不传 ratio(模型自选)时,
 * 库里只有提交参数(-1 / 空)→ 火山形查询响应回显的不是成片真值,客户按回显字段对账就乱了
 * (2026-09-29 客户测试报告:回显 duration=-1,成片实测 10.101s;回显 ratio 16:9,成片 720×1280)。
 *
 * 做法:成片 mp4 的 moov 在文件头(火山 VOD faststart,实测 moov 4-9KB),一次 Range 请求读头部
 * 就能拿到 mvhd 时长 + tkhd 宽高,不用下整片。任何失败 → null,调用方回落,绝不影响轮询主流程。
 */
import 'server-only';
import { readMp4DurationSec, readVideoMeta } from './assets';

const PROBE_BYTES = 262144; // 256KB:moov 实测 <10KB,留足余量
const PROBE_TIMEOUT_MS = 5000;

export interface ProbedVideoMeta {
    /** 成片真实时长(秒,未取整)。 */
    durationSec: number | null;
    width: number | null;
    height: number | null;
}

/** 火山官方 ratio 枚举(不含 adaptive —— 那是入参取值,不是成片形态)。 */
const STANDARD_RATIOS: Array<[string, number]> = [
    ['21:9', 21 / 9],
    ['16:9', 16 / 9],
    ['4:3', 4 / 3],
    ['1:1', 1],
    ['3:4', 3 / 4],
    ['9:16', 9 / 16],
];

/** 宽高 → 最接近的火山官方 ratio 枚举值(成片像素会按 16 对齐,如 1282×720 / 1248×704,故取最近而非精确匹配)。 */
export function ratioFromDimensions(width: number, height: number): string | null {
    if (!(width > 0) || !(height > 0)) return null;
    const r = width / height;
    let best: string | null = null;
    let bestDiff = Infinity;
    for (const [name, v] of STANDARD_RATIOS) {
        // 比例空间用对数距离:16:9 与 9:16 对称,不偏向横屏
        const diff = Math.abs(Math.log(r / v));
        if (diff < bestDiff) {
            bestDiff = diff;
            best = name;
        }
    }
    return best;
}

/** 成片时长 → 火山官方回显口径(整数秒):4.087 → 4、10.101 → 10、25.056 → 25。 */
export function roundDurationSec(sec: number): number {
    return Math.max(1, Math.round(sec));
}

/** Range 读成片头部并解析。上游不支持 Range(回 200 全量)时只读前 PROBE_BYTES 就断开。 */
export async function probeVideoMeta(url: string): Promise<ProbedVideoMeta | null> {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), PROBE_TIMEOUT_MS);
    try {
        const res = await fetch(url, { headers: { Range: `bytes=0-${PROBE_BYTES - 1}` }, signal: ctl.signal });
        if (!res.ok || !res.body) return null;
        const chunks: Buffer[] = [];
        let got = 0;
        const reader = res.body.getReader();
        while (got < PROBE_BYTES) {
            const { done, value } = await reader.read();
            if (done) break;
            chunks.push(Buffer.from(value));
            got += value.byteLength;
        }
        await reader.cancel().catch(() => {});
        const buf = Buffer.concat(chunks).subarray(0, PROBE_BYTES);
        const durationSec = readMp4DurationSec(buf);
        const meta = readVideoMeta(buf);
        if (durationSec == null && meta.w == null) return null;
        return {
            durationSec: durationSec != null && durationSec > 0 ? durationSec : null,
            width: meta.w ?? null,
            height: meta.h ?? null,
        };
    } catch {
        return null;
    } finally {
        clearTimeout(timer);
    }
}
