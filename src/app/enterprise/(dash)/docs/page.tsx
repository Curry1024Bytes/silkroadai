/**
 * 企业门户客户接入文档页(2026-07-20)。全量内容(参数表/示例/素材库契约/错误码/FAQ),
 * 不做删减版 —— 客户技术对接人看这一页即可完成接入。静态 JSX(镜像主站 /docs 模式)。
 */
export const dynamic = 'force-dynamic';

export const metadata = { title: 'Seedance 企业端口 · 接入文档' };

const BASE = process.env.NEXT_PUBLIC_ENTERPRISE_BASE_URL || 'http://128.241.232.23';

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
                    ['assets', '素材库'],
                    ['errors', '错误码'],
                    ['faq', 'FAQ'],
                ].map(([id, label]) => (
                    <a key={id} href={`#${id}`} className="mr-3 text-blue-600 hover:underline">
                        {label}
                    </a>
                ))}
            </nav>

            <Section id="quickstart" title="1. 快速开始">
                <table className="w-full text-sm">
                    <tbody>
                        <tr>
                            <Td>Base URL</Td>
                            <Td>
                                <Code>{`${BASE}/v1`}</Code>
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
                                HTTP;HTTPS(:443)为自签证书,需关闭证书校验(curl <Code>-k</Code> / Python{' '}
                                <Code>verify=False</Code>)
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
                    三个模型,分辨率用 <Code>resolution</Code> 参数选,带参考图/视频自动识别 —— 无需切换模型名:
                </p>
                <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                        <thead>
                            <tr>
                                <Th>模型</Th>
                                <Th>说明</Th>
                                <Th>分辨率</Th>
                                <Th>无视频输入(¥/1M token)</Th>
                                <Th>含视频输入(¥/1M token)</Th>
                            </tr>
                        </thead>
                        <tbody>
                            <tr>
                                <Td>
                                    <Code>seedance-2-0</Code>
                                </Td>
                                <Td>旗舰(Pro)</Td>
                                <Td>720p / 1080p / 4k</Td>
                                <Td>39.1 / 43.35 / 22.1</Td>
                                <Td>23.8 / 26.35 / 13.6</Td>
                            </tr>
                            <tr>
                                <Td>
                                    <Code>seedance-2-0-fast</Code>
                                </Td>
                                <Td>快速档</Td>
                                <Td>720p / 1080p</Td>
                                <Td>31.45</Td>
                                <Td>18.7</Td>
                            </tr>
                            <tr>
                                <Td>
                                    <Code>seedance-2-0-mini</Code>
                                </Td>
                                <Td>轻量档</Td>
                                <Td>720p / 1080p</Td>
                                <Td>19.55</Td>
                                <Td>11.9</Td>
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
                        参考:720p 5 秒 ≈ 108,872 token → seedance-2-0 约 ¥4.26、fast 约 ¥3.42、mini 约 ¥2.13;1080p ≈
                        720p 的 2.25 倍 token。
                    </li>
                    <li>「含视频输入」(参考视频)费率更低,但输入视频的时长也计入 token。图片参考不额外计 token。</li>
                    <li>生成失败不计费。提交时按预估价校验余额,不足返回 402(不会透支)。</li>
                    <li>消费明细实时可见:「计费流水」「调用日志」页,每笔带 token 数与金额。</li>
                </ul>
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
                                <Td>seedance-2-0 / seedance-2-0-fast / seedance-2-0-mini(大小写不敏感)</Td>
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
                                <Td>720p(默认)/ 1080p / 4k(4k 仅 seedance-2-0)</Td>
                            </tr>
                            <tr>
                                <Td>
                                    <Code>duration</Code>
                                </Td>
                                <Td>int</Td>
                                <Td>否</Td>
                                <Td>5(默认)/ 10 / 15,单位秒</Td>
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
                    ID(第 5 节)。
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
                                <Td>string[](≤9)</Td>
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
                                <Td>string[](≤3)</Td>
                                <Td>参考视频(风格/运动参考;输入视频时长计入 token,费率走「含视频输入」档,更低)</Td>
                            </tr>
                            <tr>
                                <Td>
                                    <Code>audios</Code>
                                </Td>
                                <Td>string[]</Td>
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

            <Section id="assets" title="5. 素材库">
                <p>
                    素材库用于集中管理生成要用的参考图/视频/音频:上传一次,在任意生成请求中用素材 ID
                    反复引用,并可打组管理 (对标火山方舟素材库 API)。两种用法:
                </p>
                <ul className="list-disc space-y-1 pl-5">
                    <li>
                        <b>控制台</b>:「素材库」页上传本地文件、建组、改名、删除、一键复制素材 ID;
                    </li>
                    <li>
                        <b>API</b>:<Code>{`POST ${BASE}/api?Action=<action>&Version=2024-01-01&ns=asset_manager`}</Code>
                        ,JSON body,同一把 <Code>Bearer sk-ent-…</Code> 鉴权,响应为{' '}
                        <Code>{`{ResponseMetadata, Result}`}</Code> 结构。
                    </li>
                </ul>
                <p className="font-medium text-gray-900">生成中引用(核心用法):</p>
                <Pre>{`# 素材 ID(asset-…)可放进任意媒体字段;素材组 ID(group-…)放进 images 数组按序展开全部成员
{"model":"seedance-2-0","prompt":"…","images":["asset-20260719153358-db513a"]}
{"model":"seedance-2-0","prompt":"…","first_frame":"asset-20260719153358-db513a"}
{"model":"seedance-2-0-fast","prompt":"…","images":["group-20260719153506-b945c6"]}`}</Pre>
                <p className="font-medium text-gray-900">
                    Action 一览(公共参数:query 里 Action 必填、Version=2024-01-01、ns=asset_manager):
                </p>
                <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                        <thead>
                            <tr>
                                <Th>Action</Th>
                                <Th>请求体</Th>
                                <Th>返回 Result</Th>
                            </tr>
                        </thead>
                        <tbody>
                            <tr>
                                <Td>
                                    <Code>CreateAsset</Code>
                                </Td>
                                <Td>
                                    AssetType(image/video/audio)、URL(公网直链,≤100MB)、Name(≤100)、Description?、
                                    GroupId?
                                </Td>
                                <Td>{`{Id:"asset-…", Status:"active", URL:"托管直链"}`}</Td>
                            </tr>
                            <tr>
                                <Td>
                                    <Code>GetAsset</Code>
                                </Td>
                                <Td>Id</Td>
                                <Td>素材详情(Name/AssetType/URL/Bytes/GroupId/CreatedAt)</Td>
                            </tr>
                            <tr>
                                <Td>
                                    <Code>UpdateAsset</Code>
                                </Td>
                                <Td>Id、Name?、Description?、GroupId?(null 解组)</Td>
                                <Td>{`{}`}</Td>
                            </tr>
                            <tr>
                                <Td>
                                    <Code>DeleteAsset</Code>
                                </Td>
                                <Td>Id</Td>
                                <Td>{`{}`}(引用它的后续生成会报素材不存在)</Td>
                            </tr>
                            <tr>
                                <Td>
                                    <Code>ListAssets</Code>
                                </Td>
                                <Td>GroupId?、AssetType?、PageNumber?(默认1)、PageSize?(默认20,≤100)</Td>
                                <Td>{`{Items:[…], Total, PageNumber, PageSize}`}</Td>
                            </tr>
                            <tr>
                                <Td>
                                    <Code>CreateAssetGroup</Code>
                                </Td>
                                <Td>Name(≤100)、Description?</Td>
                                <Td>{`{Id:"group-…"}`}</Td>
                            </tr>
                            <tr>
                                <Td>
                                    <Code>GetAssetGroup</Code>
                                </Td>
                                <Td>Id</Td>
                                <Td>组详情 + AssetCount</Td>
                            </tr>
                            <tr>
                                <Td>
                                    <Code>UpdateAssetGroup</Code>
                                </Td>
                                <Td>Id、Name?、Description?</Td>
                                <Td>{`{}`}</Td>
                            </tr>
                            <tr>
                                <Td>
                                    <Code>DeleteAssetGroup</Code>
                                </Td>
                                <Td>Id</Td>
                                <Td>{`{}`}(仅解散组,素材保留为未分组)</Td>
                            </tr>
                            <tr>
                                <Td>
                                    <Code>ListAssetGroups</Code>
                                </Td>
                                <Td>PageNumber?、PageSize?</Td>
                                <Td>{`{Items:[…], Total, …}`}</Td>
                            </tr>
                        </tbody>
                    </table>
                </div>
                <p className="font-medium text-gray-900">示例:注册素材 → 建组 → 归组 → 生成引用</p>
                <Pre>{`# 注册素材(URL 需公网可抓;本地文件请在控制台「素材库」页直接上传)
curl -X POST "${BASE}/api?Action=CreateAsset&Version=2024-01-01&ns=asset_manager" \\
  -H "Authorization: Bearer sk-ent-…" -H "Content-Type: application/json" \\
  -d '{"AssetType":"image","URL":"https://…/hero.png","Name":"主角图"}'
# → Result.Id = "asset-…"

# 建素材组
curl -X POST "${BASE}/api?Action=CreateAssetGroup&Version=2024-01-01&ns=asset_manager" \\
  -H "Authorization: Bearer sk-ent-…" -H "Content-Type: application/json" \\
  -d '{"Name":"主角参考组"}'
# → Result.Id = "group-…"

# 素材归组
curl -X POST "${BASE}/api?Action=UpdateAsset&Version=2024-01-01&ns=asset_manager" \\
  -H "Authorization: Bearer sk-ent-…" -H "Content-Type: application/json" \\
  -d '{"Id":"asset-…","GroupId":"group-…"}'

# 生成里引用整组
curl -X POST ${BASE}/v1/video/generations \\
  -H "Authorization: Bearer sk-ent-…" -H "Content-Type: application/json" \\
  -d '{"model":"seedance-2-0","prompt":"主角在雨中行走","images":["group-…"]}'`}</Pre>
                <p>
                    配额:默认 500 个素材 / 总量 5GB / 单文件
                    100MB(需扩容联系对接人)。素材托管在平台对象存储,长期有效(区别于成片直链 24h)。
                </p>
            </Section>

            <Section id="errors" title="6. 错误码">
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
                                <Td>4xx/5xx</Td>
                                <Td>
                                    (素材库)UnauthorizedOperation / InvalidParameter / AssetNotFound / GroupNotFound /
                                    QuotaExceeded
                                </Td>
                                <Td>
                                    素材库 API 的错误在 <Code>ResponseMetadata.Error</Code> 里({`{Code, Message}`})
                                </Td>
                            </tr>
                        </tbody>
                    </table>
                </div>
            </Section>

            <Section id="faq" title="7. FAQ">
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
