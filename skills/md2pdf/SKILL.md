---
name: md2pdf
description: Format and style Markdown files destined for Max's custom md2pdf CLI (markdown -> HTML -> headless Chrome -> PDF). Load when writing or editing any .md that will be converted to PDF with md2pdf, especially when controlling spacing, layout, page breaks, fonts, or page margins, or when the rendered output looks wrong. Covers goldmark hard-wrap behavior, the enabled raw-HTML/<style> passthrough for per-document CSS overrides, the default stylesheet values you are overriding, print-vs-screen differences, and CLI gotchas (no-overwrite "(01)" naming, auto-open). For generating report CONTENT, also see the pdf-reports skill.
---

## What md2pdf is

A custom Go CLI by Max. It renders a single Markdown file to a styled PDF.

- **Binary:** `~/.local/bin/md2pdf`
- **Source:** `/Users/max/Projects_personal/md2pdf`
- **Pipeline:** Markdown -> HTML (goldmark) -> headless Chrome (chromedp) print-to-PDF
- **Usage:** `md2pdf <input.md>` (auto-opens the PDF; add `--open=false` to suppress)

## Rendering behavior you MUST account for

1. **Hard wraps are ON** (`html.WithHardWraps()`). A single newline becomes `<br>`, NOT a joined line.
   - Consecutive non-blank lines = ONE `<p>` with `<br>` separators (e.g. an address block stays multi-line).
   - A blank line starts a NEW `<p>`.
   - So: lines within a block are controlled by `line-height`; gaps between blocks are controlled by `p` margins. These are two independent levers.
2. **Raw HTML / `<style>` passthrough is ON** (`html.WithUnsafe()`). You can embed raw HTML and a `<style>` block directly in the `.md`. (This was deliberately enabled so individual documents can override the default styling without touching the global CSS.)
3. **GFM** is enabled (tables, task lists, strikethrough, autolinks) plus chroma syntax highlighting (github theme, CSS classes).
4. Content is wrapped in `<main class="markdown-body">...</main>`. Target `.markdown-body` (and descendants) in your CSS.

## The override technique (primary use of this skill)

Put a `<style>` block at the top of the `.md`. CSS is page-global but, since each render is one document, it effectively scopes to that file. **Never edit the global `internal/assets/*.css` to fix one document** — that changes every report.

```markdown
<style>
.markdown-body { line-height: 1.3; }        /* spacing WITHIN a block (<br> lines) */
.markdown-body p { margin: 0 0 1.85rem; }    /* spacing BETWEEN sections/paragraphs */
</style>

First line of the document...
```

Add custom spacer/layout elements with raw HTML + a matching rule, e.g. a signature gap:

```markdown
Sincerely,

<div class="sig-space"></div>

Jane Doe
```
```css
.markdown-body .sig-space { height: 0.55in; }
```

Force a page break anywhere:
```markdown
<div style="break-after: page;"></div>
```

## Default styling you are overriding

From `internal/assets/markdown.css` + `print.css`:

- Base: `html { font-size: 15px }` so **1rem = 15px**.
- Body: `font-family: Georgia, "Times New Roman", serif; line-height: 1.6;`
- Headings: Avenir Next / sans-serif, `line-height: 1.2`, `margin: 1.25em 0 0.55em`.
- `p, ul, ol, blockquote, table, pre { margin: 0 0 1rem; }`
- `.markdown-body` screen padding `0.5in 0.65in 0.7in`; in print, padding/max-width are reset.
- **Print (the PDF):** `@page { size: Letter; margin: 0.6in 0.7in; }`, **white background** (the cream paper + gradient are screen-only), headings `break-after: avoid`, `pre/blockquote/table/img { break-inside: avoid }`, code lines wrap.
- `code`: Courier New at an integer `13px` (deliberate — keeps PDF copy-paste intact; do not naively change to em sizes).

Default `line-height: 1.6` reads as ~1.5 line spacing — good for reports, too loose for letters. Drop to ~1.3 for letters/dense docs.

## Recipes

**Business letter** (tight lines, clear gaps between sender/recipient/Re/body blocks, signature room):
```markdown
<style>
.markdown-body { line-height: 1.3; }
.markdown-body p { margin: 0 0 1.85rem; }
.markdown-body .sig-space { height: 0.55in; }
</style>
```

**Tune spacing:** lower `line-height` to tighten lines inside blocks; raise/lower `.markdown-body p` margin to change the gap between sections. ~1.5rem = comfortable, ~1.85rem = airy.

## CLI gotchas

- **No overwrite.** If `name.pdf` already exists, md2pdf writes `name (01).pdf` instead of replacing it. For a clean filename, `rm -f name.pdf` before running.
- **Auto-opens** the PDF every run; while iterating, use `--open=false` to avoid stacking Preview windows.
- A `.md` carrying a `<style>` block is md2pdf-specific — other Markdown renderers may strip it or render it as text.

## Rebuilding the tool (only if you change its source)

```bash
cd /Users/max/Projects_personal/md2pdf
go test ./...
go build -o ~/.local/bin/md2pdf ./cmd/md2pdf
```
Key files: `internal/markdown/render.go` (goldmark options), `internal/assets/{markdown,print,highlight}.css` (global styles), `internal/assets/template.html` (page shell).
