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
import { getLocale } from '@/lib/i18n/server';
import { pickMessages } from '@/lib/i18n';
import { chatMessages } from '@/lib/i18n/messages/chat';

export const dynamic = 'force-dynamic';
export async function generateMetadata() {
    const m = pickMessages(chatMessages, await getLocale());
    return { title: m.page.metaTitle };
}

export default async function ChatPage() {
    const [{ groups, flat, totalModels }, locale] = await Promise.all([listChatModels(), getLocale()]);
    const m = pickMessages(chatMessages, locale);

    return (
        <section>
            <div className="mb-4">
                <h1 className="m-0 mb-1 text-2xl font-semibold text-navy">{m.page.title}</h1>
                <p className="m-0 text-sm text-muted-ink">{m.page.intro}</p>
            </div>

            {totalModels === 0 ? (
                <FormError severity="banner">{m.page.noModels}</FormError>
            ) : (
                <ChatConsole groups={groups} modelIds={flat.map((m) => m.id)} />
            )}
        </section>
    );
}
