/**
 * prompt 文本 token 计数(o200k_base,gpt-image / gpt-5 系同款 BPE)。
 *
 * 历史:image-adapter / image-adapter25 合成 usage 时文本部分用「CJK×1.5 + 其余字符/4」粗估,
 * 英文长 prompt 系统性偏高 ~20%(2026-09-16 客户实测:同一 prompt 官方 668 vs 我方 798)。
 * 客户拿官方 usage 逐字段核对时 text_tokens 必须能对上,所以换成真 tokenizer(PR #471)。
 *
 * gpt-tokenizer 的 o200k_base 子路径按需加载,首次 encode 会构建词表(~几十 ms),之后常驻。
 */
import { countTokens } from 'gpt-tokenizer/encoding/o200k_base';

/** 纯 BPE 计数(无任何模板开销)。 */
export function countTextTokens(s: string): number {
    if (!s) return 0;
    return Math.max(1, countTokens(s));
}

/**
 * OpenAI images API(gpt-image-2)对 prompt 报的 `usage.input_tokens_details.text_tokens` =
 * o200k(prompt) + 6 —— 6 是官方在 prompt 外包的固定模板/特殊 token 开销。
 *
 * 2026-09-16 用官方 key 直打 api.openai.com 实测,generations 5 组 + edits 1 组【全部恰好 +6】:
 *   "a cat" 2→8、133 字符英文句 31→37、客户 3164 字符 prompt 636→642、同文补换行 654→660、
 *   中文 35 字 34→40、edits 同一英文句 31→37。
 * 客户对账场景(#471 上线后反馈"文字 token 比官方少一点")就是差这个常数。
 */
export const IMAGE_PROMPT_TEMPLATE_OVERHEAD = 6;

/** images API 口径的 prompt 文本 token(= 纯计数 + 官方固定开销)。空 prompt 返 0(不合成开销)。 */
export function countImagePromptTokens(s: string): number {
    if (!s) return 0;
    return countTextTokens(s) + IMAGE_PROMPT_TEMPLATE_OVERHEAD;
}
