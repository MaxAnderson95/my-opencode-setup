---
name: html-reports
description: Write self-contained HTML reports and artifacts in the user's AgentDrop "Ink Ledger" design system, including status and incident reports, implementation plans, PR reviews, code and research explainers, slide decks, design explorations, and small interactive editors. Use when the user asks for an HTML report, artifact, page, or writeup, or when a rich readable document would serve better than markdown.
---

# HTML Reports

Produce a single self-contained `.html` file, upload it to AgentDrop as a Draft for the user to review,
and revise that Draft until the user says to publish.

**The layout, structure, sections, and composition are yours to design.** There is no template
and no prescribed set of "report shapes" — modern models design well on the fly. Read the real
context, decide what the document should be, and build it. The only fixed constraints are the
visual design system below (palette, type, surfaces, motion) and that **every report must be fully responsive and
genuinely good-looking on a phone** — these are published to a URL and routinely read on mobile,
so mobile is a first-class target, not an afterthought (see
[Responsive](#responsive--mandatory-on-every-report)).

## First step

If Anthropic's `frontend-design` skill
([anthropics/skills: frontend-design](https://github.com/anthropics/skills/tree/main/skills/frontend-design))
is available, load it and apply it. That skill carries the guidance for distinctive, intentional
visual design; this skill supplies the palette and type it must be expressed in. If it is not
installed, first offer to install it for the user from that link before you start the report.

## Review and publish through AgentDrop

The user reviews every report as an AgentDrop Draft, unless they name another destination. Load the
`agentdrop` skill: it owns the upload mechanics (auth, the multipart call, Draft re-uploads,
publishing, multi-file bundles).

1. Write the complete report to a local `.html` file in the current project or working directory.
   It is the source you edit between rounds, so keep it out of temporary directories.
2. Create a report Artifact as a Draft, open its `url` in the user's browser, and give them two links:
   the Artifact `url` (stable; shows them the Draft when signed in, viewers see the last published
   Version) and the Draft URL from `draft.url` (opens the Draft for anyone holding it, off the
   corporate network too).
3. For every requested change, edit the local file, re-upload the Draft to the same Artifact,
   reopen the `url`, and give the user the new `draft.url`: each draft upload rotates it, so the
   previous one 404s. A change is done when the Draft shows it.
4. Publish when the user says to. Later edits to a published report go to the same Artifact as a new
   Draft, so the URL stays stable.

## Design system: AgentDrop v2 "Ink Ledger" (the one hard constraint)

Reports open inside the AgentDrop viewer, framed by its white content sheet beside the navy
provenance rail, so each report should read as another page of the same ledger: navy and paper,
one coral pen mark, Schibsted Grotesk titles, Archivo text, Spline Sans Mono values.

It is a **two-color system (navy + coral) over warm neutrals**, light theme only. There is **no
green/amber/red and no dark mode** (the Dashboard has one; the viewer and reports stay light).
Map good/neutral states to navy and problem/exception/action states to coral; use dashed borders
for a third "caveat" distinction if you need one. Color carries meaning, never decoration.

### Color tokens (use these exact values)

```css
:root {
  --navy:          #1c2b4a;  /* ink on paper, and every navy surface */
  --navy-hover:    #24365c;
  --paper:         #f7f6f2;  /* page background */
  --coral:         #e4573d;  /* the only accent: problems, primary action, the current item */
  --coral-hover:   #ee6a50;  /* also any coral TEXT on navy (clears 4.5:1 there) */
  --ink-soft:      rgba(28, 43, 74, 0.75);  /* secondary prose on white sheets */
  --muted-ink:     #8a94a8;  /* labels, meta, axis text; under 3:1 on white, so never sentences */
  --muted:         #a9b2c3;  /* secondary text on navy */
  --onfill:        #f7f6f2;  /* text on navy and coral fills */
  --sheet:         #ffffff;
  --sheet-edge:    #e3dfd5;  /* sheet and control hairline */
  --hairline:      #d9d6cc;  /* dotted row separators */
  --code:          #f2f0e9;  /* code chips, quiet inset panels */
  --coral-wash:    rgba(228, 87, 61, 0.14);
  --coral-edge:    rgba(228, 87, 61, 0.45);
  --ink-edge:      rgba(28, 43, 74, 0.3);    /* outlined button border */
  --ink-edge-soft: rgba(28, 43, 74, 0.25);   /* neutral badge border */
  --row-hover:     rgba(28, 43, 74, 0.02);
  --onfill-rule:   rgba(247, 246, 242, 0.18); /* dotted rules on navy */
  --onfill-edge:   rgba(247, 246, 242, 0.3);  /* outlined controls on navy */
  --shadow-sheet:  0 4px 20px rgba(28, 43, 74, 0.1);
  --shadow-modal:  0 18px 50px rgba(28, 43, 74, 0.28);
  --radius: 3px;
}
```

### Typography (load via Google Fonts)

```html
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Schibsted+Grotesk:wght@400..900&family=Archivo:wght@400..700&family=Spline+Sans+Mono:wght@400..600&display=swap">
```

```css
--display: "Schibsted Grotesk", "Archivo", -apple-system, BlinkMacSystemFont, sans-serif;
--body:    "Archivo", -apple-system, BlinkMacSystemFont, sans-serif;
--mono:    "Spline Sans Mono", ui-monospace, monospace;
```

The variable-weight ranges in the URL are what make the 550 heading weight render; a static
`wght@400;500;600` list would round it.

| Role | Setting | Use |
|---|---|---|
| Display | Schibsted Grotesk 550, 2rem / 1.12, `letter-spacing: -0.02em` | the page title (about 1.6rem on phones), `text-wrap: balance` |
| Title | Schibsted Grotesk 550, 1.15rem / 1.2, `-0.015em` | sheet and section headings |
| Body | Archivo 400, 14 to 15.5px / 1.55 | prose; ledes and secondary prose in `--ink-soft` |
| Label | Archivo 600, 10px, `0.12em` tracking, uppercase, `--muted-ink` | table heads, stat captions, ledger and field labels |
| Mono | Spline Sans Mono 500, about 12.5px | numbers, IDs, hosts, timestamps, datelines, chart text, the footer |

Every heading is Schibsted Grotesk, upright, at 550 with negative tracking. **No serif and no
italic anywhere**, including pull-quotes; emphasis inside prose is Archivo 600.

### Surfaces and texture

- **Paper page, white sheets.** A sheet is white with a 1px `--sheet-edge` border, 3px radius,
  `--shadow-sheet`, and about 1.25rem by 1.5rem padding. One sheet holds one titled section: a
  baseline-aligned title row with an optional right-aligned mono note, then content. Stack sheets
  18px apart in a centered column about 60rem wide. Keep `body` on paper; the viewer lays the
  report on its own mat, so leave its navy rail to the viewer and build no competing left rail.
- **Woven linen on navy.** Every navy surface in AgentDrop v2 (sidebar, viewer rail, sign-in
  panel, tour band) carries a fine crosshatch, like a cloth ledger cover. Give a report at most one
  navy surface, for the part that should read as the binding (a verdict or status panel, a
  masthead band), and texture it the same way:

  ```css
  .navy { position: relative; isolation: isolate; background: var(--navy); color: var(--onfill); }
  .navy::before {
    content: ""; position: absolute; inset: 0; z-index: -1; pointer-events: none;
    background-image:
      repeating-linear-gradient(0deg, rgb(247 246 242 / 0.03) 0 1px, transparent 1px 3px),
      repeating-linear-gradient(90deg, rgb(0 0 0 / 0.072) 0 1px, transparent 1px 3px);
  }
  ```

  On navy, secondary text is `--muted`, coral text is `--coral-hover`, and rules are dotted
  `--onfill-rule`.
- **Ledger lines.** Separators are 1px hairlines, dotted for rows. Radii are 3px everywhere
  except pills (999px) and tags (2px).
- **Coral pen marks.** The `agentdrop.` wordmark (mono, `letter-spacing: 0.08em`, a coral
  bold trailing period) is the model: a coral trailing period on a headline set on navy, a 3px
  coral rule on the one sheet that matters, the coral node on the current step. One or two per
  report.

### Components to borrow from the product

- **Stat tile:** a sheet with a Label caption (tracking 0.14em) over a mono 1.9rem
  `tabular-nums` figure; flex column with `justify-content: space-between` so figures share a
  baseline when a caption wraps. A unit goes in a half-size muted `<small>`.
- **Ledger:** the viewer rail's facts list. Rows are a `label-width minmax(0,1fr)` grid with
  dotted separators, Label-style keys, and values in mono or body text. Works on paper and navy;
  collapse to one column on phones.
- **Badge:** pill, Archivo 600 9.5px uppercase, `0.1em` tracking, 1px `--ink-edge-soft` border.
  The attention variant is `--coral-wash` fill, `--coral-edge` border, coral text.
- **Tag:** a label-maker chip for names (services, repos, hosts): 19px tall, 2px radius,
  `color-mix(in srgb, var(--navy) 72%, #fff)` fill, white Archivo 500 11px, lowercase as written.
- **Table:** Label-style `th` over a 1px `--sheet-edge` rule; `td` with a dotted `--hairline`
  bottom border, 14 to 18px vertical padding, `--row-hover` on hover; figures in mono
  `tabular-nums`.
- **Timeline:** the viewer's Version index. A 1px vertical rule with 9px round nodes; the current
  or failing node fills coral. Use it only for content that is a real sequence.
- **Inline code:** `--code` fill, 1px `--sheet-edge` border, 3px radius, mono 0.82rem.
- **Links:** ink text with a transparent bottom border that turns coral, with the text, on hover.
- **Buttons:** Archivo 600 13px, 3px radius. Primary is a coral fill with `--onfill` text
  (hover `--coral-hover`); secondary is transparent with an `--ink-edge` border that darkens to
  navy on hover.
- **Focus ring:** `outline: 2px solid var(--coral); outline-offset: 2px`.

### Motion

AgentDrop v2 moves with one vocabulary; reuse its curves and timings so a report feels like the
product. Put every animation inside `@media (prefers-reduced-motion: no-preference)` and keep JS
motion behind a `matchMedia('(prefers-reduced-motion: reduce)')` check.

```css
--ease-out: cubic-bezier(0.22, 1, 0.36, 1);   /* entrances, slides, reveals */
--ease-pop: cubic-bezier(0.34, 1.56, 0.64, 1); /* small overshoot: a mark, a chip, a pulse */
@keyframes page-in { from { opacity: 0; transform: translateY(-14px); } 40% { opacity: 1; } }
@keyframes rise-in { from { opacity: 0; transform: translateY(6px); } }
```

- **Header on load:** the header drops in with `page-in` over 300ms `--ease-out`.
- **Sheets on scroll, once:** each top-level sheet rises in with `rise-in` over about 420ms
  `--ease-out` when it first scrolls into view, and its charts and figures animate at that
  moment. Each sheet animates once per page load: re-scrolling leaves it still.
- **Figures** count up from zero over 800ms with a cubic ease-out (`1 - (1 - t) ** 3`) in a
  `requestAnimationFrame` loop, started when their sheet reveals.
- **Charts** draw their coral mark last: a pop over 460ms `--ease-pop`, a line revealed with
  a `clip-path: inset(0 100% 0 0)` to `inset(0)` animation over about 900ms, or bars growing
  with `scaleY(0)` to `none` from `transform-origin: bottom` over about 700ms.
- **Responses to the reader:** exits and collapses fade over 110ms ease-in; panels slide over
  350ms `cubic-bezier(0.7, 0, 0.2, 1)`; icons nudge 1.5 to 2px on hover over 180ms; a trailing
  coral period may drop in from 9px above over 760ms after 280ms.

The whole budget is the header load, the once-per-sheet scroll reveal, and motion that answers
the reader. Animation never loops.

**Wire the scroll reveal this way** so content is never stuck hidden:

1. A tiny script in `<head>` adds `reveal-on` to `<html>` only when
   `matchMedia('(prefers-reduced-motion: no-preference)')` matches and `IntersectionObserver`
   exists, so sheets are hidden before first paint and never flash.
2. All hiding CSS is scoped under `.reveal-on` inside the `no-preference` media query: sheets
   start at `opacity: 0`, chart lines at the hidden `clip-path`, bars at `scaleY(0)`. Adding
   `.in` to a sheet sets the visible end state and runs its animations.
3. One `IntersectionObserver` (`rootMargin: '0px 0px -10% 0px'`, `threshold: 0.08`) watches the
   sheets. On the first callback where a sheet intersects, add `.in`, start its count-ups, and
   `unobserve` it. A sheet whose `boundingClientRect.bottom <= 0` (already scrolled past, as
   after a reload mid-page) gets `.in` plus `.seen`, where `.seen` sets `animation: none`, so
   it appears without animating offscreen.
4. With reduced motion or no `IntersectionObserver`, `reveal-on` is never set and everything
   renders visible and still.

## Technical requirements

- **Prefer one self-contained file**: keep the primary HTML, CSS, JS, and SVG inline in a single
  document, no build step and no CDN scripts. The Google Fonts `<link>` above is the only external
  dependency the primary file should reach for. (When a report genuinely needs companion assets,
  AgentDrop can serve them as a bundle — see [Multi-file reports](#multi-file-reports).)
- **Real data** from the actual context (git log, code, tickets, conversation) — never lorem
  ipsum. If any data is illustrative/fictional, say so in the footer.
- **Draw, don't describe**: inline SVG for charts, timelines, and diagrams. No ASCII art, no
  external images.
- **`<head>` musts**: a proper `<title>`, `<meta name="robots" content="noindex, nofollow">`,
  and `<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">`
  plus `<meta name="theme-color" content="#f7f6f2">`.
- **Footer**: a mono footer with sources and a generated timestamp.
- **Link every PR reference** to the PR on GitHub, wherever it appears: prose, tables, timeline,
  follow-ups, footer.
- **Link Dash0 evidence into Dash0**: every trace ID, span ID, and log record drawn from Dash0
  links to the matching Dash0 view, built with the Dash0 MCP's `generateDash0Url` and bounded by
  a time range. Leave metric charts unlinked: Dash0 query-builder links open from an AgentDrop
  report in a sandboxed tab (no `allow-popups-to-escape-sandbox`), where Dash0 drops the query
  and shows an empty builder, even though the same URL works when pasted into a browser.
- **External links open a new tab**: give every `http(s)` link `target="_blank"
  rel="noopener noreferrer"`. AgentDrop renders the report in a sandboxed iframe, so a plain link
  navigates the frame itself, and sites such as GitHub refuse to load inside a frame. In-page
  `#anchor` links stay as they are.

## Responsive — mandatory on every report

Reports are read on phones. Every report must be **mobile-native on a phone and unchanged on
desktop** — not a shrunk desktop with sideways scrolling. Collapse the desktop layout to mobile
with media queries. Data tables become stacked cards (inject column labels from `<thead>` with a
tiny inline script) rather than horizontal scroll strips. A chart whose right side carries data
gets a second, narrow SVG (about a 340-unit viewBox, tighter axis range) swapped in by the media
query, because a scrolled chart hides its ending; other wide one-offs (code, diagrams) sit in
`overflow-x:auto` wrappers.

Three hard-won correctness rules (each fixed a real bug):

- **Put all mobile `@media` blocks at the END of the stylesheet** — a later base rule of equal
  specificity silently wins inside a media query.
- **Grid tracks holding arbitrary content are `minmax(0,1fr)`, never bare `1fr`** — `1fr`'s auto
  minimum lets a wide child blow the layout past the viewport.
- **`section[id] { scroll-margin-top: ... }`** so anchor jumps clear any sticky/fixed bar.

Only if the user reports a rendering problem, run a Playwright QA pass, and only if Playwright is
already available. Check first without installing anything (for example
`npx --no-install playwright --version`). If it is available, verify against installed Chrome
(`npx --no-install playwright screenshot --browser=chromium --channel=chrome --viewport-size=390,844 "file://<path>" out.png`)
at 390 / 800 / 1280px. `chrome --headless --screenshot` lies about narrow widths on macOS.
If Playwright is not available, skip the QA pass and carry on with the rest of the workflow. You
may mention to the user afterward that Playwright wasn't found, so no QA pass was run, but do not
offer to install it.

## Interactivity

Vanilla JS only, inline `<script>`, no frameworks. Good uses: tabs, collapsible `<details>`,
copy-to-clipboard, sliders, drag-to-reorder. Any interactive editor must export its state back to
text (markdown in a `<textarea>` or clipboard) so a human can paste it back into the loop.

## Multi-file reports

AgentDrop can serve a **multi-file artifact** as a small static site (an `index.html` entry
document plus companion files). So when a report genuinely needs separate assets — images, a large
third-party JS library, a standalone stylesheet, or downloadable raw data — you can ship them
alongside `index.html` instead of inlining everything; see the `agentdrop` skill for the mechanics.
Still prefer a single self-contained `index.html` by default.
