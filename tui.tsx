/** @jsxImportSource @opentui/solid */
import { RenderableEvents, type BoxRenderable, type Renderable } from "@opentui/core"
import { Plugin } from "@opencode/plugin/tui"
import { createSignal, onCleanup } from "solid-js"

// The host's FormPrompt pushes this input mode while it is mounted. The form
// has no slot of its own, so the mode is the only public signal that it is up.
const FORM_MODE = "form"
const MINIMIZED_MODE = "question-minimize"

const border = {
  topLeft: "",
  bottomLeft: "",
  vertical: "┃",
  topRight: "",
  bottomRight: "",
  horizontal: " ",
  bottomT: "",
  topT: "",
  cross: "",
  leftT: "",
  rightT: "",
}

// session.composer.top renders inside the composer box, whose last child is the
// host's prompt switch (the form while one is pending). Solid placeholders and
// the closed composer are hidden, so the form is the last visible child.
export function formNode<T extends { readonly visible: boolean }>(children: readonly T[], anchor: T) {
  const node = children.findLast((child) => child.visible)
  return node === anchor ? undefined : node
}

export default Plugin.define({
  id: "question-minimize",
  setup(context) {
    const bind = typeof context.options.keybind === "string" ? context.options.keybind : "alt+m"

    return context.ui.slot({
      append: "session.composer.top",
      render: () => {
        let anchor: BoxRenderable | undefined
        const [minimized, setMinimized] = createSignal<{ node: Renderable; pop: () => void }>()

        const restore = () => {
          const current = minimized()
          if (!current) return
          setMinimized(undefined)
          current.node.off(RenderableEvents.DESTROYED, restore)
          if (!current.node.isDestroyed) current.node.visible = true
          current.pop()
        }

        const minimize = () => {
          if (minimized() || context.keymap.mode.current() !== FORM_MODE || !anchor?.parent) return
          const node = formNode(anchor.parent.getChildren(), anchor)
          if (!node) return
          node.visible = false
          // Answering elsewhere, cancelling, or a replacement form destroys the node.
          node.once(RenderableEvents.DESTROYED, restore)
          setMinimized({ node, pop: context.keymap.mode.push(MINIMIZED_MODE) })
        }

        onCleanup(restore)

        context.keymap.layer(() => ({
          mode: "global",
          commands: [
            {
              id: "question.minimize.toggle",
              title: minimized() ? "Restore question" : "Minimize question",
              group: "Form",
              bind,
              palette: true,
              enabled: () => minimized() !== undefined || context.keymap.mode.current() === FORM_MODE,
              run: () => (minimized() ? restore() : minimize()),
            },
          ],
        }))

        // The minimized mode replaces the form's mode, so its keys cannot answer
        // or dismiss a form the user cannot see.
        context.keymap.layer(() => ({
          mode: MINIMIZED_MODE,
          commands: [
            { bind: "return", title: "Restore question", group: "Form", run: restore },
            { bind: "escape", title: "Restore question", group: "Form", run: restore },
            { bind: "up", title: "Scroll up", group: "Form", run: () => context.keymap.dispatch("session.line.up") },
            {
              bind: "down",
              title: "Scroll down",
              group: "Form",
              run: () => context.keymap.dispatch("session.line.down"),
            },
          ],
        }))

        return (
          <box
            ref={(value: BoxRenderable) => (anchor = value)}
            visible={minimized() !== undefined}
            flexDirection="row"
            justifyContent="space-between"
            border={["left"]}
            customBorderChars={border}
            borderColor={context.theme.background.action.primary.focused}
            backgroundColor={context.theme.background.raised.base}
            paddingLeft={2}
            paddingRight={3}
            onMouseUp={restore}
          >
            <text fg={context.theme.text.base}>Question minimized</text>
            <text fg={context.theme.text.base}>
              {bind} <span style={{ fg: context.theme.text.muted }}>or</span> enter{" "}
              <span style={{ fg: context.theme.text.muted }}>restore</span> ↑↓ pgup pgdn{" "}
              <span style={{ fg: context.theme.text.muted }}>scroll</span>
            </text>
          </box>
        )
      },
    })
  },
})
