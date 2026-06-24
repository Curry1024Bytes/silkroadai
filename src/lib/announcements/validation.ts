/**
 * 公告写入校验(server-only)。POST/PUT 共用 `announcementInputSchema`(整体替换
 * 语义 —— admin 编辑 modal 永远提交完整对象,故不做 partial update)。
 *
 * 安全要点:link_url 必须 http(s) —— z.string().url() 会放行 `javascript:` 这类
 * scheme,banner 里 <a href> 渲染就成了 XSS。这里强制协议白名单。
 *
 * link_url / link_label 用 `.nullish()`(nullable + optional)而非 `.nullable()`:
 * 否则请求 body 不带这两个字段时 zod 报 "Required" → 误 400。preprocess 先把
 * 缺失 / null / 空白串统一成 null,落库即 null。
 */
import { z } from 'zod';

/** 缺失 / null / 空白串 → null;否则原样进入下游校验。 */
const emptyToNull = (v: unknown) => (v == null || (typeof v === 'string' && v.trim() === '') ? null : v);

const linkUrlSchema = z.preprocess(
    emptyToNull,
    z
        .string()
        .trim()
        .max(500)
        .refine((u) => /^https?:\/\//i.test(u), '链接需以 http:// 或 https:// 开头')
        .nullish(),
);

const linkLabelSchema = z.preprocess(emptyToNull, z.string().trim().max(80).nullish());

export const announcementInputSchema = z.object({
    title: z.string().trim().min(1, '标题不能为空').max(200),
    body: z.string().trim().max(5000).default(''),
    level: z.enum(['info', 'warning', 'critical']).default('info'),
    link_url: linkUrlSchema,
    link_label: linkLabelSchema,
    is_active: z.boolean().default(true),
});

export type AnnouncementInput = z.infer<typeof announcementInputSchema>;
