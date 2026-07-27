# LLmRoute Brand System

## Brand Core

- Name: `LLmRoute`
- Domain: `llmroute.club`
- Tagline: `One route. Every model.`
- Chinese positioning: `一个入口，连接每个模型。`
- Product category: AI API gateway and model-routing platform for developers and teams

LLmRoute should feel precise, dependable, and operational. It is infrastructure customers use repeatedly, not an entertainment product. Interfaces stay quiet and information-dense; the brand appears through typography, routed-circuit geometry, neutral materials, and restrained navy-and-ivory contrast.

## Logo Concept

The official mark is a nested routed-circuit symbol supplied in the 1024px brand master:

- Three interlocking rounded routes represent aggregation, orchestration, and delivery
- Two terminal nodes make the routing metaphor explicit without adding decorative detail
- The `LLmRoute` wordmark is part of the supplied artwork; the lowercase `m` is intentional and must retain this casing
- The canonical light-surface expression is a transparent plated-metal
  gradient: antique-gold shadow, champagne midtone, and narrow platinum
  highlights. The alternating bands create reflected depth without turning the
  lockup into a flat yellow or bronze shape.
- The dark-surface inverse preserves the supplied cool silver and metallic
  ivory treatment.

Do not redraw the routes, substitute the wordmark with live text, alter the terminal nodes, or invent additional gradients. Never render the full lockup as solid yellow gold and never add a dark plate solely behind the logo. On light interfaces, the transparent plated-gold lockup sits directly on the same surface as the surrounding header.

## Palette

| Role           | Token               | Value     | Usage                                   |
| -------------- | ------------------- | --------- | --------------------------------------- |
| Deep navy      | `route-navy`        | `#0E1A2A` | Primary actions and dark brand surfaces |
| Navy strong    | `route-navy-strong` | `#08111E` | Hover and pressed states                |
| Metallic ivory | `route-metal`       | `#D8CFB7` | Brand detail on dark surfaces           |
| Ivory light    | `route-metal-light` | `#F3EEDC` | Reversed monochrome artwork             |
| Gilded shadow  | `route-gold-shadow` | `#655A42` | Plated-logo depth on light surfaces     |
| Gilded midtone | `route-gold-mid`    | `#AA8D55` | Plated-logo champagne reflection        |
| Gilded shine   | `route-gold-shine`  | `#FFF9EA` | Narrow plated-logo highlight only       |
| Ink            | `route-ink`         | `#1D1D1F` | Primary text                            |
| Canvas         | `route-canvas`      | `#F5F5F7` | Customer-console background             |
| Surface        | `route-surface`     | `#FFFFFF` | Panels and controls                     |
| Border         | `route-border`      | `#D9D9DE` | Dividers and controls                   |

Deep navy is the accessible interaction color. Metallic ivory is a brand material, not a general UI accent; do not use it for small text or low-contrast controls. Neutral surfaces carry the product hierarchy.

## Typography

- Display and product headings: Manrope
- UI and body: Inter with the native system stack as fallback
- Code and identifiers: system monospace stack
- Wordmark: supplied `LLmRoute` artwork, never reconstructed with a font
- Letter spacing: `0`; do not tighten headings or the wordmark

## Interface Direction

- Apple-inspired precision, not visual imitation: neutral canvas, white surfaces, thin separators, restrained depth
- Card radius: 8px; control radius: 8px; avoid decorative pills and nested cards
- One primary deep-navy action per task surface
- Use Lucide outline icons at consistent 1.7-1.8px stroke width
- Motion stays between 150-250ms and is disabled by `prefers-reduced-motion`
- Dashboard content remains dense and scannable; public/auth surfaces use more whitespace

## Logo Files

- `llmroute-master.png`: immutable 1024px source artwork supplied by the brand owner
- `logo-primary.svg`: plated-gold lockup for light public surfaces
- `logo-primary-flat.svg`: compact plated-gold lockup for light UI surfaces and the customer console
- `logo-inverse.svg`: canonical silver-metallic lockup with a faint champagne reflection for dark backgrounds
- `logo-mono-dark.svg`: single-color print/export lockup
- `logo-mono-light.svg`: single-color reverse lockup
- `mark-only.svg`: favicon, avatar, and icon-only placement

Maintain clear space equal to one terminal-node diameter around the mark. Never stretch, rotate, or recolor individual routes. The SVG delivery files contain alpha-matted derivatives of the supplied master so the exact geometry remains stable across platforms.

## Domain Plan

- Public site and customer portal: `https://llmroute.club`
- Customer API: `https://api.llmroute.club`
- Generated assets: `https://images.llmroute.club`
- Support email: `support@llmroute.club`

DNS, TLS, Caddy routing, OAuth callbacks, payment callbacks, and R2 custom-domain binding must be deployed together before these production URLs replace live infrastructure.

## Compatibility

The legacy `X-Silkroadai-*` response headers and `silkroadai` JSON metadata namespace are customer-facing API contracts. Keep them during the visual rebrand. A future versioned migration may add `X-LLmRoute-*` and `llmroute` aliases before deprecating legacy names.
