/**
 * 企业门户客户接入文档页(2026-07-20)。全量内容(参数表/示例/素材库契约/错误码/FAQ),
 * 不做删减版 —— 客户技术对接人看这一页即可完成接入。静态 JSX(镜像主站 /docs 模式)。
 */
import { officialCostCny } from '@/lib/seedance/cn-billing';
import type { SeedanceVariant } from '@/lib/seedance/cn-adapter';

export const dynamic = 'force-dynamic';

export const metadata = { title: 'Seedance 企业端口 · 接入文档' };

/** 官方挂牌价(¥/1M token)—— 从费率表推导(零售 ÷ 0.85),避免文档硬编码漂移。
 *  实付 = 挂牌 × 客户折扣率(默认 8.5 折),明细见「计费流水」页三列口径。 */
function listPrices(variant: SeedanceVariant, resolutions: string[], hasVideo: boolean): string {
    return resolutions
        .map((r) => {
            const v = officialCostCny(1_000_000, r as never, hasVideo, variant);
            return Number.isInteger(v) ? String(v) : String(+v.toFixed(3));
        })
        .join(' / ');
}

const BASE = process.env.ENTERPRISE_BASE_URL || 'http://128.241.232.23';
// 兼容入口:上域名前的裸 IP,现有客户继续可用(保留,不强制迁移)。
const LEGACY_BASE = 'http://128.241.232.23';

function Code({ children }: { children: string }) {
    return <code className="rounded bg-gray-100 px-1 py-0.5 font-mono text-[13px]">{children}</code>;
}

function Pre({ children }: { children: string }) {
    return (
        <pre className="overflow-x-auto rounded-lg bg-gray-900 p-4 text-[13px] leading-relaxed text-gray-100">
            {children}
        </pre>
    );
}

function Section({ id, title, children }: { id: string; title: string; children: React.ReactNode }) {
    return (
        <section id={id} className="scroll-mt-4 rounded-xl border border-gray-200 bg-white p-6">
            <h2 className="mb-4 text-base font-semibold text-gray-900">{title}</h2>
            <div className="space-y-3 text-sm leading-relaxed text-gray-700">{children}</div>
        </section>
    );
}

function Th({ children }: { children: React.ReactNode }) {
    return (
        <th className="border-b border-gray-200 py-1.5 pr-4 text-left text-xs font-medium text-gray-500">{children}</th>
    );
}

function Td({ children }: { children: React.ReactNode }) {
    return <td className="border-b border-gray-100 py-2 pr-4 align-top">{children}</td>;
}

