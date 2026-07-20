/**
 * 剪贴板复制(裸 IP HTTP 兼容)。
 *
 * 企业门户走裸 IP http://128.241.232.23,非 secure context 下浏览器不提供
 * `navigator.clipboard`(undefined),裸调用会静默失败 —— 客户/运营点「复制」
 * 没任何反应(2026-07-20 operator 实测)。这里优先 Clipboard API,不可用或
 * 被权限拒时降级到隐藏 textarea + `document.execCommand('copy')`(deprecated
 * 但所有浏览器在 HTTP 下仍支持,正是为这种场景保留的路径)。
 */
export async function copyText(text: string): Promise<boolean> {
    if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
        try {
            await navigator.clipboard.writeText(text);
            return true;
        } catch {
            // secure context 里也可能被权限策略拒,落到 execCommand 兜底
        }
    }
    try {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.setAttribute('readonly', '');
        ta.style.position = 'fixed';
        ta.style.top = '0';
        ta.style.left = '0';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        ta.setSelectionRange(0, text.length);
        const ok = document.execCommand('copy');
        document.body.removeChild(ta);
        return ok;
    } catch {
        return false;
    }
}
