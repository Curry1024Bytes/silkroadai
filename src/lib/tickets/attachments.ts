/**
 * 工单附件(PR3):客户先 POST 文件到 /api/portal/tickets/attachments 传 R2
 * (`tickets/<user_id>/<uuid>.<ext>`),拿到 key 后随消息提交;服务端按 key 前缀校验归属。
 * 只收图片(截图);每条消息 ≤ 3 张、单张 ≤ 5MB。URL 用 R2 公开域(uuid 不可猜),不做签名。
 */
import { z } from 'zod';

export const MAX_ATTACHMENTS_PER_MESSAGE = 3;
export const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;

const EXT_BY_MIME: Record<string, string> = {
    'image/png': 'png',
    'image/jpeg': 'jpg',
    'image/gif': 'gif',
    'image/webp': 'webp',
};
export const ALLOWED_MIME = Object.keys(EXT_BY_MIME);

/** 按文件头判断真实类型(浏览器给的 type 不可信)。 */
export function sniffImageMime(buf: Uint8Array): string | null {
    if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png';
    if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
    if (buf.length >= 6 && buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x38) return 'image/gif';
    if (
        buf.length >= 12 &&
        buf[0] === 0x52 &&
        buf[1] === 0x49 &&
        buf[2] === 0x46 &&
        buf[3] === 0x46 &&
        buf[8] === 0x57 &&
        buf[9] === 0x45 &&
        buf[10] === 0x42 &&
        buf[11] === 0x50
    )
        return 'image/webp';
    return null;
}

export function extensionFor(mime: string): string {
    return EXT_BY_MIME[mime] ?? 'bin';
}

export function attachmentKey(userId: string, uuid: string, mime: string): string {
    return `tickets/${userId}/${uuid}.${extensionFor(mime)}`;
}

export const AttachmentMetaSchema = z.object({
    key: z.string().regex(/^tickets\/[0-9a-f-]{36}\/[0-9a-f-]{36}\.(png|jpg|gif|webp)$/),
    name: z.string().trim().min(1).max(120),
    size: z.number().int().min(1).max(MAX_ATTACHMENT_BYTES),
    type: z.enum(['image/png', 'image/jpeg', 'image/gif', 'image/webp']),
});
export type AttachmentMeta = z.infer<typeof AttachmentMetaSchema>;
export const AttachmentListSchema = z.array(AttachmentMetaSchema).max(MAX_ATTACHMENTS_PER_MESSAGE).optional();

/** 消息里的附件必须都是当前用户自己上传的(key 前缀 = tickets/<user_id>/)。 */
export function attachmentsOwnedBy(userId: string, list: AttachmentMeta[] | undefined): boolean {
    return (list ?? []).every((a) => a.key.startsWith(`tickets/${userId}/`));
}

/** 从 DB Json 列还原(坏数据 → 空数组,不让线程炸)。 */
export function parseAttachments(json: unknown): AttachmentMeta[] {
    const r = z.array(AttachmentMetaSchema).safeParse(json);
    return r.success ? r.data : [];
}
