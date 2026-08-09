# Astro wiring

## The script

Astro compiles a bare `<script>` into a bundled ES module, which is deferred — a guaranteed **flash**. `is:inline` is what keeps it inline and blocking. Paste the block from step 2 of `SKILL.md` into the layout's `<head>`:

```astro
---
// src/layouts/Layout.astro
---
<html lang="en">
  <head>
    <meta name="color-scheme" content="light dark" />
    <script is:inline>
      /* the step 2 block, verbatim */
    </script>
  </head>
  <body><slot /></body>
</html>
```

Any attribute on a `<script>` implies `is:inline`, so an inline script is never bundled and never re-runs on its own.

## With `<ClientRouter />`

Client-side navigation replaces `<html>`'s attributes with the incoming document's, dropping the class and the preference. `window` survives the swap, so re-apply from the event rather than re-running the whole script:

```astro
<script is:inline>
  document.addEventListener('astro:after-swap', function () {
    if (window.__theme) window.__theme.reapply();
  });
</script>
```

Add the matching method to the script in step 2, next to `set`:

```js
reapply: function () { apply(read()); },
```

`astro:after-swap` fires after the new document is in place and before it paints, which is the only window where this is invisible.

## The control

An `.astro` component: all three glyphs in the markup, an `is:inline` script below them for the press. No island, no framework runtime.

```astro
---
// src/components/ThemeToggle.astro
---
<button type="button" class="theme-toggle" title="Switch to dark"
        aria-label="Appearance: system default. Switch to dark.">
  <svg class="icon icon-system" viewBox="0 0 24 24" aria-hidden="true">
    <rect width="20" height="14" x="2" y="3" rx="2" />
    <line x1="8" x2="16" y1="21" y2="21" />
    <line x1="12" x2="12" y1="17" y2="21" />
  </svg>
  <svg class="icon icon-dark" viewBox="0 0 24 24" aria-hidden="true">
    <path d="M20.985 12.486a9 9 0 1 1-9.473-9.472c.405-.022.617.46.402.803a6 6 0 0 0 8.268 8.268c.344-.215.825-.004.803.401" />
  </svg>
  <svg class="icon icon-light" viewBox="0 0 24 24" aria-hidden="true">
    <circle cx="12" cy="12" r="4" />
    <path d="M12 2v2" /><path d="M12 20v2" />
    <path d="m4.93 4.93 1.41 1.41" /><path d="m17.66 17.66 1.41 1.41" />
    <path d="M2 12h2" /><path d="M20 12h2" />
    <path d="m6.34 17.66-1.41 1.41" /><path d="m19.07 4.93-1.41 1.41" />
  </svg>
</button>

<script is:inline>
  (function () {
    var button = document.querySelector('.theme-toggle');
    if (!button) return;
    var root = document.documentElement;
    var NEXT = { dark: 'light', light: 'system', system: 'dark' };
    /* Lowercase: these read inside a sentence, never on their own. */
    var LABEL = { dark: 'dark', light: 'light', system: 'system default' };

    function current() {
      return NEXT[root.dataset.theme] ? root.dataset.theme : 'system';
    }

    function sync() {
      var now = current();
      var next = NEXT[now];
      button.title = 'Switch to ' + LABEL[next];
      button.setAttribute(
        'aria-label',
        'Appearance: ' + LABEL[now] + '. Switch to ' + LABEL[next] + '.',
      );
    }

    button.addEventListener('click', function () {
      button.classList.add('armed'); /* turns the icon swap on, so it never plays on load */
      window.__theme.set(NEXT[current()]);
      sync();
    });

    sync();
  })();
</script>
```

The glyphs are lucide's `monitor`, `moon`, and `sun`; style them with `fill: none; stroke: currentColor; stroke-width: 1.75; stroke-linecap: round; stroke-linejoin: round`.

Under `<ClientRouter />` this script does not re-run after a swap, so move its body into an `astro:page-load` handler, which fires on the first load and on every navigation.
