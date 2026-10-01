import { Plugin } from "@opencode/plugin"
import { Schema } from "effect"
import { fileURLToPath } from "node:url"

// Printing goes through python-escpos in a subprocess: it handles code pages and
// USB status queries, and a stalled printer cannot block the shared server.
const script = fileURLToPath(new URL("./print_receipt.py", import.meta.url))
// The first run resolves python-escpos into uv's cache.
const TIMEOUT_MS = 120_000

// On OpenCode 2.0.21 the host mis-validates Effect Schema checks from a plugin
// (Schema.Int rejected 2 and isLengthBetween rejected valid strings), so ranges are
// literal unions and print_receipt.py validates the rest.
const range = (max: number) => Schema.Literals(Array.from({ length: max }, (_, i) => i + 1))
const Align = Schema.Literals(["left", "center", "right"]).annotate({ description: "Default left" })
const flag = (description: string) => Schema.optionalKey(Schema.Boolean.annotate({ description }))

const Block = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("text"),
    text: Schema.String.annotate({
      description:
        "Word-wrapped to the paper width. Newlines, blank lines, and leading indentation are kept; lines that fit print verbatim",
    }),
    align: Schema.optionalKey(Align),
    bold: flag("Bold"),
    underline: flag("Underline"),
    invert: flag("White on black, good for section headers padded with spaces"),
    font: Schema.optionalKey(
      Schema.Literals(["a", "b"]).annotate({ description: "a: 42 columns (default). b: 56 smaller columns" }),
    ),
    width: Schema.optionalKey(range(8).annotate({ description: "Character width multiplier; divides the columns" })),
    height: Schema.optionalKey(range(8).annotate({ description: "Character height multiplier" })),
  }),
  Schema.Struct({
    type: Schema.Literal("row"),
    left: Schema.String.annotate({ description: "Left side, wraps if long" }),
    right: Schema.String.annotate({
      description: "Right-aligned on the first line, such as a ticket key, status, due date, or time",
    }),
    bold: flag("Bold"),
  }),
  Schema.Struct({
    type: Schema.Literal("rule"),
    char: Schema.optionalKey(Schema.String.annotate({ description: "One character, default -" })),
  }),
  Schema.Struct({
    type: Schema.Literal("qr"),
    data: Schema.String.annotate({ description: "Usually a URL" }),
    size: Schema.optionalKey(
      range(16).annotate({ description: "Module size in dots, default 6. Long data needs a smaller size" }),
    ),
    align: Schema.optionalKey(Align.annotate({ description: "Default center" })),
  }),
  Schema.Struct({
    type: Schema.Literal("feed"),
    lines: Schema.optionalKey(range(20)),
  }),
])

const Printout = Schema.Struct({
  blocks: Schema.Array(Block),
  cut: flag("Feed and cut the paper at the end. Default true"),
  dry_run: flag("Return the preview without printing"),
})

async function runScript(args: string[], stdin: string, signal: AbortSignal) {
  const proc = Bun.spawn(["uv", "run", "--quiet", "--script", script, ...args], {
    stdin: new TextEncoder().encode(stdin),
    stdout: "pipe",
    stderr: "pipe",
    signal,
    timeout: TIMEOUT_MS,
  })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  return { stdout: stdout.trimEnd(), stderr: stderr.trim(), exitCode }
}

export default Plugin.define({
  id: "receipt-printer",
  async setup(ctx) {
    await ctx.tool.transform((tools) => {
      tools.namespace({
        name: "receipt_printer",
        description: "The Epson TM-T88V thermal printer on the user's desk",
      })
      tools.add({
        name: "print",
        description: [
          "Print on the user's desk thermal printer (80 mm paper) and return a plain-text preview of the layout.",
          "Use it for physical printouts such as todo lists, notes, ticket summaries with a QR link, or session summaries.",
          "A printout is a list of blocks printed top to bottom: text, row (left text with right-aligned text), rule (a full-width divider), qr, and feed (blank lines).",
          "Accented Latin, Greek, Cyrillic, and box-drawing characters print; emoji print as '?', so use [ ] and [x] for checkboxes.",
          "Each call uses paper, so print only when the user asks; dry_run returns the preview without printing.",
        ].join(" "),
        input: Printout,
        options: { namespace: "receipt_printer", pinned: true },
        async execute(printout, call) {
          const { stdout: preview, stderr: notes, exitCode } = await runScript([], JSON.stringify(printout), call.signal)
          const printed = exitCode === 0 && !printout.dry_run
          // Failures return as content: a thrown error from a Promise tool becomes a defect.
          const content =
            exitCode === 0
              ? [
                  printed ? "Printed." : "Dry run; nothing printed.",
                  notes && `Printer notes: ${notes}`,
                  `Preview:\n${preview}`,
                ]
                  .filter(Boolean)
                  .join("\n\n")
              : `Not printed (exit ${exitCode}): ${notes || "no error output"}`
          return { content, metadata: { printed, exitCode } }
        },
      })
      tools.add({
        name: "status",
        description:
          "Check whether the receipt printer is connected over USB right now, and its paper level (ok, low, or out) when it is. Uses no paper.",
        input: Schema.Struct({}),
        options: { namespace: "receipt_printer", pinned: true },
        async execute(_, call) {
          const { stdout, stderr, exitCode } = await runScript(["status"], "", call.signal)
          // Exit 3 is the script's "not connected" answer; anything else nonzero is a failed check.
          const connected = exitCode === 0
          const content = connected || exitCode === 3 ? stdout : `Status check failed (exit ${exitCode}): ${stderr || "no error output"}`
          return { content, metadata: { connected, exitCode } }
        },
      })
    })
  },
})
