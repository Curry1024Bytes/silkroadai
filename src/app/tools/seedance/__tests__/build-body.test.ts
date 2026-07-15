/**
 * Seedance 测试工具 buildBody —— 国内企业级(cn)档字段约定回归。
 * 修复背景:客户选 -ref 模型 + 图生,但请求体没带图 → 适配器 400「requires a reference」。
 * 根因是 state/竞态(见 generate 改为实时重建),这里锁住 buildBody 对 cn 档各玩法的字段映射。
 */
import { describe, expect, it } from 'vitest';
import { buildBody } from '../seedance-tool';

const IMG = 'data:image/png;base64,aGVsbG8=';

describe('buildBody · 国内企业级(cn)', () => {
    it('图生:-ref 模型 → image 字段带上参考图', () => {
        const b = buildBody('seedance2.0-pro-720p-ref', 'image', 'p', '5', '9:16', [IMG], '');
        expect(b.model).toBe('seedance2.0-pro-720p-ref');
        expect(b.image).toBe(IMG);
        expect(b.duration).toBe(5);
        expect(b.aspect_ratio).toBe('9:16');
    });

    it('图生:选了无 -ref 名 → 自动补 -ref', () => {
        const b = buildBody('seedance2.0-pro-720p', 'image', 'p', '5', '16:9', [IMG], '');
        expect(b.model).toBe('seedance2.0-pro-720p-ref');
        expect(b.image).toBe(IMG);
    });

    it('多图:images 数组', () => {
        const b = buildBody('seedance2.0-pro-720p-ref', 'multi', 'p', '5', '16:9', [IMG, IMG], '');
        expect(b.images).toEqual([IMG, IMG]);
    });

    it('首尾帧:first_frame / last_frame', () => {
        const b = buildBody('seedance2.0-pro-1080p-ref', 'frames', 'p', '5', '16:9', ['a', 'b'], '');
        expect(b.first_frame).toBe('a');
        expect(b.last_frame).toBe('b');
    });

    it('参考音频:image + audio_url', () => {
        const b = buildBody('seedance2.0-pro-720p-ref', 'audio', 'p', '5', '16:9', [IMG], 'data:audio/mp3;base64,QQ==');
        expect(b.image).toBe(IMG);
        expect(b.audio_url).toBe('data:audio/mp3;base64,QQ==');
    });

    it('文生:纯文字,不带媒体字段', () => {
        const b = buildBody('seedance2.0-pro-2k', 'text', 'p', '10', '16:9', [], '');
        expect(b.image).toBeUndefined();
        expect(b.images).toBeUndefined();
        expect(b.duration).toBe(10);
    });
});
