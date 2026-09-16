/**
 * OpenAI images API(gpt-image-2)edits 输入参考图的 `usage.input_tokens_details.image_tokens` 官方口径。
 *
 * 2026-09-16 用官方 key 直打 api.openai.com/v1/images/edits,15 个尺寸逐点拟合(全部精确命中):
 *   64²→16、256²→256、400²→625、300×600→512、240×600→416、200×800→352、100×800→352、
 *   900²→1024、1200×600→722、1376×768→1032(客户案例)、
 *   1024²→1024、1536×1024→1536、1280×720→920、2048²→1521、3840×2160→1508(后五个与 2.5 直通 usage 同值)。
 *
 * 规则(等价于 16px patch + 三段缩放):
 *   1. scale = clamp(512 / 长边, 0.5, 1)  —— 长边 ≤512 不缩;512~1024 缩到长边 512;≥1024 固定 0.5
 *      (≥1024 时等价于原图 32px patch,这就是 #471 首版公式只在大图上对的原因)
 *   2. 缩放后短边不足长边 1/3 时补到 1/3(长宽比钉在 ≤3:1;200×800 与 100×800 同为 352 的来源)
 *   3. 16px 网格 ceil 计 patch;总数 >1536 再按 √(1536/n) 等比缩、两轴 floor(2048²→39²、4K→52×29)
 *
 * 读不出尺寸 → 按 1024²(1024)兜底。
 */
export const IMAGE_INPUT_PATCH_PX = 16;
export const IMAGE_INPUT_MAX_PATCHES = 1536;
export const IMAGE_INPUT_TARGET_LONG_SIDE = 512;
export const IMAGE_INPUT_MIN_SCALE = 0.5;
export const IMAGE_INPUT_MAX_ASPECT = 3;

export function officialImageInputTokens(dims: { w: number; h: number } | null): number {
    if (!dims || dims.w <= 0 || dims.h <= 0) return 1024;
    const long = Math.max(dims.w, dims.h);
    const scale = Math.min(1, Math.max(IMAGE_INPUT_MIN_SCALE, IMAGE_INPUT_TARGET_LONG_SIDE / long));
    let sw = dims.w * scale;
    let sh = dims.h * scale;
    // 长宽比封顶 3:1:短边补到长边的 1/3
    if (sw >= sh) sh = Math.max(sh, sw / IMAGE_INPUT_MAX_ASPECT);
    else sw = Math.max(sw, sh / IMAGE_INPUT_MAX_ASPECT);
    let pw = Math.ceil(sw / IMAGE_INPUT_PATCH_PX);
    let ph = Math.ceil(sh / IMAGE_INPUT_PATCH_PX);
    const n = pw * ph;
    if (n > IMAGE_INPUT_MAX_PATCHES) {
        const s = Math.sqrt(IMAGE_INPUT_MAX_PATCHES / n);
        pw = Math.floor(pw * s);
        ph = Math.floor(ph * s);
    }
    return Math.max(1, pw * ph);
}
