/**
 * 企业门户素材库文档页(2026-07-29)—— 从主接入文档拆出独立成页。
 * 全部素材统一平台托管(2026-08-06 v3):AIGC 与真人(LivenessFace 分组)同库,四渠道通用。
 * 静态 JSX(镜像主 docs 模式)。
 */
export const dynamic = 'force-dynamic';

export const metadata = { title: 'Seedance 企业端口 · 素材库文档' };

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

export default function EnterpriseAssetsDocsPage() {
    return (
        <div className="space-y-5">
            <div className="flex items-center justify-between rounded-xl border border-gray-200 bg-white p-4 text-sm">
                <span className="font-medium text-gray-900">素材库文档</span>
                <a href="/enterprise/docs" className="text-blue-600 hover:underline">
                    ← 返回接入文档(视频 / 火山渠道)
                </a>
            </div>

            <Section id="overview" title="1. 概述">
                <p>
                    素材库用于集中管理生成要用的参考图/视频/音频:上传一次,在任意生成请求中用素材 ID
                    反复引用,并可打组管理(对标火山方舟素材库 API)。两种用法:
                </p>
                <ul className="list-disc space-y-1 pl-5">
                    <li>
                        <b>控制台</b>:「素材库」页上传本地文件、建组、改名、删除、一键复制素材 ID;
                    </li>
                    <li>
                        <b>API</b>:<Code>{`POST ${BASE}/api?Action=<action>&Version=2024-01-01&ns=asset_manager`}</Code>
                        ,JSON body,响应为 <Code>{`{ResponseMetadata, Result}`}</Code> 结构。路径 <Code>/api</Code>、
                        <Code>/api/</Code>、<Code>/?Action=…</Code>
                        (火山官方根路径形态,SDK 只换 endpoint 即可)三种写法等价。
                    </li>
                </ul>
                <p className="font-medium text-gray-900">鉴权(两种,任选其一):</p>
                <ul className="list-disc space-y-1 pl-5">
                    <li>
                        <b>Bearer</b>:<Code>Authorization: Bearer sk-ent-…</Code>(与视频接口同一把密钥);
                    </li>
                    <li>
                        <b>火山 AK/SK 签名</b>(SignerV4):兼容火山官方 SDK / 脚本,在「API 密钥」页生成 AK/SK ——
                        签名方式见{' '}
                        <a href="/enterprise/docs#volc" className="text-blue-600 hover:underline">
                            接入文档「火山渠道」
                        </a>
                        。
                    </li>
                </ul>
            </Section>

            <Section id="reference" title="2. 生成中引用(核心用法)">
                <p>
                    素材 ID(<Code>asset-…</Code>)可放进任意媒体字段;素材组 ID(<Code>group-…</Code>)放进{' '}
                    <Code>images</Code> 数组按序展开为组内全部成员。
                </p>
                <Pre>{`{"model":"seedance-2-0","prompt":"…","images":["asset-20260719153358-db513a"]}
{"model":"seedance-2-0","prompt":"…","first_frame":"asset-20260719153358-db513a"}
{"model":"seedance-2-0-fast","prompt":"…","images":["group-20260719153506-b945c6"]}`}</Pre>
            </Section>

            <Section id="actions" title="3. Action 一览">
                <p className="text-gray-600">公共参数:query 里 Action 必填、Version=2024-01-01、ns=asset_manager。</p>
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
                                    AssetType(Image/Video/Audio,对齐火山官方;大小写均兼容)、URL(公网直链,≤100MB)、Name(≤100)、Description?、
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
                                <Td>
                                    GroupId?、AssetType?、GroupType?(缺省 AIGC;查真人素材须显式
                                    LivenessFace)、PageNumber?(默认1)、PageSize?(默认20,≤100)
                                </Td>
                                <Td>{`{Items:[…], Total, PageNumber, PageSize}`}</Td>
                            </tr>
                            <tr>
                                <Td>
                                    <Code>CreateAssetGroup</Code>
                                </Td>
                                <Td>Name(≤100)、Description?、GroupType?(AIGC 默认 / LivenessFace 真人)</Td>
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
                                <Td>GroupType?(缺省 AIGC)、PageNumber?、PageSize?</Td>
                                <Td>{`{Items:[…], Total, …}`}</Td>
                            </tr>
                        </tbody>
                    </table>
                </div>
            </Section>

            <Section id="example" title="4. 示例:注册素材 → 建组 → 归组 → 生成引用">
                <Pre>{`# 注册素材(URL 需公网可抓;本地文件请在控制台「素材库」页直接上传)
curl -X POST "${BASE}/api?Action=CreateAsset&Version=2024-01-01&ns=asset_manager" \\
  -H "Authorization: Bearer sk-ent-…" -H "Content-Type: application/json" \\
  -d '{"AssetType":"Image","URL":"https://…/hero.png","Name":"主角图"}'
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

            <Section id="volc-assets" title="5. 真人素材(LivenessFace 分组)">
                <p>
                    <b>全部素材统一平台托管(与鉴权方式、渠道无关)</b>:AIGC 与真人素材(
                    <Code>{`"GroupType":"LivenessFace"`}</Code> 分组)都存平台素材库,<b>全部渠道</b>
                    (国内 / 海外 / proMax / 火山)生成时均可用 <Code>asset://素材ID</Code> 引用。
                </p>
                <ul className="list-disc space-y-1 pl-5">
                    <li>
                        建组时传 <Code>{`"GroupType":"LivenessFace"`}</Code> 即真人素材组(缺省 <Code>AIGC</Code>
                        );列表对齐火山官方语义 —— <b>缺省只列 AIGC</b>,查真人组/素材须显式传{' '}
                        <Code>{`"GroupType":"LivenessFace"`}</Code>(顶层或 <Code>Filter</Code> 内均可)。
                    </li>
                    <li>
                        真人视觉认证流程(火山渠道)见{' '}
                        <a href="/enterprise/docs#realperson" className="text-blue-600 hover:underline">
                            接入文档「火山渠道 · 真人认证」
                        </a>
                        。
                    </li>
                    <li>Action 契约与上表一致;素材 URL 为平台直链(长期有效)。</li>
                </ul>
            </Section>
        </div>
    );
}
