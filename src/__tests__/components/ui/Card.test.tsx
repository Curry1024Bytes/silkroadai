/**
 * Card + slots — SSR smoke.
 *
 * Variants + the slot composition (Header / Title / Content / Footer) are
 * what the migrating pages will lean on most heavily. Tests focus on
 * shape / structure, not pixels.
 */
import { describe, expect, it } from 'vitest';
import { renderToString } from 'react-dom/server';
import {
    Card,
    CardContent,
    CardFooter,
    CardHeader,
    CardTitle,
} from '@/components/ui/Card';

describe('<Card />', () => {
    it.each([
        ['default', 'bg-surface'],
        ['muted', 'bg-paper-muted'],
        ['inset', 'bg-transparent'],
    ] as const)('variant=%s renders with hallmark class (%s)', (variant, hallmark) => {
        const html = renderToString(<Card variant={variant}>x</Card>);
        expect(html).toContain(hallmark);
    });

    it('default variant has the warm shadow + brand-border', () => {
        const html = renderToString(<Card>x</Card>);
        expect(html).toContain('shadow-card');
        expect(html).toContain('border-brand-border');
        expect(html).toContain('rounded-xl');
    });

    it('inset variant has no border + no shadow + no padding (flush)', () => {
        const html = renderToString(<Card variant="inset">x</Card>);
        expect(html).toContain('border-0');
        expect(html).not.toContain('shadow-card');
    });

    it('renders as a <div> by default but switches with `as`', () => {
        const div = renderToString(<Card>x</Card>);
        expect(div).toMatch(/^<div/);
        const article = renderToString(<Card as="article">x</Card>);
        expect(article).toMatch(/^<article/);
    });

    it('passes data-* attrs and id through to the wrapper', () => {
        const html = renderToString(
            <Card id="mycard" data-test="card-root">
                x
            </Card>,
        );
        expect(html).toContain('id="mycard"');
        expect(html).toContain('data-test="card-root"');
    });
});

describe('Card slots — composition', () => {
    it('renders all four slots in the right order', () => {
        const html = renderToString(
            <Card>
                <CardHeader>
                    <CardTitle>余额</CardTitle>
                </CardHeader>
                <CardContent>¥10.00</CardContent>
                <CardFooter>
                    <span>更新于 1 分钟前</span>
                </CardFooter>
            </Card>,
        );
        // Slots present
        expect(html).toContain('余额');
        expect(html).toContain('¥10.00');
        expect(html).toContain('更新于');
        // Order: Header < Content < Footer
        const idxHeader = html.indexOf('余额');
        const idxBody = html.indexOf('¥10.00');
        const idxFooter = html.indexOf('更新于');
        expect(idxHeader).toBeLessThan(idxBody);
        expect(idxBody).toBeLessThan(idxFooter);
    });

    it('CardTitle defaults to <h2> but can be h1/h3/h4', () => {
        const h2 = renderToString(<CardTitle>x</CardTitle>);
        expect(h2).toMatch(/^<h2/);
        const h3 = renderToString(<CardTitle as="h3">x</CardTitle>);
        expect(h3).toMatch(/^<h3/);
    });

    it('CardFooter has a top border separator (visual divider from content)', () => {
        const html = renderToString(<CardFooter>x</CardFooter>);
        expect(html).toContain('border-t');
        expect(html).toContain('border-brand-border');
    });
});
