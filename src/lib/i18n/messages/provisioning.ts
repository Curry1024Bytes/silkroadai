import { defineMessages } from '../index';

/** Customer-safe status copy for queued new-api account provisioning. */
export const provisioningMessages = defineMessages(
    {
        heading: '模型服务账号开通状态',
        queued: '已收到开通请求，正在排队处理。开通完成前暂时无法创建或管理 API Key，请勿重复注册。',
        running: '正在自动开通模型服务账号，请稍后刷新查看。请勿重复注册。',
        retryWait: '开通遇到临时问题，系统会自动重试。',
        retryAt: (time: string) => `预计下次重试：${time}`,
        retrySoon: '系统将在稍后自动重试。',
        failed: '自动开通暂时无法完成，请联系客服并提供注册邮箱。请勿重复注册。',
        unknown: '账户尚未完成模型服务开通，系统暂未检测到自动重试任务。如长时间未完成，请联系客服并提供注册邮箱。',
        completedMissingLink: '账号开通流程已结束，但服务关联尚未就绪。请联系客服并提供注册邮箱。',
    },
    {
        heading: 'Model service account setup',
        queued: 'Your setup request is queued. API key creation and management will be available after setup; please do not register again.',
        running:
            'Your model service account is being set up automatically. Refresh this page in a little while, and please do not register again.',
        retryWait: 'A temporary issue interrupted setup. The system will retry automatically.',
        retryAt: (time: string) => `Next retry is scheduled for ${time}.`,
        retrySoon: 'The system will retry automatically shortly.',
        failed: 'Automatic setup could not be completed. Contact support with your registration email, and please do not register again.',
        unknown:
            'Your model service account is not ready, and no automatic retry is currently scheduled. If this continues, contact support with your registration email.',
        completedMissingLink:
            'Setup has ended, but the service link is not ready. Contact support with your registration email.',
    },
);

export type ProvisioningQueueStatus = 'queued' | 'running' | 'retry_wait' | 'completed' | 'failed' | null;
