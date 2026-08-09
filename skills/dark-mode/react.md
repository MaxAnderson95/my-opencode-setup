# React wiring

## The script

It has to reach the document ahead of the bundle, which rules out anything React renders on the client. Keep the step 2 block in a module as a string so it stays a single source of truth:

```ts
// theme.ts
export const THEME_INIT_SCRIPT = `(function(){ /* the step 2 block */ })()`
```

**Next.js, App Router** — inside `<head>` in `app/layout.tsx`. `suppressHydrationWarning` on `<html>` is required, not optional: the script mutates `class`, `data-theme`, and `style` before React hydrates, so the server markup and the live DOM legitimately disagree.

```tsx
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <meta name="color-scheme" content="light dark" />
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />
      </head>
      <body>{children}</body>
    </html>
  )
}
```

Plain `<script dangerouslySetInnerHTML>`, not `next/script`. Every `next/script` strategy except `beforeInteractive` runs too late, and `beforeInteractive` only works in the root layout anyway, so the raw tag is the shorter path to the same place.

**Pages Router** — the same tag inside `<Head>` in `pages/_document.tsx`.

**Vite / CRA / any SPA** — paste the block straight into `index.html`'s `<head>`. Nothing imports it, so the bundler never sees it.

**Remix / React Router** — the tag goes in the root route's document component, above `<Links />`.

## The store

`<html data-theme>` already holds the normalised preference, so read the DOM rather than `localStorage`. That keeps one source of truth, needs no `try`, and picks up every writer for free — this tab, another tab, and the OS flipping while on `system` — through one `MutationObserver`.

```ts
'use client'
import { useCallback, useSyncExternalStore } from 'react'

export type ThemePreference = 'dark' | 'light' | 'system'

/** Press order. Starting on 'system', the first press goes to dark. */
export const NEXT_PREFERENCE: Record<ThemePreference, ThemePreference> = {
  dark: 'light',
  light: 'system',
  system: 'dark',
}

declare global {
  interface Window {
    __theme: { set: (preference: ThemePreference) => void }
  }
}

function subscribe(onStoreChange: () => void): () => void {
  const observer = new MutationObserver(onStoreChange)
  observer.observe(document.documentElement, { attributeFilter: ['data-theme'] })
  return () => observer.disconnect()
}

function getSnapshot(): ThemePreference {
  const value = document.documentElement.dataset.theme
  return value === 'dark' || value === 'light' || value === 'system' ? value : 'system'
}

/** SSR and the first hydration render have no document to ask. */
function getServerSnapshot(): ThemePreference {
  return 'system'
}

export function useTheme() {
  const preference = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot)
  const setPreference = useCallback((next: ThemePreference) => {
    window.__theme.set(next)
  }, [])
  return { preference, setPreference }
}
```

`useSyncExternalStore` rather than `useState` + `useEffect`: the effect version renders once with the wrong answer, and React has no way to know the DOM already holds the right one.

## The control

```tsx
'use client'
import { Monitor, Moon, Sun } from 'lucide-react'
import { NEXT_PREFERENCE, useTheme, type ThemePreference } from './theme'

/* Labels read inside a sentence, so they stay lowercase here. */
const APPEARANCE: Record<ThemePreference, { label: string; Icon: typeof Moon }> = {
  dark: { label: 'dark', Icon: Moon },
  light: { label: 'light', Icon: Sun },
  system: { label: 'system default', Icon: Monitor },
}

export function ThemeToggle() {
  const { preference, setPreference } = useTheme()
  const { Icon } = APPEARANCE[preference]
  const next = NEXT_PREFERENCE[preference]

  return (
    <button
      type="button"
      onClick={() => setPreference(next)}
      title={`Switch to ${APPEARANCE[next].label}`}
      aria-label={`Appearance: ${APPEARANCE[preference].label}. Switch to ${APPEARANCE[next].label}.`}
    >
      {/* Keyed so the glyph remounts and its animation restarts; without it
          React swaps the path in place and nothing moves. */}
      <Icon key={preference} aria-hidden strokeWidth={1.75} />
    </button>
  )
}
```

This renders one glyph rather than all three, which costs a beat: the server and the first hydration render both say `system`, so a user on `dark` sees the monitor icon until hydration lands. Acceptable when the control sits below the fold or the app is client-rendered. When it must be right in the first frame, ship all three and reveal one with CSS as in `SKILL.md` step 3 — that path needs no JavaScript at all.

## Traps

- **Reading `localStorage` during render** produces server markup that cannot match the client. Read the DOM attribute the script already normalised, or nothing.
- **`suppressHydrationWarning` belongs on `<html>` only.** Putting it further down hides real mismatches; leaving it off floods the console on every load.
- **A `'use client'` provider is not a substitute for the script.** It runs after hydration, which is after the first paint.
