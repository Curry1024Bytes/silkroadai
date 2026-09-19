import { randomBytes } from 'node:crypto';

/** 官方 images 响应 `data[].generation_id`(2026-09-17 官方 key 实测每张图都带,值为不透明 id)。
 *  上游(号池 / Adobe 转售)不给 → 本地生成 `ig_` + 32 hex(对齐 OpenAI 图片生成 id 的形态,best-effort:
 *  官方原值格式未留档);只保证唯一与形态稳定,不承载语义。 */
export function newGenerationId(): string {
    return `ig_${randomBytes(16).toString('hex')}`;
}
