/**
 * /chat — Chat UI v1 (stateless).
 *
 * Server shell: re-uses the (authenticated) layout's auth gate, fetches
 * the chat-capable model list once (chat + vision buckets from the
 * shared catalog), and hands a vendor-grouped structure to the
 * `<ChatConsole />` client island (assistant-ui runtime). The island owns
 * all the in-memory conversation state — nothing is persisted, no DB read.
 *
 * Conversation-history persistence is intentionally deferred to a later,
 * coordinated migration (PROJECT-PLAN-B3). Still zero schema change.
 */
import { listChatModels } from '@/lib/chat/models';
import { FormError } from '@/components/ui/FormError';
import { ChatConsole } from './chat-console';
import { headers } from 'next/headers';
import { NextRequest } from 'next/server';
import { getCurrentUser } from '@/lib/auth/session';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'AI 对话 — LLmRoute' };

export default async function ChatPage() {
    const h = await headers();
    const user = await getCurrentUser(
        new NextRequest('http://internal/chat', { headers: { cookie: h.get('cookie') ?? '' } }),
    );
    const { groups, flat, totalModels } = await listChatModels(user?.id);

    return (
        <section>
            <div className="mb-4">
                <h1 className="m-0 mb-1 text-2xl font-semibold text-navy">AI 对话</h1>
                <p className="m-0 text-sm text-muted-ink">
                    选择我们接入的任意对话模型,实时流式回复;视觉模型可传图,可开启联网搜索。不保存历史,刷新即清空。
                </p>
            </div>

            {totalModels === 0 ? (
                <FormError severity="banner">当前无法获取可用模型,请稍后重试。</FormError>
            ) : (
                <ChatConsole groups={groups} modelIds={flat.map((m) => m.id)} />
            )}
        </section>
    );
}
