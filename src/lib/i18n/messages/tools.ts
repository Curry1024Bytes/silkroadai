/**
 * /tools — 工具箱 index + the three API-key test tools (Seedance video /
 * chat / image). Shared strings (API key box, model picker, load states)
 * live under `shared`; each tool has its own section.
 *
 * `apiError` localises the fixed Chinese error bodies returned by the
 * `/api/tools/*` route handlers (which stay Chinese — they are not UI).
 * zh is the identity; en maps the known messages / prefixes and passes
 * anything unknown (upstream JSON, status codes) through untouched.
 */
import { defineMessages } from '../index';

const SOURCE_LABELS_ZH = { overseas: '海外满血', reverse: '逆向低价', cn: '国内企业级', normal: '普通' } as const;
const SOURCE_LABELS_EN = {
    overseas: 'Overseas (full)',
    reverse: 'Reverse (budget)',
    cn: 'CN enterprise',
    normal: 'Standard',
} as const;

/** Known `/api/tools/*` error bodies → English. Prefix entries end with ': '. */
const EN_API_ERROR_EXACT: Record<string, string> = {
    '缺少 API Key': 'Missing API key',
    模型列表解析失败: 'Failed to parse the model list',
    非法的图片地址: 'Invalid image URL',
    目标不是图片: 'Target is not an image',
    图片过大: 'Image too large',
};
const EN_API_ERROR_PREFIX: Array<[string, string]> = [
    ['上游不可达: ', 'Upstream unreachable: '],
    ['代理不可达: ', 'Proxy unreachable: '],
    ['图片拉取失败: ', 'Image fetch failed: '],
    ['图片不可达 (', 'Image unreachable ('],
];

function localizeApiErrorEn(msg: string): string {
    if (EN_API_ERROR_EXACT[msg]) return EN_API_ERROR_EXACT[msg];
    for (const [zh, en] of EN_API_ERROR_PREFIX) {
        if (msg.startsWith(zh)) return en + msg.slice(zh.length);
    }
    return msg;
}