export default function EnterpriseDocsPage() {
    return (
        <div className="space-y-5">
            {/* 目录 */}
            <nav className="rounded-xl border border-gray-200 bg-white p-4 text-sm">
                <span className="mr-2 font-medium text-gray-900">目录:</span>
                {[
                    ['quickstart', '快速开始'],
                    ['models', '模型与计费'],
                    ['generate', '视频生成 API'],
                    ['refs', '参考输入'],
                    ['volc', '火山渠道'],
                    ['realperson', '真人认证'],
                    ['errors', '错误码'],
                    ['faq', 'FAQ'],
                ].map(([id, label]) => (
                    <a key={id} href={`#${id}`} className="mr-3 text-blue-600 hover:underline">
                        {label}
                    </a>
                ))}
                <a href="/enterprise/docs/assets" className="mr-3 font-medium text-blue-600 hover:underline">
                    素材库文档 →
                </a>
            </nav>

            <Section id="quickstart" title="1. 快速开始">
                <table className="w-full text-sm">
                    <tbody>
                        <tr>
                            <Td>Base URL</Td>
                            <Td>
                                <div>
                                    主域名(推荐,受信 HTTPS):<Code>{`${BASE}/v1`}</Code>
                                </div>
                                <div className="mt-1">
                                    兼容(裸 IP,旧客户保留):<Code>{`${LEGACY_BASE}/v1`}</Code>
                                </div>
                            </Td>
                        </tr>
                        <tr>
                            <Td>鉴权</Td>
                            <Td>
                                所有请求带 <Code>Authorization: Bearer sk-ent-…</Code>(密钥在「API 密钥」页创建)
                            </Td>
                        </tr>
                        <tr>
                            <Td>协议</Td>
                            <Td>
                                主域名为<b>受信 HTTPS</b>,直接调用无需额外配置(推荐)。裸 IP 入口的
                                HTTPS(:443)是自签证书, 需关闭证书校验(curl <Code>-k</Code> / Python{' '}
                                <Code>verify=False</Code>)或改用 HTTP。
                            </Td>
                        </tr>
                    </tbody>
                </table>
                <p className="font-medium text-gray-900">第一条视频(提交 → 轮询 → 下载):</p>
                <Pre>{`# 1) 提交
curl -X POST ${BASE}/v1/video/generations \\
  -H "Authorization: Bearer sk-ent-您的密钥" \\
  -H "Content-Type: application/json" \\
  -d '{"model":"seedance-2-0","prompt":"一只橘猫在窗台上打盹,阳光明媚","duration":5}'
# → {"task_id":"cgt-…","status":"queued"}

# 2) 轮询(建议 10-20 秒一次,直到 status=completed)
curl ${BASE}/v1/video/generations/cgt-… \\
  -H "Authorization: Bearer sk-ent-您的密钥"
# → {"status":"completed","video_url":"https://…volcvideo.com/…","usage":{"completion_tokens":108872}}

# 3) video_url 即成片直链 —— 约 24 小时过期,请及时下载转存`}</Pre>
                <p className="font-medium text-gray-900">Python 版:</p>
                <Pre>{`import requests, time

BASE = "${BASE}/v1"
H = {"Authorization": "Bearer sk-ent-您的密钥"}

r = requests.post(f"{BASE}/video/generations", headers=H, json={
    "model": "seedance-2-0", "prompt": "一只橘猫在窗台上打盹", "duration": 5,
})
task_id = r.json()["task_id"]

while True:
    j = requests.get(f"{BASE}/video/generations/{task_id}", headers=H).json()
    if j["status"] in ("completed", "failed"):
        break
    time.sleep(15)

print(j.get("video_url"), j.get("usage"))`}</Pre>
            </Section>

            <Section id="models" title="2. 模型与计费">
                <p>
                    国内版模型,分辨率用 <Code>resolution</Code> 参数选,带参考图/视频自动识别 —— 无需切换模型名。
                    <b>下表为官方挂牌价</b>;若您的账户有协议折扣,实际结算 = 官方价 × 折扣率, 「计费流水」页每笔均标注
                    <b>官方价 / 折扣 / 实付</b>三列。
                </p>
                <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                        <thead>
                            <tr>
                                <Th>模型</Th>
                                <Th>说明</Th>
                                <Th>分辨率</Th>
                                <Th>无视频输入(官方价 ¥/1M token)</Th>
                                <Th>含视频输入(官方价 ¥/1M token)</Th>
                            </tr>
                        </thead>
                        <tbody>
                            <tr>
                                <Td>
                                    <Code>seedance-2-0</Code>
                                </Td>
                                <Td>旗舰(Pro)</Td>
                                <Td>480p / 720p / 1080p / 4k</Td>
                                <Td>{listPrices('pro', ['480p', '720p', '1080p', '4k'], false)}</Td>
                                <Td>{listPrices('pro', ['480p', '720p', '1080p', '4k'], true)}</Td>
                            </tr>
                            <tr>
                                <Td>
                                    <Code>seedance-2-0-fast</Code>
                                </Td>
                                <Td>快速档</Td>
                                <Td>480p / 720p / 1080p</Td>
                                <Td>{listPrices('fast', ['480p', '720p', '1080p'], false)}</Td>
                                <Td>{listPrices('fast', ['480p', '720p', '1080p'], true)}</Td>
                            </tr>
                            <tr>
                                <Td>
                                    <Code>seedance-2-0-mini</Code>
                                </Td>
                                <Td>轻量档</Td>
                                <Td>480p / 720p / 1080p</Td>
                                <Td>{listPrices('mini', ['480p', '720p', '1080p'], false)}</Td>
                                <Td>{listPrices('mini', ['480p', '720p', '1080p'], true)}</Td>
                            </tr>
                            <tr>
                                <Td>
                                    <Code>seedance-2-5</Code>
                                </Td>
                                <Td>新代模型(国内版)</Td>
                                <Td>720p / 1080p</Td>
                                <Td>{listPrices('2.5', ['720p', '1080p'], false)}</Td>
                                <Td>{listPrices('2.5', ['720p', '1080p'], true)}</Td>
                            </tr>
                        </tbody>
                    </table>
                </div>
                <ul className="list-disc space-y-1 pl-5">
                    <li>
                        <b>计费 = 实际 token 用量 ÷ 1,000,000 × 费率</b>,token 数以生成完成后返回的{' '}
                        <Code>usage.completion_tokens</Code> 为准(火山公式:(输入视频时长+输出时长) × 宽 × 高 × 帧率 ÷
                        1024,与分辨率、时长线性相关)。
                    </li>
                    <li>
                        参考:720p 5 秒 ≈ 108,872 token → 按官方价 seedance-2-0 约 ¥5.01、fast 约 ¥4.03、mini 约
                        ¥2.50(折后按您的折扣率,如 8.5 折则分别约 ¥4.26 / ¥3.42 / ¥2.13);1080p ≈ 720p 的 2.25 倍 token。
                    </li>
                    <li>
                        <b>480p 与 720p 同费率</b>(单价一样,但 token 量 ∝ 像素,480p 整条约为 720p 的一半价)。仅
                        国内版(seedance-2-0 系)/ 火山渠道支持 480p;海外版(global)与 proMax 上游无 480p。
                    </li>
                    <li>「含视频输入」(参考视频)费率更低,但输入视频的时长也计入 token。图片参考不额外计 token。</li>
                    <li>生成失败不计费。提交时按预估价校验余额,不足返回 402(不会透支)。</li>
                    <li>消费明细实时可见:「计费流水」「调用日志」页,每笔带 token 数与金额。</li>
                </ul>
                <div className="mt-4 rounded-lg border border-indigo-200 bg-indigo-50 p-4 text-sm">
                    <p className="font-semibold text-indigo-900">海外版(global)</p>
                    <p className="mt-1 text-indigo-900">
                        另有海外节点出片的同款模型:<Code>seedance-2-0-global</Code> /{' '}
                        <Code>seedance-2-0-global-fast</Code> / <Code>seedance-2-0-global-mini</Code>
                        。参数、分辨率档位、时长与费率<b>均与国内版一致(唯一例外:无 480p 档)</b>
                        ,仅生成与出片走海外 节点(BytePlus),成片链接为海外 CDN(同样 ~24 小时有效)。调用需使用
                        <b>海外版专用 API 密钥</b>(「API 密钥」页创建时选「海外版」),国内/海外密钥不互通;
                        余额与国内版共享同一账户。
                        <b>如果生成因敏感内容被审核拒绝(fail_reason 提示 sensitive),并非开白/权限原因,请尝试海外版。</b>
                    </p>
                </div>
                <div className="mt-3 rounded-lg border border-purple-200 bg-purple-50 p-4 text-sm">
                    <p className="font-semibold text-purple-900">海外版proMax(独立定价)</p>
                    <p className="mt-1 text-purple-900">
                        更高规格的海外出片系列:<Code>seedance-2-0-promax</Code> / <Code>seedance-2-0-promax-fast</Code>{' '}
                        / <Code>seedance-2-0-promax-mini</Code> / <Code>seedance-2-5-promax</Code>(新代)
                        。调用方式同上(resolution 参数、参考输入自动识别),需<b>海外版proMax 专用密钥</b>; proMax
                        fast/mini 仅 720p 档,promax(pro)支持 720p/1080p/4k、seedance-2-5-promax 支持 720p/1080p(均无
                        480p)。费率(¥/1M token):
                    </p>
                    <div className="mt-2 overflow-x-auto">
                        <table className="w-full text-sm">
                            <thead>
                                <tr>
                                    <Th>模型</Th>
                                    <Th>分辨率</Th>
                                    <Th>无视频输入(官方价)</Th>
                                    <Th>含视频输入(官方价)</Th>
                                </tr>
                            </thead>
                            <tbody>
                                <tr>
                                    <Td>
                                        <Code>seedance-2-0-promax</Code>
                                    </Td>
                                    <Td>720p / 1080p / 4k</Td>
                                    <Td>{listPrices('promax', ['720p', '1080p', '4k'], false)}</Td>
                                    <Td>{listPrices('promax', ['720p', '1080p', '4k'], true)}</Td>
                                </tr>
                                <tr>
                                    <Td>
                                        <Code>seedance-2-0-promax-fast</Code>
                                    </Td>
                                    <Td>720p</Td>
                                    <Td>{listPrices('promax-fast', ['720p'], false)}</Td>
                                    <Td>{listPrices('promax-fast', ['720p'], true)}</Td>
                                </tr>
                                <tr>
                                    <Td>
                                        <Code>seedance-2-0-promax-mini</Code>
                                    </Td>
                                    <Td>720p</Td>
                                    <Td>{listPrices('promax-mini', ['720p'], false)}</Td>
                                    <Td>{listPrices('promax-mini', ['720p'], true)}</Td>
                                </tr>
                                <tr>
                                    <Td>
                                        <Code>seedance-2-5-promax</Code>
                                    </Td>
                                    <Td>720p / 1080p</Td>
                                    <Td>{listPrices('promax-2.5', ['720p', '1080p'], false)}</Td>
                                    <Td>{listPrices('promax-2.5', ['720p', '1080p'], true)}</Td>
                                </tr>
                            </tbody>
                        </table>
                    </div>
                </div>
            </Section>

            <Section id="generate" title="3. 视频生成 API">
                <p className="font-medium text-gray-900">
                    提交:<Code>POST /v1/video/generations</Code>
                </p>
                <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                        <thead>
                            <tr>
                                <Th>参数</Th>
                                <Th>类型</Th>
                                <Th>必填</Th>
                                <Th>说明</Th>
                            </tr>
                        </thead>
                        <tbody>
                            <tr>
                                <Td>
                                    <Code>model</Code>
                                </Td>
                                <Td>string</Td>
                                <Td>是</Td>
                                <Td>
                                    seedance-2-0 / seedance-2-0-fast / seedance-2-0-mini / seedance-2-5(大小写不敏感)
                                </Td>
                            </tr>
                            <tr>
                                <Td>
                                    <Code>prompt</Code>
                                </Td>
                                <Td>string</Td>
                                <Td>是</Td>
                                <Td>文本描述</Td>
                            </tr>
                            <tr>
                                <Td>
                                    <Code>resolution</Code>
                                </Td>
                                <Td>string</Td>
                                <Td>否</Td>
                                <Td>
                                    480p / 720p(默认)/ 1080p / 4k(4k 仅 seedance-2-0;seedance-2-5 仅 720p / 1080p;480p
                                    与 720p 同费率)
                                </Td>
                            </tr>
                            <tr>
                                <Td>
                                    <Code>duration</Code>
                                </Td>
                                <Td>int</Td>
                                <Td>否</Td>
                                <Td>4-15 任意整数秒,默认 5</Td>
                            </tr>
                            <tr>
                                <Td>
                                    <Code>ratio</Code>
                                </Td>
                                <Td>string</Td>
                                <Td>否</Td>
                                <Td>16:9(默认)/ 9:16 / 4:3 / 3:4 / 1:1 / 21:9</Td>
                            </tr>
                            <tr>
                                <Td>
                                    <Code>generate_audio</Code>
                                </Td>
                                <Td>bool</Td>
                                <Td>否</Td>
                                <Td>默认 true(出声;音频不额外计费),false 关闭</Td>
                            </tr>
                            <tr>
                                <Td>
                                    <Code>camera_fixed</Code>
                                </Td>
                                <Td>bool</Td>
                                <Td>否</Td>
                                <Td>固定机位</Td>
                            </tr>
                            <tr>
                                <Td>
                                    <Code>seed</Code>
                                </Td>
                                <Td>int</Td>
                                <Td>否</Td>
                                <Td>随机种子(复现用)</Td>
                            </tr>
                            <tr>
                                <Td>
                                    <Code>images / first_frame / last_frame / reference_videos / audios</Code>
                                </Td>
                                <Td>见下节</Td>
                                <Td>否</Td>
                                <Td>参考输入(第 4 节)</Td>
                            </tr>
                        </tbody>
                    </table>
                </div>
                <p>
                    响应:<Code>{`{"task_id":"cgt-…","status":"queued","model":"…"}`}</Code>
                </p>
                <p className="font-medium text-gray-900">
                    轮询:<Code>{'GET /v1/video/generations/{task_id}'}</Code>
                </p>
                <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                        <thead>
                            <tr>
                                <Th>响应字段</Th>
                                <Th>说明</Th>
                            </tr>
                        </thead>
                        <tbody>
                            <tr>
                                <Td>
                                    <Code>status</Code>
                                </Td>
                                <Td>queued / in_progress / completed / failed(排队与生成中可能交替出现,属正常)</Td>
                            </tr>
                            <tr>
                                <Td>
                                    <Code>video_url</Code>
                                </Td>
                                <Td>
                                    完成后的成片直链(火山 volcvideo.com)。<b>约 24 小时过期,请及时下载转存</b>
                                </Td>
                            </tr>
                            <tr>
                                <Td>
                                    <Code>usage.completion_tokens</Code>
                                </Td>
                                <Td>实际 token 用量(计费依据)</Td>
                            </tr>
                            <tr>
                                <Td>
                                    <Code>fail_reason</Code>
                                </Td>
                                <Td>失败原因(失败不计费)</Td>
                            </tr>
                        </tbody>
                    </table>
                </div>
            </Section>

            <Section id="refs" title="4. 参考输入(图生 / 首尾帧 / 多图 / 视频 / 音频)">
                <p>
                    带任意参考输入即自动进入参考模式,无需改模型名。图片/视频/音频均支持公网 URL、base64 data URL、或素材
                    ID(见素材库文档)。
                </p>
                <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                        <thead>
                            <tr>
                                <Th>字段</Th>
                                <Th>类型</Th>
                                <Th>说明</Th>
                            </tr>
                        </thead>
                        <tbody>
                            <tr>
                                <Td>
                                    <Code>images</Code>
                                </Td>
                                <Td>string[](≤9;seedance-2-5 ≤30)</Td>
                                <Td>参考图(多图参考/主体一致性);素材组 ID 会按序展开为组内全部图</Td>
                            </tr>
                            <tr>
                                <Td>
                                    <Code>first_frame</Code> / <Code>last_frame</Code>
                                </Td>
                                <Td>string</Td>
                                <Td>首帧 / 尾帧(单图生视频用 first_frame)</Td>
                            </tr>
                            <tr>
                                <Td>
                                    <Code>reference_videos</Code>
                                </Td>
                                <Td>string[](≤3;seedance-2-5 ≤10)</Td>
                                <Td>参考视频(风格/运动参考;输入视频时长计入 token,费率走「含视频输入」档,更低)</Td>
                            </tr>
                            <tr>
                                <Td>
                                    <Code>audios</Code>
                                </Td>
                                <Td>string[](seedance-2-5 ≤10)</Td>
                                <Td>参考音频(需至少配一张参考图)</Td>
                            </tr>
                        </tbody>
                    </table>
                </div>
                <Pre>{`# 图生视频(首帧)
{"model":"seedance-2-0","resolution":"1080p","prompt":"镜头缓慢推近,画面动起来",
 "first_frame":"https://…/photo.jpg","duration":5}

# 首尾帧
{"model":"seedance-2-0","prompt":"平滑过渡",
 "first_frame":"https://…/a.jpg","last_frame":"https://…/b.jpg"}

# 多图参考(主体一致性,引用素材组)
{"model":"seedance-2-0-fast","prompt":"主角走进咖啡馆","images":["group-20260719153506-b945c6"]}`}</Pre>
                <p>参考图建议短边 ≥512px、jpg/png 格式;尺寸过小或格式异常会被上游拒绝并提示。</p>
            </Section>

            <Section id="volc" title="5. 火山渠道(volc · 火山方舟原生 + AK/SK 签名)">
                <p>
                    <b>火山渠道</b>是独立渠道(与国内/海外/proMax 平级),提供<b>真人视觉认证</b>与{' '}
                    <b>seedance 2.0 / 2.5 两档</b>视频,采用<b>火山方舟原生接口形态</b> +{' '}
                    <b>火山官方 AK/SK 签名(SignerV4)</b>
                    鉴权 —— 现有火山官方 SDK / 脚本可零改动接入。需在「API 密钥」页开通并生成 AK/SK,专用密钥,与 sk-ent
                    并存互不影响。
                </p>
                <p className="font-medium text-gray-900">可用模型与参数上限:</p>
                <div className="overflow-x-auto">
                    <table className="min-w-full text-sm">
                        <thead>
                            <tr className="border-b border-gray-200 text-left text-gray-500">
                                <th className="py-1.5 pr-4 font-medium">model</th>
                                <th className="py-1.5 pr-4 font-medium">resolution</th>
                                <th className="py-1.5 pr-4 font-medium">duration(秒)</th>
                                <th className="py-1.5 pr-4 font-medium">参考图 / 视频 / 音频</th>
                            </tr>
                        </thead>
                        <tbody className="text-gray-700">
                            {[
                                ['doubao-seedance-2.0', '480p / 720p / 1080p / 4k', '4~15 或 -1', '9 / 3 / 3'],
                                ['doubao-seedance-2.5', '480p / 720p / 1080p', '4~30 或 -1', '30 / 10 / 10'],
                            ].map(([m, r, d, refs]) => (
                                <tr key={m} className="border-b border-gray-100">
                                    <td className="py-1.5 pr-4">
                                        <Code>{m}</Code>
                                    </td>
                                    <td className="py-1.5 pr-4">{r}</td>
                                    <td className="py-1.5 pr-4">{d}</td>
                                    <td className="py-1.5 pr-4">{refs}</td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
                <p className="text-gray-600">
                    <Code>doubao-seedance-2.0-fast</Code> / <Code>doubao-seedance-2.0-mini</Code> <b>暂停服务</b> ——
                    这两档当前不由火山方舟出片,与本渠道「原生火山」的定位不符, 恢复前请改用{' '}
                    <Code>doubao-seedance-2.0</Code> 或 <Code>doubao-seedance-2.5</Code>。
                </p>
                <p className="text-gray-600">
                    <Code>duration: -1</Code> = 智能时长(由模型在有效区间内自选)。<Code>4k</Code> 仅{' '}
                    <Code>doubao-seedance-2.0</Code> 支持(<Code>doubao-seedance-2.5</Code> 无 4k)。
                    <b>
                        <Code>doubao-seedance-2.5</Code> 的首帧/首尾帧、视频编辑、视频延长三类任务仅支持{' '}
                        <Code>ratio: &quot;adaptive&quot;</Code>
                    </b>
                    (输出宽高比自动跟随输入素材);视频编辑任务的 <Code>duration</Code> 还须为 <Code>-1</Code>。
                </p>
                <p className="font-medium text-gray-900">config 关键字段(以火山官方素材库/方舟脚本为例):</p>
                <Pre>{`{
  "API_URL":     "${BASE}",
  "API_HOST":    "${BASE.replace(/^https?:\/\//, '')}",
  "API_PROTOCOL":"${BASE.startsWith('https') ? 'https' : 'http'}",
  "API_PATH":    "/api",          // 素材库接口用 /api;视频接口签名时用 /api/v3/...(见下)
  "API_SERVICE": "ark",
  "API_VERSION": "2024-01-01",
  "API_REGION":  "cn-beijing",
  "API_AK":      "ak_ent_…",      // 「API 密钥」页生成
  "API_SK":      "sk_ent_…"       // 只显示一次,请立即保存
}`}</Pre>
                <ul className="list-disc space-y-1 pl-5">
                    <li>
                        <b>两种用法任选</b>:① 完整 SignerV4 签名(火山官方脚本自带,AK/SK 都参与);② SK 直接当 API key ——{' '}
                        <Code>Authorization: Bearer &lt;SK&gt;</Code>
                        (即 <Code>Bearer sk_ent_…</Code>,无需签名,与 727 形态一致)。两种方式等价, 同账号同计费。
                    </li>
                    <li>
                        签名的 <Code>path</Code> 用各接口真实路径:素材库 <Code>/api</Code>、视频提交{' '}
                        <Code>/api/v3/contents/generations/tasks</Code>、视频查询{' '}
                        <Code>{'/api/v3/contents/generations/tasks/{id}'}</Code>。
                    </li>
                </ul>
                <p className="font-medium text-gray-900">
                    视频(火山方舟形):<Code>POST /api/v3/contents/generations/tasks</Code>
                </p>
                <Pre>{`# body 为火山方舟原生形(model + content 数组);签名 path=/api/v3/contents/generations/tasks
{
  "model": "doubao-seedance-2.0",
  "content": [{"type": "text", "text": "一只橘猫在窗台上打哈欠"}],
  "resolution": "720p",     // 见上表(按 model 而定)
  "duration": 5             // 见上表;-1 = 智能时长
}
# → {"id":"cgt-…"}   然后 GET /api/v3/contents/generations/tasks/{id} 轮询
# → {"status":"succeeded","content":{"video_url":"https://…火山直链…"}}`}</Pre>
                <ul className="list-disc space-y-1 pl-5">
                    <li>
                        四档模型计费与国内版同名档位同价(按 <Code>usage.completion_tokens</Code>
                        )。480p 与 720p 同费率(token 量约为 720p 的一半,整条更便宜)。参考图/视频/音频写进{' '}
                        <Code>content</Code> 数组(<Code>image_url</Code> / <Code>video_url</Code> /{' '}
                        <Code>audio_url</Code>,<Code>url</Code> 支持公网直链、素材 ID)。
                    </li>
                    <li>
                        成片 <Code>content.video_url</Code> 为<b>火山官方签名直链</b>(有有效期,请及时下载转存)。
                    </li>
                </ul>

                <p className="font-medium text-gray-900">任务 ID 就是火山官方任务号</p>
                <p>
                    提交返回的 <Code>id</Code> / <Code>task_id</Code> 是<b>火山官方的任务编号</b>(<Code>cgt-</Code>{' '}
                    开头)—— 与您在火山侧看到的是<b>同一个号</b>,可直接用于对账、 工单与日志核对,无需再做任何映射。
                </p>
                <Pre>{`curl ${BASE}/v1/video/generations/cgt-20260819224039-bfjdv \\
  -H "Authorization: Bearer sk-ent-您的密钥"
# → {"status":"in_progress", "id":"cgt-20260819224039-bfjdv", …}`}</Pre>
                <ul className="list-disc space-y-1 pl-5 text-gray-600">
                    <li>
                        <b>提交会等上游受理后再返回</b>(通常十几秒)—— 火山那边分配出任务号我们才应答,
                        这样您拿到的从第一刻起就是火山官方的号。
                    </li>
                    <li>
                        若上游迟迟未受理,提交返回 <Code>504</Code> —— 请稍后重新提交。
                        <b>这种情况不计费。</b>
                    </li>
                </ul>
            </Section>

            <Section id="realperson" title="6. 火山渠道 · 真人视觉认证">
                <p>
                    在 AIGC 视频里使用<b>真人的脸</b>时,火山要求先由本人完成一次<b>活体认证授权</b>(合规,无法绕过)。
                    火山渠道专属,采用 AK/SK 签名(Action 形态),两步:
                </p>
                <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                        <thead>
                            <tr>
                                <Th>步骤</Th>
                                <Th>Action(POST /api)</Th>
                                <Th>说明</Th>
                            </tr>
                        </thead>
                        <tbody>
                            <tr>
                                <Td>1. 建会话</Td>
                                <Td>
                                    <Code>CreateVisualValidateSession</Code>
                                </Td>
                                <Td>
                                    返回 <Code>BytedToken</Code> + <Code>H5Link</Code>(约 120s 有效)+{' '}
                                    <Code>ExpiresIn</Code>
                                </Td>
                            </tr>
                            <tr>
                                <Td>2. 真人核身</Td>
                                <Td>—</Td>
                                <Td>
                                    被拍摄<b>本人</b>用手机打开 <Code>H5Link</Code>
                                    ,登录自己的火山账号完成人脸活体(此步无法用 API 替代)
                                </Td>
                            </tr>
                            <tr>
                                <Td>3. 取结果</Td>
                                <Td>
                                    <Code>GetVisualValidateResult</Code>
                                </Td>
                                <Td>
                                    入参 <Code>BytedToken</Code> → 返回真人素材组 <Code>GroupId</Code>(未完成/过期返
                                    ValidateNotReady,可轮询)
                                </Td>
                            </tr>
                        </tbody>
                    </table>
                </div>
                <p className="font-medium text-gray-900">拿到 GroupId 之后(真人素材 → 视频):</p>
                <ul className="list-disc space-y-1 pl-5">
                    <li>
                        往该 <Code>GroupId</Code> 用 <Code>CreateAsset</Code> 上传真人的图/视频,轮询至 ACTIVE,拿到{' '}
                        <Code>asset-…</Code> 素材 ID(素材库 API 见{' '}
                        <a href="/enterprise/docs/assets" className="text-blue-600 hover:underline">
                            素材库文档
                        </a>
                        );
                    </li>
                    <li>
                        视频生成时在 <Code>content</Code> 里用 <Code>{`"image_url":{"url":"asset-…"}`}</Code>{' '}
                        引用该真人素材(role 可设 <Code>reference_image</Code> / <Code>first_frame</Code>);
                    </li>
                    <li>同一演员每个资产组只需认证一次,后续换妆造不必重认证。</li>
                </ul>
                <Pre>{`# 1) 建会话(火山官方脚本 CreateVisualValidateSession,AK/SK 签名,path=/api)
# → Result: {"BytedToken":"…","H5Link":"https://ark.volcengine.com/…","ExpiresIn":120}

# 2) 把 H5Link 交给真人用手机打开、登录火山账号完成活体

# 3) 取结果 GetVisualValidateResult(入参 BytedToken)
# → Result: {"GroupId":"group-…"}    (真人素材组,GroupType=LivenessFace)`}</Pre>
            </Section>

            <div className="rounded-xl border border-blue-200 bg-blue-50 p-5 text-sm">
                <p className="font-semibold text-blue-900">素材库文档已独立成页</p>
                <p className="mt-1 text-blue-900">
                    素材库(上传/建组/引用/Action 一览/真人素材)完整说明见{' '}
                    <a href="/enterprise/docs/assets" className="font-medium text-blue-700 underline">
                        素材库文档 →
                    </a>
                </p>
            </div>

            <Section id="errors" title="7. 错误码">
                <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                        <thead>
                            <tr>
                                <Th>HTTP</Th>
                                <Th>code</Th>
                                <Th>含义与处理</Th>
                            </tr>
                        </thead>
                        <tbody>
                            <tr>
                                <Td>401</Td>
                                <Td>invalid_api_key</Td>
                                <Td>密钥无效或已禁用 —— 检查 Bearer 值,或在控制台重建密钥</Td>
                            </tr>
                            <tr>
                                <Td>402</Td>
                                <Td>insufficient_balance</Td>
                                <Td>余额不足(响应含预估价与当前余额)—— 联系对接人充值</Td>
                            </tr>
                            <tr>
                                <Td>400</Td>
                                <Td>model_not_found / invalid_request</Td>
                                <Td>模型名/resolution 非法、参考图不合格、素材 ID 不存在等(message 有具体说明)</Td>
                            </tr>
                            <tr>
                                <Td>404</Td>
                                <Td>not_found</Td>
                                <Td>任务 ID 不存在(或不属于当前账号)</Td>
                            </tr>
                            <tr>
                                <Td>503</Td>
                                <Td>temporarily_unavailable / account_not_configured</Td>
                                <Td>服务端瞬时问题或账号配置未完成 —— 稍后重试,持续出现联系对接人</Td>
                            </tr>
                            <tr>
                                <Td>403</Td>
                                <Td>ChannelNotEnabled</Td>
                                <Td>(火山渠道)真人认证等专属服务未开通 volc —— 联系对接人开通火山渠道</Td>
                            </tr>
                            <tr>
                                <Td>4xx/5xx</Td>
                                <Td>
                                    (素材库/火山)UnauthorizedOperation / InvalidParameter / AssetNotFound /
                                    GroupNotFound / ValidateNotReady / QuotaExceeded
                                </Td>
                                <Td>
                                    火山 Action 形接口的错误在 <Code>ResponseMetadata.Error</Code> 里(
                                    {`{Code, Message}`})
                                </Td>
                            </tr>
                        </tbody>
                    </table>
                </div>
            </Section>

            <Section id="faq" title="8. FAQ">
                <div>
                    <p className="font-medium">Q:任务失败,fail_reason 提示 sensitive information?</p>
                    <p className="text-gray-600">
                        这是内容安全审核拦截(生成内容随机,同提示词重跑也可能通过),并非开白/权限原因 ——
                        可换提示词重试;若仍被拦,请尝试海外版模型(seedance-2-0-global 系,审核策略不同)。 审核失败不计费。
                    </p>
                </div>
                <div className="space-y-3">
                    <div>
                        <p className="font-medium text-gray-900">Q:一条 5 秒 720p 视频多少钱?</p>
                        <p>
                            720p 5s ≈ 108,872 token:seedance-2-0 约 ¥4.26,fast 约 ¥3.42,mini 约 ¥2.13。10 秒约为 2
                            倍;1080p 约为 720p 的 2.25 倍 token。精确金额以完成后的「调用日志」为准。
                        </p>
                    </div>
                    <div>
                        <p className="font-medium text-gray-900">Q:生成失败会扣费吗?</p>
                        <p>不会。只有 status=completed 且拿到真实 token 用量才计费。</p>
                    </div>
                    <div>
                        <p className="font-medium text-gray-900">Q:video_url 打不开了?</p>
                        <p>成片直链约 24 小时过期(平台方安全策略),请在生成完成后及时下载转存到自己的存储。</p>
                    </div>
                    <div>
                        <p className="font-medium text-gray-900">Q:HTTPS 证书报错?</p>
                        <p>
                            当前入口为独立 IP,HTTPS 使用自签证书:curl 加 <Code>-k</Code>,Python requests 加{' '}
                            <Code>verify=False</Code>;或直接使用 HTTP(服务器对服务器场景)。
                        </p>
                    </div>
                    <div>
                        <p className="font-medium text-gray-900">Q:能并发提交多少任务?</p>
                        <p>无平台侧硬限制;余额充足即可并发提交,按每条任务实际用量计费。</p>
                    </div>
                    <div>
                        <p className="font-medium text-gray-900">Q:老的模型名(seedance2.0-pro-720p 等)还能用吗?</p>
                        <p>可以,旧长名全部保留兼容;新接入建议一律用 3 个短名 + resolution 参数。</p>
                    </div>
                    <div>
                        <p className="font-medium text-gray-900">Q:密钥忘了怎么办?</p>
                        <p>密钥明文只在创建时显示一次,服务端不可找回 —— 在「API 密钥」页禁用旧的、新建一把即可。</p>
                    </div>
                </div>
            </Section>
        </div>
    );
}
