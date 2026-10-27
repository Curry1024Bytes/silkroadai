'use client';

/**
 * W9 D3 PR-C — 自定义 OSS 配置表单(client)。
 *
 * 状态机:
 *   - mode: 'default'(平台 R2)/ 'custom'(自定义 OSS)
 *   - 测试连接通过(tested=ok)才能保存;任何字段改动会使 tested 失效
 *   - 保存走 PUT /api/portal/oss(服务端会再测一次连接,双保险)
 *   - 清除走 DELETE /api/portal/oss,回平台默认
 *
 * 安全提示:secret 只在提交时发送(HTTPS),服务端 AES-256-GCM 加密存储,
 * GET 永远不返回 secret;编辑已有配置需要重新输入 secret。
 */
import { useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/Card';
import { Input } from '@/components/ui/Input';
import { Label } from '@/components/ui/Label';
import { intlLocale } from '@/lib/i18n';
import { useLocale, useMessages } from '@/lib/i18n/client';
import { storageMessages, type StorageMessages } from '@/lib/i18n/messages/storage';

export interface OssConfigView {
    provider: string;
    endpoint: string | null;
    bucket: string;
    region: string | null;
    access_key_id_masked: string;
    public_url_prefix: string;
    status: string;
    last_test_at: string | null;
}

interface Props {
    initialConfig: OssConfigView | null;
    /** OSS 配置 API 前缀。默认主站 /api/portal/oss;企业门户传 /api/enterprise/oss
     *  (企业裸 IP 门户 Caddy 只放行 /api/enterprise/*)。 */
    apiBase?: string;
    /** 「默认存储」单选项的说明文案。主站生图默认落平台 R2(images.silkroadai.io);
     *  Seedance 企业视频默认【返回上游直链】(不落平台),故文案不同,由调用方传入。 */
    defaultModeHint?: string;
}

interface ProviderMeta {
    value: string;
    label: string;
    endpointHint: string;
}

function providers(m: StorageMessages['form']): ProviderMeta[] {
    return [
        { value: 'r2', label: m.providers.r2, endpointHint: 'https://<account_id>.r2.cloudflarestorage.com' },
        { value: 'aliyun-oss', label: m.providers.aliyun, endpointHint: 'https://oss-cn-hangzhou.aliyuncs.com' },
        { value: 'tencent-cos', label: m.providers.tencent, endpointHint: 'https://cos.ap-guangzhou.myqcloud.com' },
        { value: 's3', label: m.providers.s3, endpointHint: m.s3EndpointHint },
        { value: 's3-custom', label: m.providers.s3Custom, endpointHint: 'https://minio.example.com' },
    ];
}

type TestState = { state: 'idle' | 'testing' } | { state: 'ok' } | { state: 'fail'; message: string };
type SaveState = 'idle' | 'saving' | 'saved' | 'error';

export function StorageSettingsForm({ initialConfig, apiBase = '/api/portal/oss', defaultModeHint }: Props) {
    const m = useMessages(storageMessages).form;
    const locale = useLocale();
    const PROVIDERS = providers(m);
    const [mode, setMode] = useState<'default' | 'custom'>(initialConfig ? 'custom' : 'default');
    const [provider, setProvider] = useState(initialConfig?.provider ?? 'r2');
    const [endpoint, setEndpoint] = useState(initialConfig?.endpoint ?? '');
    const [bucket, setBucket] = useState(initialConfig?.bucket ?? '');
    const [region, setRegion] = useState(initialConfig?.region ?? '');
    const [accessKeyId, setAccessKeyId] = useState('');
    const [secretAccessKey, setSecretAccessKey] = useState('');
    const [publicUrlPrefix, setPublicUrlPrefix] = useState(initialConfig?.public_url_prefix ?? '');

    const [test, setTest] = useState<TestState>({ state: 'idle' });
    const [save, setSave] = useState<SaveState>('idle');
    const [saveErr, setSaveErr] = useState<string | null>(null);
    const [savedConfig, setSavedConfig] = useState<OssConfigView | null>(initialConfig);

    const providerMeta = PROVIDERS.find((p) => p.value === provider) ?? PROVIDERS[0];
    const endpointRequired = provider !== 's3';
    const regionRequired = provider === 's3';

    const fieldsComplete =
        bucket.trim() !== '' &&
        accessKeyId.trim() !== '' &&
        secretAccessKey.trim() !== '' &&
        publicUrlPrefix.trim() !== '' &&
        (!endpointRequired || endpoint.trim() !== '') &&
        (!regionRequired || region.trim() !== '');

    function buildPayload() {
        return {
            provider,
            endpoint: endpoint.trim() || null,
            bucket: bucket.trim(),
            region: region.trim() || null,
            access_key_id: accessKeyId.trim(),
            secret_access_key: secretAccessKey,
            public_url_prefix: publicUrlPrefix.trim(),
        };
    }

    /** 任何字段改动 → 之前的测试结果作废 */
    function touch<T>(setter: (v: T) => void) {
        return (v: T) => {
            setter(v);
            setTest({ state: 'idle' });
            setSave('idle');
        };
    }

    async function handleTest() {
        setTest({ state: 'testing' });
        try {
            const res = await fetch(`${apiBase}/test-connection`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(buildPayload()),
            });
            const data = (await res.json()) as { ok?: boolean; message?: string; error?: string };
            if (res.ok && data.ok) {
                setTest({ state: 'ok' });
            } else {
                setTest({ state: 'fail', message: data.message ?? data.error ?? `HTTP ${res.status}` });
            }
        } catch (e) {
            setTest({ state: 'fail', message: e instanceof Error ? e.message : String(e) });
        }
    }

    async function handleSave() {
        setSave('saving');
        setSaveErr(null);
        try {
            const res = await fetch(apiBase, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(buildPayload()),
            });
            const data = (await res.json()) as { ok?: boolean; message?: string; error?: string };
            if (res.ok && data.ok) {
                setSave('saved');
                setSavedConfig({
                    provider,
                    endpoint: endpoint.trim() || null,
                    bucket: bucket.trim(),
                    region: region.trim() || null,
                    access_key_id_masked: `${accessKeyId.slice(0, 4)}****`,
                    public_url_prefix: publicUrlPrefix.trim(),
                    status: 'active',
                    last_test_at: new Date().toLocaleString(intlLocale(locale), { timeZone: 'Asia/Shanghai' }),
                });
                setSecretAccessKey('');
                setTest({ state: 'idle' });
            } else {
                setSave('error');
                setSaveErr(data.message ?? data.error ?? `HTTP ${res.status}`);
            }
        } catch (e) {
            setSave('error');
            setSaveErr(e instanceof Error ? e.message : String(e));
        }
    }

    async function handleClear() {
        setSave('saving');
        setSaveErr(null);
        try {
            const res = await fetch(apiBase, { method: 'DELETE' });
            if (res.ok) {
                setSavedConfig(null);
                setMode('default');
                setSave('idle');
                setTest({ state: 'idle' });
            } else {
                setSave('error');
                setSaveErr(`HTTP ${res.status}`);
            }
        } catch (e) {
            setSave('error');
            setSaveErr(e instanceof Error ? e.message : String(e));
        }
    }

    return (
        <Card className="mt-6">
            <CardHeader>
                <CardTitle>{m.cardTitle}</CardTitle>
            </CardHeader>
            <CardContent>
                {/* 模式选择 */}
                <div className="flex flex-col gap-2">
                    <label className="flex items-start gap-2 cursor-pointer">
                        <input
                            type="radio"
                            name="oss-mode"
                            checked={mode === 'default'}
                            onChange={() => setMode('default')}
                            className="mt-1"
                        />
                        <span>
                            <span className="text-sm font-medium text-navy">{m.defaultMode}</span>
                            <span className="block text-xs text-muted-ink">{defaultModeHint ?? m.defaultModeHint}</span>
                        </span>
                    </label>
                    <label className="flex items-start gap-2 cursor-pointer">
                        <input
                            type="radio"
                            name="oss-mode"
                            checked={mode === 'custom'}
                            onChange={() => setMode('custom')}
                            className="mt-1"
                        />
                        <span>
                            <span className="text-sm font-medium text-navy">{m.customMode}</span>
                            <span className="block text-xs text-muted-ink">{m.customModeHint}</span>
                        </span>
                    </label>
                </div>

                {/* 已保存配置摘要 */}
                {savedConfig && (
                    <div className="mt-4 rounded-lg border border-brand-border bg-paper-muted px-4 py-3 text-sm">
                        <span className="font-medium text-navy">
                            {m.currentConfig}
                            {PROVIDERS.find((p) => p.value === savedConfig.provider)?.label ?? savedConfig.provider}
                        </span>
                        <span className="ml-2 text-muted-ink">
                            bucket <code className="font-mono text-xs">{savedConfig.bucket}</code> · AK{' '}
                            <code className="font-mono text-xs">{savedConfig.access_key_id_masked}</code> · {m.prefix}{' '}
                            <code className="font-mono text-xs">{savedConfig.public_url_prefix}</code>
                        </span>
                        <Button
                            variant="ghost"
                            size="sm"
                            className="ml-3"
                            onClick={handleClear}
                            disabled={save === 'saving'}
                        >
                            {m.clear}
                        </Button>
                    </div>
                )}

                {mode === 'custom' && (
                    <div className="mt-5 flex flex-col gap-4">
                        <div>
                            <Label htmlFor="oss-provider">{m.provider}</Label>
                            <select
                                id="oss-provider"
                                value={provider}
                                onChange={(e) => touch(setProvider)(e.target.value)}
                                className="mt-1 block w-full rounded-lg border border-brand-border bg-surface px-3 py-2 text-sm text-navy"
                            >
                                {PROVIDERS.map((p) => (
                                    <option key={p.value} value={p.value}>
                                        {p.label}
                                    </option>
                                ))}
                            </select>
                        </div>

                        <div>
                            <Label htmlFor="oss-endpoint">Endpoint{endpointRequired ? '' : m.optional}</Label>
                            <Input
                                id="oss-endpoint"
                                value={endpoint}
                                onChange={(e) => touch(setEndpoint)(e.target.value)}
                                placeholder={providerMeta.endpointHint}
                            />
                        </div>

                        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                            <div>
                                <Label htmlFor="oss-bucket">Bucket</Label>
                                <Input
                                    id="oss-bucket"
                                    value={bucket}
                                    onChange={(e) => touch(setBucket)(e.target.value)}
                                    placeholder="my-images"
                                />
                            </div>
                            <div>
                                <Label htmlFor="oss-region">Region{regionRequired ? '' : m.optional}</Label>
                                <Input
                                    id="oss-region"
                                    value={region}
                                    onChange={(e) => touch(setRegion)(e.target.value)}
                                    placeholder={provider === 's3' ? 'us-east-1' : 'auto'}
                                />
                            </div>
                        </div>

                        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                            <div>
                                <Label htmlFor="oss-ak">Access Key ID</Label>
                                <Input
                                    id="oss-ak"
                                    value={accessKeyId}
                                    onChange={(e) => touch(setAccessKeyId)(e.target.value)}
                                    placeholder={
                                        savedConfig ? m.akStoredPlaceholder(savedConfig.access_key_id_masked) : ''
                                    }
                                    autoComplete="off"
                                />
                            </div>
                            <div>
                                <Label htmlFor="oss-sk">Secret Access Key</Label>
                                <Input
                                    id="oss-sk"
                                    type="password"
                                    value={secretAccessKey}
                                    onChange={(e) => touch(setSecretAccessKey)(e.target.value)}
                                    placeholder={savedConfig ? m.skStoredPlaceholder : ''}
                                    autoComplete="new-password"
                                />
                            </div>
                        </div>

                        <div>
                            <Label htmlFor="oss-prefix">{m.publicPrefix}</Label>
                            <Input
                                id="oss-prefix"
                                value={publicUrlPrefix}
                                onChange={(e) => touch(setPublicUrlPrefix)(e.target.value)}
                                placeholder="https://images.example.com"
                            />
                            <p className="mt-1 text-xs text-minor-ink">{m.publicPrefixHint}</p>
                        </div>

                        {/* 测试 + 保存 */}
                        <div className="flex items-center gap-3 flex-wrap">
                            <Button
                                onClick={handleTest}
                                disabled={!fieldsComplete || test.state === 'testing'}
                                variant="secondary"
                            >
                                {test.state === 'testing' ? m.testing : m.testConnection}
                            </Button>
                            <Button onClick={handleSave} disabled={test.state !== 'ok' || save === 'saving'}>
                                {save === 'saving' ? m.saving : m.saveConfig}
                            </Button>
                            {test.state === 'ok' && <span className="text-sm text-green-700">{m.testOk}</span>}
                            {test.state === 'fail' && (
                                <span className="text-sm text-red-600">
                                    {m.testFail}
                                    {test.message}
                                </span>
                            )}
                            {save === 'saved' && <span className="text-sm text-green-700">{m.saved}</span>}
                            {save === 'error' && saveErr && (
                                <span className="text-sm text-red-600">
                                    {m.saveFailed}
                                    {saveErr}
                                </span>
                            )}
                        </div>

                        <p className="text-xs text-minor-ink">
                            {m.security1}
                            <strong>{m.security2}</strong>
                            {m.security3}
                            <code className="mx-1 font-mono">X-Silkroadai-Oss-Fallback</code>
                            {m.security4}
                        </p>
                    </div>
                )}
            </CardContent>
        </Card>
    );
}
