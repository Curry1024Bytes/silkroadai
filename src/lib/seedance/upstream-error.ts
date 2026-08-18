/**
 * 上游报错体 → 对客文案(分类 + 脱敏 + 保留可操作细节)。
 *
 * 两条硬约束,顺序不能反:
 *  ① **绝不泄露上游身份**(#271):中间商域名/IP/厂商名(xinhankr / artsmcp / artsdance /
 *     dreamina / 筷子 …)、上游 request id 一律剥掉。原始体只进 console.warn。
 *  ② 在①的前提下**尽可能精确**:客户要能照着报错自己改请求。
 *
 * 为什么重写(2026-08-17,popreels 事故):旧版只做关键词分类,匹配不上就一律返回
 * 「upstream rejected the request」。结果:
 *  - 客户拿到一句无信息量的话,只能来回找我们捞日志;
 *  - 上游真实原因(提示词被安全审核拒)要事后找上游查 request id 才拿得到;
 *  - 而那次上游回给我们的响应体本就简略 —— 兜底文案连「上游没给原因」都没说清楚。
 * 现在:命中已知类 → 带**主体**(提示词/参考图/参考视频/参考音频)的可操作文案;
 * 未命中 → 也把**脱敏后的上游原文**带出来,而不是吞掉。
 *
 * ⚠️ 我们自己的素材 id(`asset-…` / `group-…`)**刻意保留** —— 那是客户自己的 id,
 * 能直接定位是哪张图出问题,不构成泄露。
 */

/** 中间商/上游厂商标识:出现在对客文案里就是泄露,一律剥。 */
const VENDOR_TOKENS = [
    'xinhankr',
    'artsmcp',
    'artsdance',
    'dreamina',
    'aiopenapi',
    'kuaizi',
    'service-inference',
    'byteplus',
    'volcengine',
    'volces',
    'nginx',
    'cloudflare',
];

/** 对客错误分类(机器可读,用于日志/统计;不直接展示)。 */
export type UpstreamErrorCategory =
    | 'content_safety'
    | 'task_type_constraint'
    | 'copyright'
    | 'media_fetch'
    | 'resolution'
    | 'duration'
    | 'invalid_parameter'
    | 'task_gone'
    | 'rate_limited'
    | 'upstream_account'
    | 'upstream_unavailable'
    | 'unknown';

export interface UpstreamErrorInfo {
    /** 对客文案(已脱敏)。 */
    message: string;
    category: UpstreamErrorCategory;
}

/** 抽上游错误码(TaskTypeConstraint 这类只出现在 code 字段,不在 message 里)。 */
function extractUpstreamCode(body: string): string {
    try {
        const j = JSON.parse((body || '').trim()) as Record<string, unknown>;
        const err = j.error as Record<string, unknown> | undefined;
        const c = (typeof err === 'object' && err ? err.code : undefined) ?? j.code;
        return typeof c === 'string' ? c : '';
    } catch {
        return '';
    }
}

/** 从上游响应体里抽出「人话」部分。上游各家信封不一,按常见形态依次试。 */
function extractUpstreamMessage(body: string): string {
    const raw = (body || '').trim();
    if (!raw) return '';
    try {
        const j = JSON.parse(raw) as Record<string, unknown> | string;
        if (typeof j === 'string') return j.trim();
        const err = (j as Record<string, unknown>).error as Record<string, unknown> | string | undefined;
        const candidates = [
            typeof err === 'object' && err ? err.message : undefined,
            typeof err === 'object' && err ? err.msg : undefined,
            typeof err === 'string' ? err : undefined,
            (j as Record<string, unknown>).message,
            (j as Record<string, unknown>).msg,
            (j as Record<string, unknown>).detail,
        ];
        for (const c of candidates) {
            if (typeof c === 'string' && c.trim()) return c.trim();
        }
        // 是合法 JSON 但没有任何「人话」字段(如 `{}` / `{"code":500}`)——
        // 视为【上游没给原因】,绝不把 JSON 字面量当原因抛给客户。
        return '';
    } catch {
        // 非 JSON(HTML 错误页等)→ 用原文,后面统一脱敏 + 截断
        return raw;
    }
}

