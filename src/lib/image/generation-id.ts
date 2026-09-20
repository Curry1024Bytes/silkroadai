import { randomUUID } from 'node:crypto';

/** 官方 images 响应 `data[].generation_id`:2026-09-19 官方 key 打 gpt-image-2.5 实测为 UUID v4 形态
 *  (如 a412b49c-78f2-4009-9a23-a2e4e0f7b1fd)。上游(号池 / Adobe 转售)不给 → 本地生成 UUID;
 *  只保证唯一与形态稳定,不承载语义。(#478 首版猜的 `ig_`+hex 已纠正。) */
export function newGenerationId(): string {
    return randomUUID();
}
