/**
 * OpenAI images API(gpt-image-2)edits 输入参考图的 `usage.input_tokens_details.image_tokens` 官方口径。
 *
 * 2026-09-16 用官方 key 直打 api.openai.com/v1/images/edits,15 个尺寸逐点拟合(全部精确命中):
 *   64²→16、256²→256、400²→625、300×600→512、240×600→416、200×800→352、100×800→352、
 *   900²→1024、1200×600→722、1376×768→1032(客户案例)、
 *   1024²→1024、1536×1024→1536、1280×720→920、2048²→1521、3840×2160→1508(后五个与 2.5 直通 usage 同值)、
 *   6000×4000→1536(超上限缩放取整口径的判据)。
 *
 * 规则(等价于 16px patch + 三段缩放):
 *   1. scale = clamp(512 / 长边, 0.5, 1)  —— 长边 ≤512 不缩;512~1024 缩到长边 512;≥1024 固定 0.5
 *      (≥1024 时等价于原图 32px patch,这就是 #471 首版公式只在大图上对的原因)
 *   2. 缩放后短边不足长边 1/3 时补到 1/3(长宽比钉在 ≤3:1;200×800 与 100×800 同为 352 的来源)
 *   3. 16px 网格 ceil 计 patch;总数 >1536 再按像素等比缩到 1536 patch 面积、两轴 floor(2048²→39²、4K→52×29、6000×4000→48×32)
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
    if (pw * ph > IMAGE_INPUT_MAX_PATCHES) {
        // 超上限:按【像素】等比缩到恰好 1536 patch 的面积,再两轴各 floor —— 不是对 patch 数缩放后 floor。
        // 2026-09-17 官方 key 实测 6000×4000 → 1536(=48×32):对 patch 数缩放会得 48×31=1488(短边
        // 31.96 被 floor 掉),对像素缩放是 768.03×512.02 → 48×32。3840×2160→1508、2048²→1521 两种算法同值。
        const k = Math.sqrt((IMAGE_INPUT_MAX_PATCHES * IMAGE_INPUT_PATCH_PX * IMAGE_INPUT_PATCH_PX) / (sw * sh));
        pw = Math.floor((sw * k) / IMAGE_INPUT_PATCH_PX);
        ph = Math.floor((sh * k) / IMAGE_INPUT_PATCH_PX);
    }
    return Math.max(1, pw * ph);
}
