import type { Metadata } from 'next';
import { BackButton } from '@/components/BackButton';
import { ImageTool } from './image-tool';

export const metadata: Metadata = {
    title: 'AI 生图测试工具 · Silk Road AI',
    description:
        '填入你的 API Key,在线测试 AI 生图 —— 文生图 / 图生图,覆盖你这把 key 能用的全部生图模型(Gemini / GPT Image 等)。',
};

export default function ImageToolPage() {
    return (
        <main className="min-h-screen bg-paper text-ink">
            <div className="mx-auto max-w-3xl px-5 py-8">
                <BackButton className="text-sm text-brand-accent hover:underline cursor-pointer border-0 bg-transparent p-0">
                    ← 返回
                </BackButton>
                <h1 className="m-0 mt-4 mb-1 text-2xl font-semibold text-navy">AI 生图测试工具</h1>
                <p className="m-0 mb-6 text-sm text-muted-ink leading-relaxed">
                    填入你的 API Key,选模型,在线测试文生图 / 图生图。覆盖你这把 key 能用的全部生图模型。表单与下方 JSON
                    双向联动,可手动改 JSON 再生成。Key 仅用于本次调用、不保存。
                </p>
                <ImageTool />
            </div>
        </main>
    );
}
