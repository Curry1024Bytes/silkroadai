import type { Metadata } from 'next';
import Link from 'next/link';
import { SeedanceTool } from './seedance-tool';

export const metadata: Metadata = {
    title: 'Seedance 视频测试工具 · Silk Road AI',
    description:
        '填入你的 API Key,在线测试 Seedance 视频生成 —— 支持文生 / 图生 / 首尾帧 / 多图 / 参考音频,覆盖海外满血与逆向低价全部模型。',
};

export default function SeedanceToolPage() {
    return (
        <main className="min-h-screen bg-paper text-ink">
            <div className="mx-auto max-w-3xl px-5 py-8">
                <Link href="/" className="text-sm text-brand-accent hover:underline">
                    ← 返回首页
                </Link>
                <h1 className="m-0 mt-4 mb-1 text-2xl font-semibold text-navy">Seedance 视频测试工具</h1>
                <p className="m-0 mb-6 text-sm text-muted-ink leading-relaxed">
                    填入你的 API Key,选模型 + 玩法,直接在线生视频测试。支持文生 / 图生 / 首尾帧 / 多图 / 参考音频,
                    覆盖你这把 key 能用的所有 Seedance 模型。Key 仅用于本次调用、不保存。
                </p>
                <SeedanceTool />
            </div>
        </main>
    );
}
