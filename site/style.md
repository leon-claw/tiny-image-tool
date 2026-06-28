# Tiny Image Tool Homepage Style

This design specification is extracted from the current Tiny Image Tool desktop app and adapted for a standalone promotional homepage.

## Design Character

The product should feel like a compact desktop workbench: practical, local, precise, and calm. The page should sell confidence through visible workflow detail rather than abstract spectacle.

## Palette

- Ink: `#151a18` for primary copy and structural lines.
- Muted ink: `#66736d` for secondary text.
- Paper: `#eef2ee` for the page base.
- Strong paper: `#e5ebe6` for side panels and subdued bands.
- Surface: `#fbfcfa` for cards, nav, and tool panels.
- Surface 2: `#f4f7f4` for table heads and inset areas.
- Line: `#ccd7d0` for standard borders.
- Strong line: `#9eaea5` for hover and product mockup outlines.
- Rail: `#101715` for primary dark actions and visual anchors.
- Accent green: `#24765a` for active states, progress, and primary highlights.
- Amber: `#8b6b2c` for usage/caution accents.
- Blue: `#315f92` for file and provider hints.
- Danger: `#a8422b` for destructive or warning states.

## Typography

Use `"Avenir Next", "Noto Sans SC", "SF Pro Text", "Segoe UI", ui-sans-serif, system-ui, sans-serif`. Headings are compact and heavy. Labels are small, uppercase, and high weight. Metrics can use `"DIN Alternate"` as a first choice when available.

Do not scale font sizes directly with viewport width. Use fixed responsive steps and clamp only where a hero headline needs a controlled range.

## Geometry And Spacing

Use `7px` radius for buttons and inputs, `8px` radius for cards, panels, and product mockups. Keep spacing dense and deliberate. Prefer 10-18px internal panel spacing, 8-12px gaps in toolbars, and larger 56-88px section spacing for the public page.

## Texture

The app uses a quiet paper background with subtle grid lines. Reuse the `28px` grid cadence on the homepage hero and major background surfaces:

```css
linear-gradient(90deg, rgba(16, 23, 21, 0.035) 1px, transparent 1px),
linear-gradient(180deg, #f7f9f6 0%, #eef2ee 100%)
```

## Components

- Buttons are compact, icon-capable, 13px, bold, and 34-38px tall.
- Primary actions use `#101715` or `#24765a`, depending on context.
- Cards are individual repeated items only; do not nest cards inside cards.
- Product visuals should resemble the app: left navigation rail, file queue, metric strip, and settings pane.
- Use lucide-style outline icons for workflow, formats, provider, key, folder, and compression concepts.
- Status chips may use pill shapes; avoid pill-heavy layouts elsewhere.

## Homepage Rules

The first viewport must show the product name, desktop compression purpose, download intent, and a workbench-like product signal. The page should be quiet and utilitarian, not a generic SaaS landing page. Avoid decorative orbs, broad purple/blue gradients, cream/beige themes, oversized marketing cards, and abstract SVG illustrations.
