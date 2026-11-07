import { describe, expect, it } from 'vitest';
import { ticketCreatedTemplate, ticketUpdatedTemplate } from '@/lib/email/templates';

const base = { number: 'T-000012', subject: 'gpt-5.5 <b>扣费</b>', ticketUrl: 'https://silkroadai.io/support/x' };

describe('ticket email templates', () => {
    it('zh / en created mail carries number, link and escapes html in the subject line', () => {
        const zh = ticketCreatedTemplate({ ...base, locale: 'zh' });
        expect(zh.subject).toContain('工单 T-000012 已收到');
        expect(zh.html).toContain('&lt;b&gt;扣费&lt;/b&gt;');
        expect(zh.html).not.toContain('<b>扣费</b>');
        expect(zh.text).toContain(base.ticketUrl);
        const en = ticketCreatedTemplate({ ...base, locale: 'en' });
        expect(en.subject).toContain('Ticket T-000012 received');
        expect(en.html).toContain('View ticket');
    });
    it('updated mail switches lead copy by kind and quotes the excerpt', () => {
        const r = ticketUpdatedTemplate({ ...base, locale: 'zh', kind: 'resolved' });
        expect(r.subject).toContain('工单已处理完成');
        expect(r.text).toContain('仍未解决');
        const reply = ticketUpdatedTemplate({
            ...base,
            locale: 'en',
            kind: 'staff_reply',
            excerpt: 'We credited ¥0.50 <script>',
        });
        expect(reply.subject).toContain('Support replied');
        expect(reply.html).toContain('&lt;script&gt;');
        expect(reply.text).toContain('We credited ¥0.50');
    });
});
