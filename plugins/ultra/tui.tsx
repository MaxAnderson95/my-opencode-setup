/** @jsxImportSource @opentui/solid */
import { Plugin } from "@opencode-ai/plugin/tui"
import { MouseButton, RGBA, TextAttributes } from "@opentui/core"
import { readFile } from "node:fs/promises"
import { watchFile, unwatchFile } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { parse, type ParseError } from "jsonc-parser"
import { createEffect, createResource, createSignal, For, onCleanup, Show } from "solid-js"
import { Ultra } from "./rpc.js"

export default Plugin.define({
  id: "ultra.tui",
  setup(ctx) {
    const rpc = ctx.client.rpc(Ultra)
    const [animations, setAnimations] = createSignal(false)
    // The public TUI context does not expose CLI preferences yet. Read only the
    // documented local preference file; never change it or the server config.
    const configPath = join(process.env.OPENCODE_CONFIG_DIR ?? join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "opencode"), "cli.json")
    const refreshAnimations = () => readFile(configPath, "utf8").then(
      (text) => {
        const errors: ParseError[] = []
        const config = parse(text, errors, { allowTrailingComma: true })
        const valid = config !== null && typeof config === "object" && !Array.isArray(config)
        setAnimations(errors.length === 0 && valid && (config.animations === undefined || config.animations === true))
      },
      (error) => setAnimations(error.code === "ENOENT"),
    )
    void refreshAnimations()
    watchFile(configPath, { persistent: false, interval: 1000 }, refreshAnimations)
    const unregister = ctx.ui.slot({
      append: "prompt.footer.status",
      render: (props) => {
        const [status, { refetch }] = createResource(
          () => props.sessionID ? {
            sessionID: props.sessionID,
            location: ctx.data.session.get(props.sessionID)?.location ?? ctx.location ?? ctx.data.location.default(),
          } : undefined,
          async (source) => {
            const result = await rpc.status({ sessionID: source.sessionID }, { location: source.location }).catch(() => undefined)
            return result as { enabled: boolean } | undefined
          },
        )
        onCleanup(rpc.events.on("status", (event) => {
          const state = event.data as { sessionID: string; enabled: boolean }
          if (state.sessionID !== props.sessionID) return
          void refetch()
          ctx.ui.toast.show({
            message: state.enabled ? "Ultra on — proactive delegation" : "Ultra off",
            variant: "info",
            duration: 3000,
          })
        }))

        const letters = Array.from("● Ultra on")
        const [hovered, setHovered] = createSignal(false)
        let press: { x: number; y: number } | undefined
        const [frame, setFrame] = createSignal(0)
        const flowing = () => animations() && !status.loading && status()?.enabled === true && props.mode === "normal"
        createEffect(() => {
          setFrame(0)
          if (!flowing()) return
          const timer = setInterval(() => setFrame((value) => (value + 1) % 48), 40)
          onCleanup(() => clearInterval(timer))
        })
        const color = (index: number) => {
          const base = ctx.theme.text.feedback.success.default
          if (!flowing()) return base
          const head = frame() / 48 * (letters.length + 6) - 3
          const glow = Math.max(0, 1 - Math.abs(index - head) / 2)
          const bright = ctx.theme.text.default
          return RGBA.fromValues(
            base.r + (bright.r - base.r) * glow,
            base.g + (bright.g - base.g) * glow,
            base.b + (bright.b - base.b) * glow,
            base.a,
          )
        }

        return (
          <Show when={props.sessionID && props.mode === "normal"}>
            <text
              id="ultra.status"
              flexShrink={0}
              wrapMode="none"
              selectable={false}
              attributes={hovered() ? TextAttributes.UNDERLINE : 0}
              onMouseOver={() => setHovered(true)}
              onMouseOut={() => {
                setHovered(false)
                press = undefined
              }}
              onMouseDown={(event) => {
                press = event.button === MouseButton.LEFT ? { x: event.x, y: event.y } : undefined
              }}
              onMouseDrag={() => {
                press = undefined
              }}
              onMouseUp={(event) => {
                const start = press
                press = undefined
                if (!start || start.x !== event.x || start.y !== event.y) return
                if (event.button !== MouseButton.LEFT || event.isDragging || ctx.renderer.getSelection()?.getSelectedText()) return
                const sessionID = props.sessionID
                if (!sessionID) return
                event.preventDefault()
                event.stopPropagation()
                void ctx.client.session.command({ sessionID, command: "ultra", text: "" }).catch(() => {
                  ctx.ui.toast.show({ message: "Could not toggle Ultra", variant: "error" })
                })
              }}
              fg={status.loading || !status()?.enabled ? ctx.theme.text.subdued : ctx.theme.text.feedback.success.default}
            >
              <Show
                when={!status.loading && status()?.enabled}
                fallback={status.loading ? "Ultra …" : status() === undefined ? "Ultra ?" : "○ Ultra off"}
              >
                <For each={letters}>{(letter, index) => <span style={{ fg: color(index()) }}>{letter}</span>}</For>
              </Show>
            </text>
          </Show>
        )
      },
    })
    return () => {
      unwatchFile(configPath, refreshAnimations)
      unregister()
    }
  },
})
