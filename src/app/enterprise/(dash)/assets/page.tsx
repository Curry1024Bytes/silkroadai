/**
 * 企业门户素材库页(P2 占位)—— P3 接上游素材 API(CreateAsset/CreateAssetGroup 等,
 * 网关按 key 归属隔离),见 seedance-enterprise-portal-design.md §3.6。
 */
export const dynamic = 'force-dynamic';

export const metadata = { title: 'Seedance 企业端口 · 素材库' };

export default function EnterpriseAssetsPage() {
    return (
        <section className="rounded-xl border border-gray-200 bg-white p-8 text-center">
            <h2 className="text-base font-semibold text-gray-900">素材库</h2>
            <p className="mx-auto mt-2 max-w-md text-sm text-gray-500">
                素材资产管理(上传参考图/视频、建素材组、在生成中引用)即将上线。 当前可在生成请求里直接传参考图/视频 URL
                或 base64,功能不受影响。
            </p>
        </section>
    );
}
