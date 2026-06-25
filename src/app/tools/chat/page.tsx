import type { Metadata } from 'next';
import { BackButton } from '@/components/BackButton';
import { ChatTool } from './chat-tool';

export const metadata: Metadata = {
    title: 'AI 对话测试工具 · Silk Road AI',
    description:
        '填入你的 API Key,在线测试 AI 对话(流式)—— 覆盖你这把 key 能用的全部对话模型(GPT / Claude / Gemini / DeepSeek 等)。',
};

export default function ChatToolPage() {
    return (
        <main className="min-h-screen bg-paper text-ink">
            <div className="mx-auto max-w-3xl px-5 py-8">
                <BackButton className="text-sm text-brand-accent hover:underline cursor-pointer border-0 bg-transparent p-0">
                    ← 返回
                </BackButton>
                <h1 className="m-0 mt-4 mb-1 text-2xl font-semibold text-navy">AI 对话测试工具</h1>
                <p className="m-0 mb-6 text-sm text-muted-ink leading-relaxed">
                    填入你的 API Key,选模型,直接在线测试对话(逐字流式)。覆盖你这把 key 能用的全部对话模型。Key
                    仅用于本次调用、不保存。
                </p>
                <ChatTool />
            </div>
        </main>
    );
}
