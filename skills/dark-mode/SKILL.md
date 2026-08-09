---
name: dark-mode
description: >-
  Add dark mode, light mode, and a system-default appearance control to a web app. Use when the user asks for a dark or light theme, a theme switcher or toggle, or reports a flash of the wrong theme on load, a theme that resets on reload, a control that loses "system", scrollbars or form controls stuck on the wrong side, or a hydration mismatch on <html>. Carries the CSS token structure, the pre-paint script, and the wiring for Astro, Vite, and Next.js.
---

# Dark mode

Two values, never one.

**Preference** is what the user chose: `dark`, `light`, or `system`. You store it, and the control draws it.
**Resolved theme** is what the page paints: `dark` or `light`. It equals the preference, except on `system`, where the OS decides.

Collapsing them into a boolean is the root of most theme bugs. `system` stops being reachable after the first press, the control cannot say which state it is in, and a machine that flips at dusk keeps yesterday's answer.

Carry both on `<html>`, where every stylesheet and every component can reach them:

| What | Where | Read by |
|---|---|---|
| preference | `data-theme="dark \| light \| system"` | the control, and any framework store |
| resolved theme | `class="dark"`, present only when dark | your CSS |
| resolved theme | `style="color-scheme: dark"` | the browser's own widgets |

Work through the four steps in order. Each one is checkable, and step 4 is what proves the feature.

## 1. One token set, two values

Every colour the page paints goes through a custom property. A hard-coded hex inside a component is a colour that cannot change with the theme, so hunt those first and promote them to tokens.

```css
:root {
  --bg: #faf9f7;
  --surface: #ffffff;
  --ink: #16202b;
  --ink-soft: #5b6b7c;
  --line: #e3ded6;
}
/* Resolved by the pre-paint script in step 2. */
html.dark {
  --bg: #0d1a2b;
  --surface: #14263c;
  --ink: #e9eff6;
  --ink-soft: #93a5b8;
  --line: #23374e;
}
```

- `html.dark` (0,1,1) outranks `:root` (0,1,0), so the override needs no `!important`.
- Components that need more than a token swap take a `html.dark .thing { }` rule. Keep those few; a long tail of them means the token set is too thin.
- **Once the class exists, `@media (prefers-color-scheme: dark)` must not appear anywhere in your stylesheets.** It answers a different question (what the OS wants) than the page is now asking (what the user chose), and the two disagree the moment anyone forces a theme. The media query survives in exactly one place: inside the script in step 2. Converting an existing site means rewriting every one of those blocks into a `html.dark` selector.
- Add `<meta name="color-scheme" content="light dark" />` to `<head>` so the browser knows both exist before any CSS parses.
- **Tailwind v4:** `@custom-variant dark (&:where(.dark, .dark *));` in your CSS entry. **v3:** `darkMode: 'class'` in the config. Then `dark:` utilities key off the class instead of the OS.

**Done when:** the whole page renders correctly with `dark` toggled by hand in devtools, and a search for `prefers-color-scheme` across the stylesheets returns nothing.

## 2. The pre-paint script

This is the only thing standing between the user and a **flash** of the wrong theme. It has to be inline and blocking, in `<head>`: the answer depends on `localStorage` and the OS setting, neither of which the server or the build can know, so anything deferred paints light first and then snaps to dark.

```html
<script>
  (function () {
    var KEY = 'theme';
    var root = document.documentElement;
    var media = window.matchMedia('(prefers-color-scheme: dark)');

    function read() {
      try {
        var stored = localStorage.getItem(KEY);
        if (stored === 'dark' || stored === 'light' || stored === 'system') return stored;
      } catch (e) {
        // Storage throws outright in some privacy modes; an unreadable
        // preference is the same situation as an unset one.
      }
      return 'system';
    }

    function apply(preference) {
      var dark = preference === 'dark' || (preference === 'system' && media.matches);
      root.dataset.theme = preference;
      root.classList.toggle('dark', dark);
      root.style.colorScheme = dark ? 'dark' : 'light';
    }

    apply(read());

    // On 'system' the OS can flip while the page is open, and nothing writes
    // to storage when it does.
    media.addEventListener('change', function () {
      if (root.dataset.theme === 'system') apply('system');
    });

    // Fires only in OTHER tabs, which is exactly the case this covers.
    window.addEventListener('storage', function (e) {
      if (e.key === KEY) apply(read());
    });

    window.__theme = {
      set: function (preference) {
        try {
          localStorage.setItem(KEY, preference);
        } catch (e) {
          // The choice still applies to this page, it just is not remembered.
        }
        apply(preference);
      },
    };
  })();
</script>
```

