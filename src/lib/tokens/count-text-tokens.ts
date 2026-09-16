/**
 * prompt 文本真 token 计数(o200k_base,gpt-image / gpt-5 系同款 BPE)。
 *
 * 历史:image-adapter / image-adapter25 合成 usage 时文本部分用「CJK×1.5 + 其余字符/4」粗估,
 * 英文长 prompt 系统性偏高 ~20%(2026-09-16 客户实测:同一 prompt 官方 668 vs 我方 798)。
 * 客户拿官方 usage 逐字段核对时 text_tokens 必须能对上,所以换成真 tokenizer。
 *
 * gpt-tokenizer 的 o200k_base 子路径按需加载,首次 encode 会构建词表(~几十 ms),之后常驻。
 */
import { countTokens } from 'gpt-tokenizer/encoding/o200k_base';

export function countTextTokens(s: string): number {
    if (!s) return 0;
    return Math.max(1, countTokens(s));
}