/** 剥掉一切能指向上游身份的东西,并压成一行。 */
export function sanitizeUpstreamText(text: string): string {
    let s = text || '';
    // 上游 request id(各种写法)—— 连值一起剥
    s = s.replace(/\b(request[\s_-]?id|req[\s_-]?id|trace[\s_-]?id)\b\s*[:=]?\s*["']?[\w-]+["']?/gi, '');
    // URL / 裸域名 / IP:端口
    s = s.replace(/https?:\/\/\S+/gi, '');
    s = s.replace(/\b(?:\d{1,3}\.){3}\d{1,3}(?::\d+)?\b/g, '');
    s = s.replace(/\b[a-z0-9-]+(?:\.[a-z0-9-]+)+\.(?:com|cn|io|net|org|ai|co)\b/gi, '');
    // 厂商标识(含出现在模型名里的,如 artsdance-2-0-pro-260801 整串剥掉);
    // 尾随的版本号一并吃掉,否则 `nginx/1.25` 会残留成 `/1.25` 这种噪音。
    for (const v of VENDOR_TOKENS) {
        s = s.replace(new RegExp(`[\\w.-]*${v}[\\w.-]*(?:\\s*/\\s*[\\d.]+)?`, 'gi'), '');
    }
    // 长 id 残留(纯十六进制 ≥20 位 / 超长字母数字串);我们自己的 asset-…/group-… 因带
    // 短横线分段且每段都短,不会被这两条命中 —— 刻意保留,客户据此定位是哪张素材。
    s = s.replace(/\b[0-9a-f]{20,}\b/gi, '');
    s = s.replace(/\b[0-9A-Za-z]{28,}\b/g, '');
    // 收尾:压空白、去掉被剥空后剩下的孤立标点
    s = s
        .replace(/\s+/g, ' ')
        .replace(/\s*[:：,，.。;；]\s*(?=[:：,，.。;；])/g, '')
        .replace(/[[(【（]\s*[\])】）]/g, '')
        .replace(/^\s*[-:：,，.。;；\s]+|[-:：,，.。;；\s]+$/g, '')
        .trim();
    return s.length > 300 ? s.slice(0, 300) + '…' : s;
}

/** 报错指向哪类输入?(用于给出可操作文案) */
function detectSubject(lower: string): 'text' | 'image' | 'video' | 'audio' | 'output' | null {
    if (/output\s*(video|image)|输出|生成结果|生成的视频/.test(lower)) return 'output';
    if (/input\s*text|content\[|\bprompt\b|提示词|文本/.test(lower)) return 'text';
    if (/input\s*image|\bimage\b|图片|参考图|asset-/.test(lower)) return 'image';
    if (/input\s*video|\bvideo\b|视频/.test(lower)) return 'video';
    if (/input\s*audio|\baudio\b|音频/.test(lower)) return 'audio';
    return null;
}

const SUBJECT_CN: Record<string, string> = {
    text: '提示词',
    image: '参考图',
    video: '参考视频',
    audio: '参考音频',
    output: '生成结果',
};

/** 细节后缀:有脱敏后原文就带上(客户据此自查),没有就空。 */
function detail(s: string): string {
    return s ? `(上游原因:${s})` : '';
}

/**
 * 上游报错体 + HTTP 状态 → 对客分类与文案。
 * body 为空(上游没给原因)时也**明确说出来**,不再伪装成「请求被拒」。
 */
export function classifyUpstreamError(body: string, status?: number): UpstreamErrorInfo {
    const extracted = extractUpstreamMessage(body);
    const clean = sanitizeUpstreamText(extracted);
    // 分类信号 = 错误码 + 人话(码里才有 TaskTypeConstraint 这类结构化信息)
    const lower = `${extractUpstreamCode(body)} ${extracted || ''}`.toLowerCase();

    // ── 内容安全 / 版权:最需要精确到「哪一类输入」,客户才知道改什么 ──
    // ⚠️ 必须先于「素材」判 —— 上游把审核结果包在「素材转换失败: …sensitive…」里,
    //    先判素材会把审核问题误报成下载失败(2026-08-17 实测报文)。
    const subject = detectSubject(lower);
    const subjectCn = subject ? SUBJECT_CN[subject] : '';
    if (/copyright|版权|portrait|肖像/.test(lower)) {
        const who = subjectCn || '输入内容';
        return {
            category: 'copyright',
            message:
                subject === 'output'
                    ? `生成结果因版权/肖像限制被上游拦截 —— 请调整提示词或更换参考素材后重试${detail(clean)}`
                    : `${who}疑似涉及版权/肖像限制,被上游审核拒绝 —— 请更换${who}或调整提示词后重试${detail(clean)}`,
        };
    }
    if (/sensitive|敏感|安全审核|risk\s*control|violat|不合规|违规/.test(lower)) {
        const who = subjectCn || '输入内容';
        return {
            category: 'content_safety',
            message:
                subject === 'output'
                    ? `生成结果未通过内容安全审核 —— 请调整提示词或更换参考素材后重试${detail(clean)}`
                    : `${who}未通过内容安全审核 —— 请修改${who}后重试${detail(clean)}`,
        };
    }

    // 全模态任务类型约束(seedance 2.5):模型按【提示词意图】把任务判成「视频编辑/延长」,
    // 这两类要求 ratio=adaptive(编辑还要 duration=-1)。上游【异步】判定 → 提交时收不到,
    // 轮询才报,且再轮询多少次都是同一个错。2026-08-18 有一条这样的任务被客户轮询了 8925 次。
    if (/tasktypeconstraint|identified your task as/.test(lower)) {
        return {
            category: 'task_type_constraint',
            message: `模型按提示词判定本次为「视频编辑 / 视频延长」任务 —— 该类型要求 ratio 必须为 adaptive(视频编辑还需 duration=-1)。请调整参数后重新提交${detail(clean)}`,
        };
    }
    // ── 任务态 ──
    if (/任务不存在|task .*not exist|not found|does not exist/.test(lower)) {
        return { category: 'task_gone', message: '任务已失效或不存在,请重新提交' };
    }

    // ── 素材拉取(客户链接不可达/跨境超时)──
    if (/failed to download media|下载失败|素材|media.*(unreachable|timeout)|gateway time-?out/.test(lower)) {
        return {
            category: 'media_fetch',
            message: `输入素材下载失败(链接不可达或超时)—— 请确认图片/视频链接公网可访问;海外档拉国内链接易超时,可改用国内版${detail(clean)}`,
        };
    }

    // ── 参数类:上游文案本身就是可操作的,原样(脱敏后)带出 ──
    if (/分辨率|resolution/.test(lower)) {
        return {
            category: 'resolution',
            message: `所选分辨率不被当前模型档位接受 —— 请改用该档位支持的分辨率${detail(clean)}`,
        };
    }
    if (/duration|时长/.test(lower)) {
        return {
            category: 'duration',
            message: `时长参数不被当前模型/参考模式接受(带参考图与纯文生的可选时长可能不同)—— 请调整 duration 后重试${detail(clean)}`,
        };
    }
    if (/invalid\s*parameter|invalidparameter|参数|invalid|bad\s*request/.test(lower)) {
        return { category: 'invalid_parameter', message: `请求参数被上游拒绝${detail(clean) || ',请检查请求参数'}` };
    }

    // ── 限流 / 上游账户 / 上游故障 ──
    if (/rate.?limit|too many requests|限流|qps|超出配额|quota exceeded/.test(lower) || status === 429) {
        return { category: 'rate_limited', message: '请求过于频繁,请稍后重试' };
    }
    // 上游账户余额/欠费是【我们】的问题,不能让客户误以为是自己余额 —— 也不带上游原文。
    if (/余额|欠费|insufficient|balance|arrears/.test(lower)) {
        return { category: 'upstream_account', message: '服务方上游账户异常,已通知处理 —— 请稍后重试或联系服务方' };
    }
    if (status && status >= 500) {
        return { category: 'upstream_unavailable', message: `上游暂时不可用,请稍后重试${detail(clean)}` };
    }

    // ── 兜底:也要说人话 ──
    // 上游没给任何原因时明说,别让客户以为是自己请求的问题(popreels 事故就卡在这)。
    if (!clean) {
        return {
            category: 'unknown',
            message: `上游拒绝了本次请求但未返回具体原因${status ? `(HTTP ${status})` : ''} —— 请稍后重试;若持续失败请联系服务方并提供请求时间`,
        };
    }
    return { category: 'unknown', message: `上游拒绝了本次请求 —— ${clean}` };
}

/**
 * 这些 category = **任务本身已废**,再轮询多少次都是同一个结果 → 必须终态化,
 * 否则客户脚本会无限重试(2026-08-18:8925 次/22 小时,还顺带把上游打到 429)。
 * 共同点:它们描述的是【这次请求本身不合法】,不会因为等待而变好。
 */
const TERMINAL_CATEGORIES: ReadonlySet<UpstreamErrorCategory> = new Set([
    'content_safety',
    'copyright',
    'task_type_constraint',
    'invalid_parameter',
    'resolution',
    'duration',
    'media_fetch',
]);

/**
 * 本次上游轮询失败,是「任务已废」(终态)还是「瞬时抖动」(可重试)?
 *
 * 只有 **4xx 且非 429** + 终态类 category 才算已废:
 *  - 5xx / 429 / 上游账户异常 → 瞬时,任务多半还活着,**绝不能**误杀;
 *  - `task_gone`(任务不存在)**刻意排除** —— 它描述的是上游状态而非请求本身,
 *    一次查询抖动就终态化风险太大;这类交给对账器的 48h 过期兜底。
 */
export function isTerminalTaskFailure(category: UpstreamErrorCategory, status?: number): boolean {
    if (!status || status < 400 || status >= 500 || status === 429) return false;
    return TERMINAL_CATEGORIES.has(category);
}

/** 兼容旧签名(只要文案)。新代码建议用 classifyUpstreamError 拿 category 一起落日志。 */
export function friendlyUpstreamError(body: string, status?: number): string {
    return classifyUpstreamError(body, status).message;
}