Nothing else in the app may write the class, the attribute, or the storage key. `window.__theme.set` is the one door in.

**Read the wiring file for the framework in play now** — placement is where this step actually goes wrong:

- Astro → [`astro.md`](astro.md)
- React (Next.js, Vite, Remix, anything with hydration) → [`react.md`](react.md)
- Plain HTML or a template language → paste the block above into `<head>` as-is, ahead of the stylesheet links.

**Done when:** hard-reloading with a dark preference on a light OS shows no light frame, in a throttled profile with the cache disabled.

## 3. The control

One button that cycles `dark` → `light` → `system` → `dark`. One button rather than a menu because there are three states and the icon already says which one is active; a menu would cost a press and a popover to say the same thing. Conventional glyphs: moon, sun, monitor.

Three rules that decide whether it feels solid:

- **Ship all three glyphs in the markup** and let CSS reveal the one matching the preference. The icon is then correct on the first paint, with no script and no hydration pass involved.
  ```css
  .theme-toggle .icon { display: none }
  [data-theme='dark'] .theme-toggle .icon-dark,
  [data-theme='light'] .theme-toggle .icon-light,
  [data-theme='system'] .theme-toggle .icon-system { display: block }
  ```
- **The accessible name carries both halves an icon cannot**: the state it is in and the state a press moves to. `aria-label="Appearance: system default. Switch to dark."`, updated on each press, plus a `title` for the mouse. Not `aria-pressed` — that describes two states, and this has three.
- **Animate on press only.** Revealing the incoming glyph restarts a CSS animation for free, but that also fires on page load, where it is the only thing moving. Gate it on a class the script adds at the first press, and switch it off under `prefers-reduced-motion`.

**Done when:** pressing four times returns to the starting state, and the accessible name matches at every stop.

## 4. Verify six states

Two OS settings times three preferences. Anything less leaves the interesting half untested, because the bugs live where the preference and the OS disagree.

```js
for (const scheme of ['dark', 'light']) {
  await page.emulateMedia({ colorScheme: scheme });
  await page.evaluate(() => localStorage.removeItem('theme'));
  await page.reload({ waitUntil: 'networkidle' });
  for (let i = 0; i < 4; i++) {
    console.log(scheme, await page.evaluate(() => ({
      pref: document.documentElement.dataset.theme,
      dark: document.documentElement.classList.contains('dark'),
      scheme: document.documentElement.style.colorScheme,
      bg: getComputedStyle(document.body).backgroundColor,
      icon: [...document.querySelectorAll('.theme-toggle .icon')]
        .find((n) => getComputedStyle(n).display !== 'none')?.className.baseVal,
      label: document.querySelector('.theme-toggle').getAttribute('aria-label'),
      stored: localStorage.getItem('theme'),
    })));
    if (i < 3) await page.click('.theme-toggle');
  }
}
```

Then three by hand: reload holds the choice; flipping the OS while on `system` repaints the open page; flipping the OS while on `dark` or `light` changes nothing.

**Done when:** all six rows agree — resolved theme, painted background, revealed icon, and label — and the three manual checks pass.

## Traps

- **A deferred script cannot prevent the flash.** `type="module"` is deferred by definition, and every bundler defers what it emits. The theme script must stay an inline classic script that the bundler never touches.
- **An SVG loaded through `<img>` can only see the OS setting.** A `prefers-color-scheme` rule inside the file ignores your class, so a forced theme leaves a white logo on a white tile. Inline the SVG and paint it with `currentColor`, or invert it from the parent with a CSS filter. Same blindness applies to `<iframe>` and third-party embeds.
- **A cookie does not remove the script.** Storing the preference server-side lets the server render the class, but the server still cannot resolve `system` — only the browser knows the OS setting — so the pre-paint work happens in the document either way.
- **Native widgets ignore your tokens.** Scrollbars, `<select>` popups, date pickers, and autofill follow `color-scheme` alone. That is why the script sets it, and why the meta tag goes in.
- **With the class approach, JS-off means light for everyone.** Usually the right trade. When it is not, add one media-query block gated on `html:not([data-theme])` — an attribute the script sets before paint, so the fallback only ever applies when the script never ran.
- **Storage access throws**, it does not return null: Safari private mode, partitioned third-party contexts, hardened enterprise profiles. Every read and write sits in a `try`.
