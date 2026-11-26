'use client';

import { useEffect, useRef, useState } from 'react';
import {
    formatBytes,
    formatDuration,
    formatNumber,
    logDate,
    logTime,
    statusFor,
    type LogRow,
} from './request-log-display';
import styles from './request-logs.module.css';

type LogDetail = LogRow & { error?: string | null; retention_expires_at?: string | null };
type BodyPart = 'in' | 'out';
type BodyPreview = { total_bytes: number; truncated: boolean; body: string };

export function RequestStatus({ row }: { row: LogRow }) {
    const { kind, label } = statusFor(row);
    return (
        <span className={styles.status} data-status={kind}>
            {row.status_code ?? ''} {label}
        </span>
    );
}

function BodySection({ id, which, available }: { id: string; which: BodyPart; available: boolean }) {
    const [body, setBody] = useState<BodyPreview>();
    const [error, setError] = useState('');
    const [loading, setLoading] = useState(false);
    const request = useRef<AbortController | null>(null);

    useEffect(() => () => request.current?.abort(), []);

    async function readBody(full = false) {
        if (request.current) return;
        const controller = new AbortController();
        request.current = controller;
        setLoading(true);
        setError('');
        try {
            const res = await fetch(
                '/api/admin/request-logs/' + id + '/body?which=' + which + (full ? '&full=1' : ''),
                {
                    signal: controller.signal,
                    cache: 'no-store',
                },
            );
            if (res.ok) {
                const next: BodyPreview = await res.json();
                if (!controller.signal.aborted) setBody(next);
            } else if (!controller.signal.aborted) {
                setError(
                    res.status === 404
                        ? '原文不存在或已过期。'
                        : res.status === 503
                          ? '暂时无法读取原文，请稍后重试。'
                          : '读取原文失败，请检查登录状态后重试。',
                );
            }
        } catch {
            if (!controller.signal.aborted) setError('读取原文失败，请重试。');
        } finally {
            if (!controller.signal.aborted) {
                request.current = null;
                setLoading(false);
            }
        }
    }

    return (
        <section className={styles.bodySection}>
            <div className={styles.bodyHeader}>
                <h3>{which === 'in' ? '请求原文' : '响应原文'}</h3>
                {available && !body && (
                    <button className={styles.button} type="button" onClick={() => void readBody()} disabled={loading}>
                        {loading ? '读取中…' : '查看原文'}
                    </button>
                )}
            </div>
            {!available && <p className={styles.secondary}>该记录没有保存此原文。</p>}
            {error && (
                <div className={styles.error} role="alert">
                    {error}
                </div>
            )}
            {body && (
                <>
                    <div className={styles.bodyHeader}>
                        <p className={styles.secondary}>
                            {body.truncated ? '预览已截断 · 原文共 ' : ''}
                            {formatBytes(body.total_bytes)}
                        </p>
                        {body.truncated && (
                            <button
                                className={styles.button}
                                type="button"
                                disabled={loading}
                                onClick={() => void readBody(true)}
                            >
                                {loading ? '读取中…' : '读取完整原文'}
                            </button>
                        )}
                    </div>
                    <pre className={styles.code}>{body.body}</pre>
                </>
            )}
        </section>
    );
}

export function RequestLogDetail({ id, onClose }: { id: string; onClose: () => void }) {
    const modal = useRef<HTMLDialogElement>(null);
    const [meta, setMeta] = useState<LogDetail>();
    const [error, setError] = useState('');
    const [retry, setRetry] = useState(0);

    useEffect(() => {
        const dialog = modal.current;
        dialog?.showModal();
        return () => dialog?.close();
    }, []);

    useEffect(() => {
        const controller = new AbortController();
        async function load() {
            try {
                const res = await fetch('/api/admin/request-logs/' + id, {
                    signal: controller.signal,
                    cache: 'no-store',
                });
                if (!res.ok) {
                    if (!controller.signal.aborted)
                        setError(res.status === 404 ? '该记录不存在或已过期。' : '读取请求详情失败，请重试。');
                    return;
                }
                const data: { log: LogDetail } = await res.json();
                if (!controller.signal.aborted) setMeta(data.log);
            } catch {
                if (!controller.signal.aborted) setError('读取请求详情失败，请重试。');
            }
        }
        void load();
        return () => controller.abort();
    }, [id, retry]);

    return (
        <dialog
            ref={modal}
            className={styles.dialog}
            aria-labelledby="request-log-detail-title"
            onCancel={(event) => {
                event.preventDefault();
                onClose();
            }}
        >
            <header className={styles.detailHeader}>
                <div>
                    <h2 id="request-log-detail-title">请求详情</h2>
                    <p className={styles.secondary}>查看原文会记录访问审计。</p>
                </div>
                <button className={styles.button} type="button" onClick={onClose}>
                    关闭
                </button>
            </header>
            <div className={styles.detailContent}>
                {error ? (
                    <div className={styles.error} role="alert">
                        {error}
                        <button
                            className={styles.button}
                            type="button"
                            onClick={() => {
                                setError('');
                                setRetry((value) => value + 1);
                            }}
                        >
                            重试
                        </button>
                    </div>
                ) : !meta ? (
                    <p role="status">正在读取请求详情…</p>
                ) : (
                    <>
                        <section className={styles.detailSummary}>
                            <div className={styles.bodyHeader}>
                                <h3>请求概况</h3>
                                <RequestStatus row={meta} />
                            </div>
                            <div className={styles.fullPath}>
                                <span className={styles.method}>{meta.method}</span>
                                <code>{meta.path}</code>
                            </div>
                            <dl className={styles.metadata}>
                                <div>
                                    <dt>日志 ID</dt>
                                    <dd>
                                        <code>{id}</code>
                                    </dd>
                                </div>
                                <div>
                                    <dt>时间（UTC+8）</dt>
                                    <dd>
                                        {logDate(meta.created_at)} {logTime(meta.created_at)}
                                    </dd>
                                </div>
                                <div>
                                    <dt>用户 UUID</dt>
                                    <dd>
                                        <code>{meta.user_id ?? '—'}</code>
                                    </dd>
                                </div>
                                <div>
                                    <dt>模型</dt>
                                    <dd>{meta.model ?? '—'}</dd>
                                </div>
                                <div>
                                    <dt>输入 / 输出 Token</dt>
                                    <dd>
                                        {formatNumber(meta.input_tokens)} / {formatNumber(meta.output_tokens)}
                                    </dd>
                                </div>
                                <div>
                                    <dt>请求 / 响应大小</dt>
                                    <dd>
                                        {formatBytes(meta.input_bytes)} / {formatBytes(meta.output_bytes)}
                                    </dd>
                                </div>
                                <div>
                                    <dt>耗时</dt>
                                    <dd>{formatDuration(meta.duration_ms)}</dd>
                                </div>
                                <div>
                                    <dt>响应方式</dt>
                                    <dd>{meta.streamed ? '流式' : '非流式'}</dd>
                                </div>
                            </dl>
                            {meta.error && (
                                <div className={styles.error}>
                                    捕获错误
                                    <br />
                                    {meta.error}
                                </div>
                            )}
                        </section>
                        <BodySection id={id} which="in" available={Boolean(meta.input_r2_key)} />
                        <BodySection id={id} which="out" available={Boolean(meta.output_r2_key)} />
                        <details className={styles.bodySection}>
                            <summary>原始元数据</summary>
                            <pre className={styles.code}>{JSON.stringify(meta, null, 2)}</pre>
                        </details>
                    </>
                )}
            </div>
        </dialog>
    );
}