export const toolsMessages = defineMessages(
    {
        shared: {
            back: '← 返回',
            apiKeyLabel: '你的 API Key',
            apiKeyPlaceholder: 'sk-...',
            show: '显示',
            hide: '隐藏',
            loadModels: '加载模型',
            loading: '加载中…',
            loadFailed: '加载失败',
            keyNote: 'Key 只用于本次调用、不保存。在「API 密钥」页用复制按钮取。',
            model: '模型',
            generating: '生成中…',
            requestFailed: (status: number) => `请求失败 (${status})`,
            rawResponse: '原始响应',
            apiError: (msg: string) => msg,
        },
        index: {
            metaTitle: '工具箱 · Silk Road AI',
            metaDescription:
                'Silk Road AI 工具箱 —— Seedance 视频 / AI 对话 / AI 生图 在线测试工具,以及 OpenAI Codex / Claude Code 接入。',
            title: '工具箱',
            intro: '在线测试工具与接入指引,后续会持续加入更多工具。',
            tagOnline: '在线工具',
            tagDownload: '下载安装',
            useNow: '立即使用',
            downloadConnect: '下载 & 接入',
            seedance: {
                title: 'Seedance 视频测试工具',
                desc: '填入你的 API Key,在线生成 Seedance 视频 —— 全部模型、全部玩法(文生 / 图生 / 首尾帧 / 参考音频),无需写代码。',
            },
            chat: {
                title: 'AI 对话测试工具',
                desc: '填入你的 API Key,在线测试 AI 对话(逐字流式)—— 覆盖你这把 key 能用的全部对话模型(GPT / Claude / Gemini / DeepSeek 等)。',
            },
            image: {
                title: 'AI 生图测试工具',
                desc: '填入你的 API Key,在线测试文生图 / 图生图 —— 覆盖你这把 key 能用的全部生图模型(Gemini / GPT Image 等)。',
            },
            codex: {
                title: 'OpenAI Codex 接入',
                desc: 'Codex CLI / IDE 插件 / 桌面版接入 Silk Road AI,一份配置直连 ChatGPT,人民币计费。',
            },
            claudeCode: {
                title: 'Claude Code 接入',
                desc: 'Claude Code 桌面 / CLI 接入 Silk Road AI,配好 Base URL + Key 即用 Claude,人民币计费。',
            },
        },
        chat: {
            metaTitle: 'AI 对话测试工具 · Silk Road AI',
            metaDescription:
                '填入你的 API Key,在线测试 AI 对话(流式)—— 覆盖你这把 key 能用的全部对话模型(GPT / Claude / Gemini / DeepSeek 等)。',
            title: 'AI 对话测试工具',
            intro: '填入你的 API Key,选模型,直接在线测试对话(逐字流式)。覆盖你这把 key 能用的全部对话模型。Key 仅用于本次调用、不保存。',
            noModels: '这把 key 下没有可用的对话模型',
            noContent: '未收到内容(可能模型不对或参数问题)',
            newChat: '新对话',
            emptyHint: '下方输入消息开始对话。',
            placeholder: '输入消息,Enter 发送 / Shift+Enter 换行',
            send: '发送',
        },
        image: {
            metaTitle: 'AI 生图测试工具 · Silk Road AI',
            metaDescription:
                '填入你的 API Key,在线测试 AI 生图 —— 文生图 / 图生图,覆盖你这把 key 能用的全部生图模型(Gemini / GPT Image 等)。',
            title: 'AI 生图测试工具',
            intro: '填入你的 API Key,选模型,在线测试文生图 / 图生图。覆盖你这把 key 能用的全部生图模型。表单与下方 JSON 双向联动,可手动改 JSON 再生成。Key 仅用于本次调用、不保存。',
            noModels: '这把 key 下没有可用的生图模型',
            nonJson: (status: number) => `返回非 JSON (${status})`,
            noImages: '返回里没有图片(见下方原始响应)',
            modeText: '文生图',
            modeEdit: '图生图',
            prompt: '提示词',
            promptPlaceholder: '描述你想生成 / 修改的图片',
            aspect: '比例',
            resolution: '分辨率',
            count: '数量',
            geminiSingle: 'Gemini 系单次出 1 张',
            refImage: '参考图(图生图)',
            requestJson: '请求 JSON(可手动改)',
            generate: '生成图片',
            download: '下载图片',
            sizeDefault: '默认',
            sizeSquare: '1024×1024 方',
            sizeLandscape: '1536×1024 横',
            sizePortrait: '1024×1536 竖',
        },
        seedance: {
            metaTitle: 'Seedance 视频测试工具 · Silk Road AI',
            metaDescription:
                '填入你的 API Key,在线测试 Seedance 视频生成 —— 支持文生 / 图生 / 首尾帧 / 多图 / 参考音频,覆盖海外满血与逆向低价全部模型。',
            title: 'Seedance 视频测试工具',
            intro: '填入你的 API Key,选模型 + 玩法,直接在线生视频测试。支持文生 / 图生 / 首尾帧 / 多图 / 参考音频, 覆盖你这把 key 能用的所有 Seedance 模型。Key 仅用于本次调用、不保存。',
            keyNote: 'Key 只用于本次调用、不保存。在「API 密钥」页用复制按钮取,避免手敲混淆。',
            defaultPrompt: '一只橘猫在窗台上伸懒腰,慢镜头,暖色调',
            noModels: '这把 key 下没有可用的 Seedance 视频模型(检查档位)',
            modes: {
                text: { label: '文生视频', hint: '纯文字描述生成' },
                image: { label: '图生视频', hint: '上传 1 张参考图' },
                multi: { label: '多图参考', hint: '上传多张图(角色/场景)' },
                frames: { label: '首尾帧', hint: '上传首帧 + 尾帧' },
                audio: { label: '参考音频', hint: '上传 1 张图 + 音频' },
            },
            sources: SOURCE_LABELS_ZH as Record<keyof typeof SOURCE_LABELS_ZH, string>,
            tierLine: (source: string, field: string) => `档位:${source} · 时长字段 ${field}`,
            reverseDurationHint: '(建议 10/15)',
            playMode: '玩法',
            prompt: '提示词',
            multiHint: '多图请在提示词里用 @Image1 / @Image2 指代每张图。',
            duration: '时长(秒)',
            ratio: '画面比例',
            framesLabel: '首帧 + 尾帧(按顺序选 2 张)',
            multiLabel: '参考图(可多张,≤9)',
            singleLabel: '参考图(1 张)',
            clear: '清除',
            audioLabel: '参考音频(上传或填直链)',
            audioUploaded: '(已上传音频文件)',
            audioPlaceholder: 'https://你的音频/song.mp3',
            requestJson: '请求 JSON(自动生成,可手动改 — 高级玩法直接编辑这里)',
            generate: '生成视频',
            result: '生成结果',
            rawDebug: '原始响应(调试)',
            submitting: '提交中…',
            jsonInvalid: '请求 JSON 格式错误',
            needMedia: '这个玩法需要参考素材 —— 请在上方重新选择参考图 / 首尾帧 / 音频后再生成',
            submitFailed: (status: number) => `提交失败 (${status})`,
            noTaskId: (raw: string) => `未拿到 task_id:${raw}`,
            progress: (status: string, seconds: number) => `生成中… ${status}(已等 ${seconds}s)`,
            doneNoUrl: '已完成但未找到 video_url,见下方原始响应',
            failed: '生成失败,见下方原始响应',
            timeout: '超时(>15 分钟未出片),请稍后用 task_id 再查或重试',
        },
    },
    {
        shared: {
            back: '← Back',
            apiKeyLabel: 'Your API key',
            apiKeyPlaceholder: 'sk-...',
            show: 'Show',
            hide: 'Hide',
            loadModels: 'Load models',
            loading: 'Loading…',
            loadFailed: 'Failed to load',
            keyNote: 'The key is used for this call only and never stored. Copy it from the API Keys page.',
            model: 'Model',
            generating: 'Generating…',
            requestFailed: (status: number) => `Request failed (${status})`,
            rawResponse: 'Raw response',
            apiError: localizeApiErrorEn,
        },
        index: {
            metaTitle: 'Tools · Silk Road AI',
            metaDescription:
                'Silk Road AI Tools — online test tools for Seedance video, AI chat and image generation, plus OpenAI Codex / Claude Code setup guides.',
            title: 'Tools',
            intro: 'Online test tools and integration guides — more tools are on the way.',
            tagOnline: 'Online tool',
            tagDownload: 'Download & setup',
            useNow: 'Open tool',
            downloadConnect: 'Download & connect',
            seedance: {
                title: 'Seedance Video Tester',
                desc: 'Paste your API key and generate Seedance videos online — every model and every mode (text / image / first-last frame / reference audio), no code required.',
            },
            chat: {
                title: 'AI Chat Tester',
                desc: 'Paste your API key and test AI chat online (token-by-token streaming) — covers every chat model your key can use (GPT / Claude / Gemini / DeepSeek and more).',
            },
            image: {
                title: 'Image Generation Tester',
                desc: 'Paste your API key and test text-to-image / image-to-image online — covers every image model your key can use (Gemini / GPT Image and more).',
            },
            codex: {
                title: 'Connect OpenAI Codex',
                desc: 'Connect Codex CLI / IDE plugins / desktop app to Silk Road AI — one config file, direct ChatGPT access, billed in CNY.',
            },
            claudeCode: {
                title: 'Connect Claude Code',
                desc: 'Connect Claude Code desktop / CLI to Silk Road AI — set the Base URL + key and start using Claude, billed in CNY.',
            },
        },
        chat: {
            metaTitle: 'AI Chat Tester · Silk Road AI',
            metaDescription:
                'Paste your API key and test AI chat online (streaming) — covers every chat model your key can use (GPT / Claude / Gemini / DeepSeek and more).',
            title: 'AI Chat Tester',
            intro: 'Paste your API key, pick a model and test chat online (token-by-token streaming). Covers every chat model your key can use. The key is used for this call only and never stored.',
            noModels: 'No chat models are available for this key',
            noContent: 'No content received (wrong model or parameters?)',
            newChat: 'New chat',
            emptyHint: 'Type a message below to start.',
            placeholder: 'Type a message — Enter to send, Shift+Enter for a new line',
            send: 'Send',
        },
        image: {
            metaTitle: 'Image Generation Tester · Silk Road AI',
            metaDescription:
                'Paste your API key and test image generation online — text-to-image / image-to-image, covering every image model your key can use (Gemini / GPT Image and more).',
            title: 'Image Generation Tester',
            intro: 'Paste your API key, pick a model and test text-to-image / image-to-image online. Covers every image model your key can use. The form and the JSON below stay in sync — edit the JSON by hand if you like. The key is used for this call only and never stored.',
            noModels: 'No image models are available for this key',
            nonJson: (status: number) => `Non-JSON response (${status})`,
            noImages: 'No images in the response (see raw response below)',
            modeText: 'Text to image',
            modeEdit: 'Image to image',
            prompt: 'Prompt',
            promptPlaceholder: 'Describe the image you want to generate or edit',
            aspect: 'Aspect ratio',
            resolution: 'Resolution',
            count: 'Count',
            geminiSingle: 'Gemini models return 1 image per call',
            refImage: 'Reference image (image to image)',
            requestJson: 'Request JSON (editable)',
            generate: 'Generate image',
            download: 'Download image',
            sizeDefault: 'Default',
            sizeSquare: '1024×1024 square',
            sizeLandscape: '1536×1024 landscape',
            sizePortrait: '1024×1536 portrait',
        },
        seedance: {
            metaTitle: 'Seedance Video Tester · Silk Road AI',
            metaDescription:
                'Paste your API key and test Seedance video generation online — text / image / first-last frame / multi-image / reference audio, across every overseas and budget model.',
            title: 'Seedance Video Tester',
            intro: 'Paste your API key, pick a model and a mode, and generate test videos online. Supports text / image / first-last frame / multi-image / reference audio across every Seedance model your key can use. The key is used for this call only and never stored.',
            keyNote:
                'The key is used for this call only and never stored. Copy it from the API Keys page to avoid typos.',
            defaultPrompt: 'An orange cat stretching on a windowsill, slow motion, warm tones',
            noModels: 'No Seedance video models are available for this key (check your tier)',
            modes: {
                text: { label: 'Text to video', hint: 'Generate from a text description' },
                image: { label: 'Image to video', hint: 'Upload 1 reference image' },
                multi: { label: 'Multi-image', hint: 'Upload several images (characters / scenes)' },
                frames: { label: 'First / last frame', hint: 'Upload a first frame + last frame' },
                audio: { label: 'Reference audio', hint: 'Upload 1 image + audio' },
            },
            sources: SOURCE_LABELS_EN as Record<keyof typeof SOURCE_LABELS_EN, string>,
            tierLine: (source: string, field: string) => `Tier: ${source} · duration field ${field}`,
            reverseDurationHint: ' (10 / 15 recommended)',
            playMode: 'Mode',
            prompt: 'Prompt',
            multiHint: 'For multiple images, refer to each one in the prompt as @Image1 / @Image2.',
            duration: 'Duration (s)',
            ratio: 'Aspect ratio',
            framesLabel: 'First + last frame (pick 2 in order)',
            multiLabel: 'Reference images (up to 9)',
            singleLabel: 'Reference image (1)',
            clear: 'Clear',
            audioLabel: 'Reference audio (upload or paste a direct link)',
            audioUploaded: '(audio file uploaded)',
            audioPlaceholder: 'https://your-host/song.mp3',
            requestJson: 'Request JSON (auto-generated, editable — advanced options go here)',
            generate: 'Generate video',
            result: 'Result',
            rawDebug: 'Raw response (debug)',
            submitting: 'Submitting…',
            jsonInvalid: 'Request JSON is malformed',
            needMedia:
                'This mode needs reference media — re-select the reference image / frames / audio above, then generate again',
            submitFailed: (status: number) => `Submit failed (${status})`,
            noTaskId: (raw: string) => `No task_id returned: ${raw}`,
            progress: (status: string, seconds: number) => `Generating… ${status} (${seconds}s elapsed)`,
            doneNoUrl: 'Task completed but no video_url found — see raw response below',
            failed: 'Generation failed — see raw response below',
            timeout: 'Timed out (no video after 15 minutes). Check again later with the task_id or retry',
        },
    },
);
