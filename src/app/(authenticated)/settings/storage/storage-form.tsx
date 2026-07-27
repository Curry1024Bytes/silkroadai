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
}

const PROVIDERS: Array<{ value: string; label: string; endpointHint: string }> = [
    { value: 'r2', label: 'Cloudflare R2', endpointHint: 'https://<account_id>.r2.cloudflarestorage.com' },
    { value: 'aliyun-oss', label: '阿里云 OSS', endpointHint: 'https://oss-cn-hangzhou.aliyuncs.com' },
    { value: 'tencent-cos', label: '腾讯云 COS', endpointHint: 'https://cos.ap-guangzhou.myqcloud.com' },
    { value: 's3', label: 'AWS S3', endpointHint: '留空(走 AWS 默认,需填 region)' },
    { value: 's3-custom', label: '自建 / 其他 S3 兼容', endpointHint: 'https://minio.example.com' },
];

type TestState = { state: 'idle' | 'testing' } | { state: 'ok' } | { state: 'fail'; message: string };
type SaveState = 'idle' | 'saving' | 'saved' | 'error';

export function StorageSettingsForm({ initialConfig }: Props) {
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
            const res = await fetch('/api/portal/oss/test-connection', {
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
            const res = await fetch('/api/portal/oss', {
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
                    last_test_at: new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }),
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
            const res = await fetch('/api/portal/oss', { method: 'DELETE' });
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
                <CardTitle>图片 / 视频输出存储</CardTitle>
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
                            <span className="text-sm font-medium text-navy">默认存储(推荐)</span>
                            <span className="block text-xs text-muted-ink">
                                LLmRoute 托管,无需配置,URL 为 images.llmroute.club
                            </span>
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
                            <span className="text-sm font-medium text-navy">自定义对象存储</span>
                            <span className="block text-xs text-muted-ink">
                                图片和视频直接上传到你自己的 bucket,URL 用你的域名,数据归属你
                            </span>
                        </span>
                    </label>
                </div>

                {/* 已保存配置摘要 */}
                {savedConfig && (
                    <div className="mt-4 rounded-lg border border-brand-border bg-paper-muted px-4 py-3 text-sm">
                        <span className="font-medium text-navy">
                            当前配置:
                            {PROVIDERS.find((p) => p.value === savedConfig.provider)?.label ?? savedConfig.provider}
                        </span>
                        <span className="ml-2 text-muted-ink">
                            bucket <code className="font-mono text-xs">{savedConfig.bucket}</code> · AK{' '}
                            <code className="font-mono text-xs">{savedConfig.access_key_id_masked}</code> · 前缀{' '}
                            <code className="font-mono text-xs">{savedConfig.public_url_prefix}</code>
                        </span>
                        <Button
                            variant="ghost"
                            size="sm"
                            className="ml-3"
                            onClick={handleClear}
                            disabled={save === 'saving'}
                        >
                            清除(回默认)
                        </Button>
                    </div>
                )}

                {mode === 'custom' && (
                    <div className="mt-5 flex flex-col gap-4">
                        <div>
                            <Label htmlFor="oss-provider">服务商</Label>
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
                            <Label htmlFor="oss-endpoint">Endpoint{endpointRequired ? '' : '(可选)'}</Label>
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
                                <Label htmlFor="oss-region">Region{regionRequired ? '' : '(可选)'}</Label>
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
                                        savedConfig ? `已存(${savedConfig.access_key_id_masked}),修改需重填` : ''
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
                                    placeholder={savedConfig ? '已加密存储,修改需重填' : ''}
                                    autoComplete="new-password"
                                />
                            </div>
                        </div>

                        <div>
                            <Label htmlFor="oss-prefix">公网访问前缀</Label>
                            <Input
                                id="oss-prefix"
                                value={publicUrlPrefix}
                                onChange={(e) => touch(setPublicUrlPrefix)(e.target.value)}
                                placeholder="https://images.example.com"
                            />
                            <p className="mt-1 text-xs text-minor-ink">
                                bucket 绑定的公开访问域名 / CDN。返回给你的图片 URL = 前缀 + /gen/&lt;uuid&gt;.png
                            </p>
                        </div>

                        {/* 测试 + 保存 */}
                        <div className="flex items-center gap-3 flex-wrap">
                            <Button
                                onClick={handleTest}
                                disabled={!fieldsComplete || test.state === 'testing'}
                                variant="secondary"
                            >
                                {test.state === 'testing' ? '测试中…' : '测试连接'}
                            </Button>
                            <Button onClick={handleSave} disabled={test.state !== 'ok' || save === 'saving'}>
                                {save === 'saving' ? '保存中…' : '保存配置'}
                            </Button>
                            {test.state === 'ok' && (
                                <span className="text-sm text-green-700">✅ 连接成功,可以保存</span>
                            )}
                            {test.state === 'fail' && (
                                <span className="text-sm text-red-600">❌ 连接失败:{test.message}</span>
                            )}
                            {save === 'saved' && <span className="text-sm text-green-700">已保存,立即生效</span>}
                            {save === 'error' && saveErr && (
                                <span className="text-sm text-red-600">保存失败:{saveErr}</span>
                            )}
                        </div>

                        <p className="text-xs text-minor-ink">
                            凭证使用 AES-256-GCM 加密存储,不会回显。建议使用
                            <strong>仅对该 bucket 有读写权限的子账号</strong>
                            (最小权限),不要用主账号 AK。上传失败时自动回退到平台默认存储(响应头
                            <code className="mx-1 font-mono">X-Silkroadai-Oss-Fallback</code>标记),不影响生图。
                        </p>
                    </div>
                )}
            </CardContent>
        </Card>
    );
}
