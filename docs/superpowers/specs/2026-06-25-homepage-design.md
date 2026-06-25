# Tiny Image Tool Homepage Design

Date: 2026-06-25

## Context

Tiny Image Tool is a Tauri, React, and TypeScript desktop app for batch image compression on macOS and Windows. The current app supports local files and folders, watched folders, Compresto and Tinify providers, JPG/JPEG/PNG/WebP/AVIF inputs, local API key configuration, and output modes for subdirectory, custom folder, or overwrite.

The requested work is a standalone promotional homepage built with Next.js SSG. It must be independent from the desktop app and support separate deployment. All editable marketing copy and homepage content should live in one `content.mdx` file.

## Approved Direction

Use Direction A, "Product Workbench".

The homepage should feel like a polished public-facing version of the app itself: practical, calm, compact, and trustworthy. It should not feel like a generic SaaS hero page or a dramatic campaign page. The first screen should immediately communicate the product name, desktop image compression use case, download intent, and the app's workflow through a realistic product mockup.

## Style Extraction Target

Create `style.md` from the current app UI and use it as the design source for the homepage.

Core style rules:

- Palette: paper-gray and soft green base with deep ink text. Use `#151a18`, `#66736d`, `#eef2ee`, `#e5ebe6`, `#fbfcfa`, `#ccd7d0`, `#101715`, `#24765a`, `#8b6b2c`, `#315f92`, and `#a8422b` as the extracted color family.
- Typography: system sans stack led by Avenir Next and Noto Sans SC. Use strong compact headings, small uppercase labels, and DIN-like numeric styling where metrics appear.
- Shape: 7-8px radii for controls, cards, panels, and product mockups. Avoid large pill-heavy or overly rounded marketing components except for small status chips.
- Texture: light paper background with subtle 28px grid lines. Surfaces should be off-white with quiet borders and soft shadows.
- Interaction vocabulary: lucide-style outline icons, compact icon+text buttons, segmented/tab controls, small metric cards, dense table/workbench visual language.
- Tone: utilitarian and focused. Avoid decorative gradient blobs, oversized cards, nested cards, and one-note color palettes.

## Homepage Structure

The site should be a single static homepage with content sourced from `content.mdx`.

Sections:

1. Header
   - Product lockup with icon and "Tiny Image Tool".
   - Anchor navigation for features, workflow, providers, and download.
   - Primary compact download button.

2. Hero
   - H1: product/use-case focused, not abstract.
   - Supporting copy: batch compression, folders, watched folders, local provider keys.
   - Primary CTA for download and secondary CTA for workflow.
   - Large product mockup resembling the app workbench: left rail, file queue, settings pane, status/metrics.
   - A hint of the next section should be visible on normal desktop and mobile viewports.

3. Feature Metrics
   - Compact metric strip/cards for formats, providers, batch/folder workflow, and local configuration.

4. Workflow
   - Step-based explanation: add files/folders, choose provider/options, compress, review output.
   - Should read like a workbench process, not a marketing checklist.

5. Watch Folders
   - Highlight automatic folder scanning and skip behavior for already-compressed images.

6. Providers and Output
   - Explain Compresto/Tinify support, API usage visibility, and output policies.

7. Download / Deployment CTA
   - macOS and Windows-oriented download placeholders.
   - Include a concise note that keys are stored locally in app config.

## Architecture

Create a standalone Next.js SSG site under `site/`.

Required structure:

- `site/package.json`
- `site/next.config.mjs`
- `site/tsconfig.json`
- `site/src/app/page.tsx`
- `site/src/app/layout.tsx`
- `site/src/app/globals.css`
- `site/src/content.mdx`
- `site/style.md`
- `site/src/components/*` for focused presentational units

The desktop Tauri app should not import or depend on the site. The site can copy or reference needed visual assets from the app only if they are stable and intentionally part of the marketing surface. A CSS-drawn product mockup is acceptable for the first pass and keeps deployment self-contained.

## Content Flow

`content.mdx` should contain the editable marketing data and MDX copy for the homepage. The page should import that data and render sections from it. Keep structured items such as feature cards, workflow steps, provider notes, and CTA labels in exported objects or arrays inside the MDX file.

All visible marketing text that a non-developer would want to revise later should live in `content.mdx`. Layout components, CSS class names, and purely structural labels can remain in React components.

## Components

Suggested component boundaries:

- `HomeContent`: consumes MDX exports and composes the page.
- `SiteHeader`: logo, nav, CTA.
- `Hero`: headline, copy, CTAs, product mockup.
- `ProductMockup`: static workbench-style visual.
- `MetricStrip`: compact feature/metric cards.
- `WorkflowSteps`: ordered workflow.
- `FeatureBand`: watch folders and provider/output sections.
- `DownloadPanel`: final CTA.

Each component should be presentational and receive plain data from `content.mdx`.

## Error Handling

The site is static, so runtime error handling is minimal.

- If a content array is empty, render nothing for that section rather than placeholder text.
- External download links can be `#` or repository/release placeholders until real release URLs exist.
- Avoid client-only behavior unless necessary. The page should build as static HTML.

## Testing And Verification

Verification should include:

- Build the standalone site with `npm run build` from `site/`.
- Confirm the page is statically generated.
- Run a local Next.js server and inspect the page in the browser.
- Check desktop and mobile viewports for layout, text fit, non-overlap, and visible first-viewport product signal.
- Confirm all editable visible marketing content is in `site/src/content.mdx`.
- Confirm the desktop app still remains independent from the site.

## Open Decisions

No blocker decisions remain. Direction A is approved. Download URLs can remain placeholders unless release links are available in the repo.
