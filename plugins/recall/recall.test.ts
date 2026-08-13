import { describe, expect, test } from "bun:test"
import { Database } from "bun:sqlite"

import { loadConfig, parseModelSpec, summaryModelTag } from "./lib/config.ts"
import { createFakeEmbedder } from "./lib/embedder.ts"
import { DirectoryExclusions } from "./lib/exclusions.ts"
import {
  addV1Session,
  createSourceDb,
  createSourceDbV1,
  insertV2Message,
  type FixtureSession,
} from "./lib/fixture.ts"
import { Indexer } from "./lib/indexer.ts"
import { BackfillAnnouncer, logNotifier, type Toast } from "./lib/notify.ts"
import { BackfillLease, getMeta, migrate, openIndex, setMeta, SCHEMA_VERSION } from "./lib/schema.ts"
import { SearchIndex, fuse, type Filters, type Hit } from "./lib/search.ts"
import { Source, extractPartText, parseJson } from "./lib/source.ts"
import { Summarizer, WORKER_PREFIX, pool, type SessionClient } from "./lib/summarize.ts"
import { chunkText, clean, ftsQuery, makeSnippet, middleOut, segmentText, stripAnsi } from "./lib/text.ts"

// ------------------------------------------------------------------ text

describe("text helpers", () => {
  test("stripAnsi removes colour and OSC sequences", () => {
    expect(stripAnsi("\u001b[31mred\u001b[0m")).toBe("red")
    expect(stripAnsi("\u001b]0;title\u0007body")).toBe("body")
  })

  test("clean collapses whitespace and marks truncation", () => {
    expect(clean("  a\n\n b  ", 100)).toBe("a b")
    expect(clean("abcdef", 3)).toBe("abc…")
  })

  test("ftsQuery quotes every token so FTS5 operators cannot leak", () => {
    expect(ftsQuery('drop OR "table"', "AND")).toBe('"drop" AND "OR" AND "table"')
    expect(ftsQuery("a-b.c", "AND")).toBe('"a-b.c"')
    expect(ftsQuery("   ", "AND")).toBeUndefined()
  })

  test("ftsQuery output is accepted by FTS5", () => {
    const db = new Database(":memory:")
    db.run(`CREATE VIRTUAL TABLE f USING fts5(text)`)
    db.run(`INSERT INTO f VALUES ('the napi_create_error panic in bun')`)
    for (const q of ["napi_create_error", 'drop OR "x"', "a* NEAR b", "^caret (paren)"]) {
      const match = ftsQuery(q, "OR")!
      expect(() => db.query(`SELECT rowid FROM f WHERE f MATCH ?`).all(match)).not.toThrow()
    }
    expect(
      db.query(`SELECT rowid FROM f WHERE f MATCH ?`).all(ftsQuery("napi_create_error", "AND")!),
    ).toHaveLength(1)
  })

  describe("segmentText", () => {
    test("leaves short text as one segment at offset 0", () => {
      expect(segmentText("hello", 100)).toEqual([{ start: 0, text: "hello" }])
    })

    test("drops blank text entirely", () => {
      expect(segmentText("   ", 100)).toEqual([])
    })

    test("splits long text losslessly with correct offsets", () => {
      const src = Array.from({ length: 500 }, (_, i) => `word${i}`).join(" ")
      const segs = segmentText(src, 400)
      expect(segs.length).toBeGreaterThan(1)
      expect(segs.map((s) => s.text).join("")).toBe(src)
      for (const s of segs) expect(src.slice(s.start, s.start + s.text.length)).toBe(s.text)
    })

    test("prefers newline boundaries", () => {
      const src = "a".repeat(70) + "\n" + "b".repeat(70)
      const segs = segmentText(src, 100)
      expect(segs[0].text.endsWith("\n")).toBe(true)
    })
  })

  describe("chunkText", () => {
    test("short text yields one chunk", () => {
      expect(chunkText("hello world", 100, 20, 1000)).toEqual(["hello world"])
    })

    test("windows cover the whole input, which truncation did not", () => {
      const src = Array.from({ length: 400 }, (_, i) => `t${i}`).join(" ")
      const chunks = chunkText(src, 200, 50, 100_000)
      expect(chunks.length).toBeGreaterThan(1)
      // Every token in the source is reachable from some chunk.
      const joined = chunks.join(" ")
      for (const tok of ["t0", "t199", "t399"]) expect(joined).toContain(tok)
    })

    test("consecutive chunks overlap so boundary facts survive", () => {
      const src = "x".repeat(1000)
      const chunks = chunkText(src, 300, 100, 100_000)
      expect(chunks[0]).toHaveLength(300)
      // stride = size - overlap
      expect(chunks.length).toBe(Math.ceil((1000 - 300) / 200) + 1)
    })

    test("maxChars keeps head and tail of a pathological turn", () => {
      const src = "HEAD" + "m".repeat(50_000) + "TAIL"
      const chunks = chunkText(src, 500, 100, 2000)
      const joined = chunks.join("")
      expect(joined).toContain("HEAD")
      expect(joined).toContain("TAIL")
      expect(joined.length).toBeLessThan(6000)
    })
  })

  describe("makeSnippet", () => {
    test("highlights the query term", () => {
      expect(makeSnippet("the quick brown fox", ["brown"], 100)).toBe("the quick «brown» fox")
    })

    test("centres on the densest cluster of terms", () => {
      const noise = "filler ".repeat(60)
      const text = `alpha ${noise} alpha beta gamma ${noise} beta`
      const snip = makeSnippet(text, ["alpha", "beta", "gamma"], 80)
      expect(snip).toContain("«alpha»")
      expect(snip).toContain("«beta»")
      expect(snip).toContain("«gamma»")
    })

    test("falls back to a head excerpt when nothing matches", () => {
      const snip = makeSnippet("a".repeat(500), ["zzz"], 50)
      expect(snip).toBe("a".repeat(50) + "…")
    })

    test("respects the width once highlight markers are discounted, and strips ansi", () => {
      const snip = makeSnippet("\u001b[31m" + "word ".repeat(200), ["word"], 100)
      expect(snip).not.toContain("\u001b")
      const bare = snip.replaceAll("«", "").replaceAll("»", "").replaceAll("…", "")
      expect(bare.length).toBeLessThanOrEqual(100)
    })

    test("handles empty input", () => {
      expect(makeSnippet("", ["x"])).toBe("")
    })
  })

  describe("middleOut", () => {
    const note = (o: number, t: number) => `[${o}/${t} omitted]`

    test("returns everything when under budget", () => {
      expect(middleOut(["a", "b"], 1000, note)).toBe("a\nb")
    })

    test("keeps head and tail, drops the middle", () => {
      const blocks = Array.from({ length: 20 }, (_, i) => `block${i}`.padEnd(50, "."))
      const out = middleOut(blocks, 300, note)
      expect(out).toContain("block0")
      expect(out).toContain("block19")
      expect(out).toContain("omitted]")
      expect(out).not.toContain("block10")
    })
  })
})

// ------------------------------------------------------------------ config

describe("config", () => {
  test("defaults when no file and no env", () => {
    const { config, source } = loadConfig({}, () => null, "/home/t")
    expect(source).toBe("defaults")
    expect(config.embed.dims).toBe(384)
    expect(config.summary.enabled).toBe(true)
    expect(config.index.excludeDirectories).toEqual([])
    expect(config.summary.model).toEqual({ providerID: "openai", modelID: "gpt-5.6-luna", variant: "low" })
  })

  test("file overrides defaults, deep-merged", () => {
    const { config, source } = loadConfig(
      {},
      () => `{"embed":{"dims":768},"summary":{"model":{"providerID":"anthropic","modelID":"haiku"}}}`,
      "/home/t",
    )
    expect(source).toContain("recall.json")
    expect(config.embed.dims).toBe(768)
    expect(config.embed.model).toBe("Xenova/bge-small-en-v1.5") // untouched sibling
    expect(config.summary.model.providerID).toBe("anthropic")
    expect(config.summary.concurrency).toBe(4) // untouched sibling
  })

  test("tolerates comments and trailing commas", () => {
    const { config, warnings } = loadConfig({}, () => `{\n  // a note\n  "embed": {"dims": 512},\n}`, "/home/t")
    expect(warnings).toHaveLength(0)
    expect(config.embed.dims).toBe(512)
  })

  test("unparseable file warns and falls back rather than throwing", () => {
    const { config, warnings } = loadConfig({}, () => "{not json", "/home/t")
    expect(warnings[0]).toContain("ignoring")
    expect(config.embed.dims).toBe(384)
  })

  test("unknown keys are ignored", () => {
    const { config } = loadConfig({}, () => `{"bogus":1,"embed":{"nope":2,"dims":128}}`, "/home/t")
    expect((config as any).bogus).toBeUndefined()
    expect(config.embed.dims).toBe(128)
  })

  test("loads valid directory exclusions and drops invalid entries", () => {
    const { config, warnings } = loadConfig(
      {},
      () => `{"index":{"excludeDirectories":["~/secret","",42]}}`,
      "/home/t",
    )
    expect(config.index.excludeDirectories).toEqual(["~/secret"])
    expect(warnings[0]).toContain("2 invalid")
  })

  test("env beats file", () => {
    const { config } = loadConfig(
      { RECALL_SUMMARY_MODEL: "anthropic/claude-haiku/high", RECALL_DISABLE_SUMMARIZE: "1" },
      () => `{"summary":{"model":{"providerID":"openai","modelID":"x"}}}`,
      "/home/t",
    )
    expect(config.summary.model).toEqual({ providerID: "anthropic", modelID: "claude-haiku", variant: "high" })
    expect(config.summary.enabled).toBe(false)
  })

  test("bad env values warn instead of corrupting config", () => {
    const { config, warnings } = loadConfig({ RECALL_EMBED_DIMS: "abc", RECALL_SUMMARY_MODEL: "oops" }, () => null)
    expect(config.embed.dims).toBe(384)
    expect(warnings).toHaveLength(2)
  })

  test("overlap >= chunk size is clamped", () => {
    const { config, warnings } = loadConfig({}, () => `{"chunk":{"chars":100,"overlap":500}}`, "/home/t")
    expect(config.chunk.overlap).toBe(25)
    expect(warnings[0]).toContain("clamping")
  })

  test("parseModelSpec", () => {
    expect(parseModelSpec("openai/gpt-5")).toEqual({ providerID: "openai", modelID: "gpt-5" })
    expect(parseModelSpec("openai/gpt-5/low")).toEqual({ providerID: "openai", modelID: "gpt-5", variant: "low" })
    // A model id may itself contain a slash; only a known variant is split off.
    expect(parseModelSpec("bedrock/anthropic/claude")).toEqual({
      providerID: "bedrock",
      modelID: "anthropic/claude",
    })
    expect(parseModelSpec("nope")).toBeNull()
  })

  test("summaryModelTag round-trips the variant", () => {
    const { config } = loadConfig({ RECALL_SUMMARY_MODEL: "openai/m/low" }, () => null)
    expect(summaryModelTag(config)).toBe("openai/m/low")
  })
})

describe("directory exclusions", () => {
  test("matches an exact directory and descendants, but not sibling prefixes", () => {
    const exclusions = new DirectoryExclusions(["~/Projects/private/"], "/Users/test")
    expect(exclusions.matches("/Users/test/Projects/private")).toBe(true)
    expect(exclusions.matches("/Users/test/Projects/private/subdir")).toBe(true)
    expect(exclusions.matches("/Users/test/Projects/private-old")).toBe(false)
  })

  test("ignores relative exclusion roots", () => {
    const exclusions = new DirectoryExclusions(["Projects/private"], "/Users/test")
    expect(exclusions.matches("/Users/test/Projects/private")).toBe(false)
  })
})

// ------------------------------------------------------------------ schema

describe("schema migration", () => {
  const fresh = () => {
    const db = new Database(":memory:")
    openIndex(db)
    return db
  }

  test("fresh database is not reported as a reset", () => {
    const db = fresh()
    const r = migrate(db, "m:384", () => 0)
    expect(r.reset).toBe(false)
    expect(db.query(`SELECT count(*) c FROM parts`).get()).toEqual({ c: 0 })
  })

  test("second open is a no-op", () => {
    const db = fresh()
    migrate(db, "m:384", () => 0)
    db.run(`INSERT INTO indexed_sessions(session_id,time_updated) VALUES ('s',1)`)
    expect(migrate(db, "m:384", () => 0).reset).toBe(false)
    expect(db.query(`SELECT count(*) c FROM indexed_sessions`).get()).toEqual({ c: 1 })
  })

  test("embedding model change resets the index", () => {
    const db = fresh()
    migrate(db, "m:384", () => 0)
    db.run(`INSERT INTO indexed_sessions(session_id,time_updated) VALUES ('s',1)`)
    const r = migrate(db, "other:768", () => 0)
    expect(r.reset).toBe(true)
    expect(r.reason).toContain("model")
    expect(db.query(`SELECT count(*) c FROM indexed_sessions`).get()).toEqual({ c: 0 })
  })

  test("schema version change resets the index", () => {
    const db = fresh()
    migrate(db, "m:384", () => 0)
    setMeta(db, "schema", "1")
    const r = migrate(db, "m:384", () => 0)
    expect(r.reset).toBe(true)
    expect(r.reason).toBe(`schema 1 -> ${SCHEMA_VERSION}`)
  })

  test("a pre-versioned index is detected and reset", () => {
    const db = fresh()
    db.run(`CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT)`)
    db.run(`CREATE VIRTUAL TABLE fts USING fts5(text, session_id UNINDEXED)`)
    db.run(`INSERT INTO fts(text,session_id) VALUES ('old','s')`)
    const r = migrate(db, "m:384", () => 0)
    expect(r.reset).toBe(true)
    expect(r.reason).toBe("pre-versioned index")
  })

  test("summaries survive a reset", () => {
    const db = fresh()
    migrate(db, "m:384", () => 0)
    db.run(`INSERT INTO summaries(session_id,model,focus,time_updated,summary,created)
            VALUES ('s','mdl','',1,'the summary',1)`)
    migrate(db, "other:768", () => 0)
    expect(db.query(`SELECT summary FROM summaries`).get()).toEqual({ summary: "the summary" })
  })
})

describe("BackfillLease", () => {
  const db = new Database(":memory:")
  db.run(`CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT)`)

  test("only one holder at a time, and it is reentrant for the owner", () => {
    let now = 1000
    const a = new BackfillLease(db, 500, () => now)
    const b = new BackfillLease(db, 500, () => now)
    expect(a.tryAcquire()).toBe(true)
    expect(b.tryAcquire()).toBe(false)
    expect(a.tryAcquire()).toBe(true)
    a.release()
    expect(b.tryAcquire()).toBe(true)
    b.release()
  })

  test("a stale lease can be stolen", () => {
    let now = 1000
    const a = new BackfillLease(db, 500, () => now)
    const b = new BackfillLease(db, 500, () => now)
    expect(a.tryAcquire()).toBe(true)
    now += 400
    expect(b.tryAcquire()).toBe(false)
    now += 200 // past the 500ms ttl
    expect(b.tryAcquire()).toBe(true)
    b.release()
  })

  test("heartbeat keeps the lease alive", () => {
    let now = 1000
    const a = new BackfillLease(db, 500, () => now)
    const b = new BackfillLease(db, 500, () => now)
    expect(a.tryAcquire()).toBe(true)
    now += 400
    a.heartbeat()
    now += 300
    expect(b.tryAcquire()).toBe(false)
    a.release()
  })
})

// ------------------------------------------------------------------ notify

describe("BackfillAnnouncer", () => {
  const cfg = { enabled: true, announceMin: 25, progressMin: 200 }
  const collect = () => {
    const out: Toast[] = []
    return { out, notify: (t: Toast) => out.push(t) }
  }

  test("routine catch-up runs are completely silent", () => {
    const { out, notify } = collect()
    const a = new BackfillAnnouncer(notify, cfg)
    a.start(5)
    for (let i = 1; i <= 5; i++) a.progress(i)
    a.finish(5, 100, "")
    expect(out).toHaveLength(0)
  })

  test("a medium run announces start and finish but no progress", () => {
    const { out, notify } = collect()
    let now = 0
    const a = new BackfillAnnouncer(notify, cfg, () => now)
    a.start(50)
    for (let i = 1; i <= 50; i++) {
      now += 1000
      a.progress(i)
    }
    a.finish(50, 500, "")
    expect(out).toHaveLength(2)
    expect(out[0].message).toContain("Indexing 50 conversations")
    expect(out[1].variant).toBe("success")
    expect(out[1].message).toContain("in 50s")
    expect(out[1].message).toContain("500 chunks")
  })

  test("elapsed time is rendered in minutes once past a minute", () => {
    const { out, notify } = collect()
    let now = 0
    const a = new BackfillAnnouncer(notify, cfg, () => now)
    a.start(30)
    now = 5 * 60_000 + 7_000
    a.finish(30, 1, "")
    expect(out[1].message).toContain("in 5m7s")
  })

  test("a large run adds progress toasts at 25/50/75 only", () => {
    const { out, notify } = collect()
    let now = 0
    const a = new BackfillAnnouncer(notify, cfg, () => now)
    a.start(1000)
    for (let i = 1; i <= 1000; i++) {
      now += 100
      a.progress(i)
    }
    a.finish(1000, 9000, "")
    const progress = out.filter((t) => t.message.startsWith("Indexing conversations:"))
    expect(progress.map((t) => t.message.match(/(\d+)%/)![1])).toEqual(["25", "50", "75", "100"])
    expect(out).toHaveLength(6) // start + 4 milestones + finish
  })

  test("progress never repeats a milestone even when called densely", () => {
    const { out, notify } = collect()
    const a = new BackfillAnnouncer(notify, cfg, () => 0)
    a.start(400)
    for (let i = 1; i <= 400; i++) a.progress(i)
    for (let i = 1; i <= 400; i++) a.progress(i)
    const pct = out.filter((t) => t.message.startsWith("Indexing conversations:"))
    expect(new Set(pct.map((t) => t.message)).size).toBe(pct.length)
  })

  test("a reset says so, because the index is temporarily incomplete", () => {
    const { out, notify } = collect()
    new BackfillAnnouncer(notify, cfg).start(3000, { afterReset: true })
    expect(out[0].message).toContain("Rebuilding")
    expect(out[0].message).toContain("incomplete")
  })

  test("errors downgrade the completion toast to a warning", () => {
    const { out, notify } = collect()
    const a = new BackfillAnnouncer(notify, cfg, () => 0)
    a.start(100)
    a.finish(100, 10, "ses_x: boom")
    expect(out[1].variant).toBe("warning")
    expect(out[1].message).toContain("recall_status")
  })

  test("disabling notifications silences even a full rebuild", () => {
    const { out, notify } = collect()
    const a = new BackfillAnnouncer(notify, { ...cfg, enabled: false }, () => 0)
    a.start(5000, { afterReset: true })
    a.progress(2500)
    a.finish(5000, 1, "")
    expect(out).toHaveLength(0)
  })

  test("a throwing log sink never escapes the notifier", () => {
    const n = logNotifier(() => {
      throw new Error("boom")
    })
    expect(() => n({ message: "hi" })).not.toThrow()
  })
})

// ------------------------------------------------------------------ source

describe("extractPartText", () => {
  const opts = { toolOutputChars: 50 }

  test("text and reasoning parts keep their kind", () => {
    expect(extractPartText({ type: "text", text: "hi" }, opts)).toEqual({ kind: "text", text: "hi" })
    expect(extractPartText({ type: "reasoning", text: "hm" }, opts)).toEqual({ kind: "reasoning", text: "hm" })
  })

  test("blank and unknown parts are skipped", () => {
    expect(extractPartText({ type: "text", text: "   " }, opts)).toBeNull()
    expect(extractPartText({ type: "file", url: "x" }, opts)).toBeNull()
    expect(extractPartText(null, opts)).toBeNull()
  })

  test("only completed tool calls are indexed, and output is capped", () => {
    expect(extractPartText({ type: "tool", tool: "bash", state: { status: "running" } }, opts)).toBeNull()
    const r = extractPartText(
      { type: "tool", tool: "bash", state: { status: "completed", title: "ls", output: "x".repeat(500) } },
      opts,
    )
    expect(r!.kind).toBe("tool")
    expect(r!.text.length).toBe(50)
  })

  test("skipTools excludes recall's own output", () => {
    const p = { type: "tool", tool: "recall_search", state: { status: "completed", output: "meta" } }
    expect(extractPartText(p, { ...opts, skipTools: new Set(["recall_search"]) })).toBeNull()
    expect(extractPartText(p, opts)).not.toBeNull()
  })

  test("ansi is stripped from tool output at index time", () => {
    const r = extractPartText(
      { type: "tool", tool: "bash", state: { status: "completed", output: "\u001b[32mok\u001b[0m" } },
      { toolOutputChars: 1000 },
    )
    expect(r!.text).not.toContain("\u001b")
  })
})

// ------------------------------------------------------------- v2 source layer

describe("v2 source layer", () => {
  const EXTRACT = { toolOutputChars: 16_000 }

  test("maps user text, assistant text/reasoning/tool, and roles", () => {
    const db = createSourceDb([
      {
        id: "ses_map",
        messages: [
          { role: "user", parts: [{ type: "text", text: "please check the pods" }] },
          {
            role: "assistant",
            parts: [
              { type: "reasoning", text: "user wants pod status" },
              { type: "tool", tool: "bash", title: "kubectl get pods", output: "kube-proxy Running" },
              { type: "text", text: "all pods are healthy" },
            ],
          },
        ],
      },
    ])
    const source = new Source(db)
    const messages = source.messages("ses_map")
    expect(messages.map((m) => m.role)).toEqual(["user", "assistant"])

    const parts = source.parts("ses_map")
    const extracted = parts.map((p) => extractPartText(parseJson(p.data), EXTRACT)!)
    expect(extracted.map((e) => e.kind)).toEqual(["text", "reasoning", "tool", "text"])
    expect(extracted[0].text).toBe("please check the pods")
    expect(extracted[2].text).toBe("bash kubectl get pods\nkube-proxy Running")
    // Part ids embed the message id and content index so they survive re-derivation.
    expect(parts[2].id).toBe(`${messages[1].id}#1`)
  })

  test("session rows coalesce a null title and resolve ids and slugs", () => {
    const db = createSourceDb([{ id: "ses_t", slug: "sluggy", messages: [] }])
    db.run(`UPDATE session_v2 SET title=NULL WHERE id='ses_t'`)
    const source = new Source(db)
    expect(source.session("ses_t")!.title).toBe("")
    expect(source.findSession("sluggy")[0]?.id).toBe("ses_t")
  })

  test("synthetic messages index as user text but stay out of the outline", () => {
    const db = createSourceDb([
      { id: "ses_syn", messages: [{ role: "user", parts: [{ type: "text", text: "real ask" }] }] },
    ])
    insertV2Message(db, "ses_syn", 1, "synthetic", { time: { created: 2 }, text: "injectedContextToken" }, 2)
    const source = new Source(db)
    const roles = source.messages("ses_syn").map((m) => m.role)
    expect(roles).toEqual(["user", "user"])
    const texts = source.parts("ses_syn").map((p) => extractPartText(parseJson(p.data), EXTRACT)!.text)
    expect(texts).toContain("injectedContextToken")
    expect(source.userTurns("ses_syn").map((t) => t.txt)).toEqual(["real ask"])
  })

  test("tool title falls back to the input's string values when metadata has none", () => {
    const db = createSourceDb([{ id: "ses_ti", messages: [] }])
    insertV2Message(
      db,
      "ses_ti",
      0,
      "assistant",
      {
        time: { created: 5 },
        agent: "build",
        model: { id: "m", providerID: "p" },
        content: [
          {
            type: "tool",
            id: "call_0",
            name: "shell",
            state: {
              status: "completed",
              input: { command: "kubectl get pods -A", workdir: "/tmp" },
              content: [{ type: "text", text: "ok" }],
              metadata: { exit: 0 },
            },
            time: { created: 5 },
          },
        ],
      },
      5,
    )
    const source = new Source(db)
    const [part] = source.parts("ses_ti")
    const extracted = extractPartText(parseJson(part.data), EXTRACT)!
    expect(extracted.text).toBe("shell kubectl get pods -A /tmp\nok")
  })

  test("error and streaming tool states are not indexed", () => {
    const db = createSourceDb([{ id: "ses_err", messages: [] }])
    insertV2Message(
      db,
      "ses_err",
      0,
      "assistant",
      {
        time: { created: 5 },
        agent: "build",
        model: { id: "m", providerID: "p" },
        content: [
          {
            type: "tool",
            id: "call_0",
            name: "shell",
            state: { status: "error", input: {}, error: { type: "tool.execution", message: "boom" } },
            time: { created: 5 },
          },
          { type: "tool", id: "call_1", name: "shell", state: { status: "streaming", input: "{" }, time: { created: 5 } },
          { type: "text", text: "recovered" },
        ],
      },
      5,
    )
    const source = new Source(db)
    const parts = source.parts("ses_err")
    const extracted = parts.map((p) => extractPartText(parseJson(p.data), EXTRACT))
    expect(extracted.filter(Boolean).map((e) => e!.text)).toEqual(["recovered"])
    // The text part keeps its content index even though earlier items were unusable.
    expect(parts[2].id.endsWith("#2")).toBe(true)
  })

  test("compaction summaries are indexed and set the compaction boundary", () => {
    const db = createSourceDb([
      {
        id: "ses_cmp",
        messages: [
          { role: "user", parts: [{ type: "text", text: "before compaction" }] },
          { role: "assistant", parts: [{ type: "text", text: "compactedSummaryToken" }], summary: true },
          { role: "user", parts: [{ type: "text", text: "after compaction" }] },
        ],
      },
    ])
    const source = new Source(db)
    const boundary = source.compactionBoundary("ses_cmp")
    expect(boundary).toBeGreaterThan(0)
    const texts = source.parts("ses_cmp").map((p) => extractPartText(parseJson(p.data), EXTRACT)!.text)
    expect(texts).toContain("compactedSummaryToken")
    // Running/failed compactions carry no summary worth indexing or bounding.
    const db2 = createSourceDb([{ id: "ses_run", messages: [] }])
    insertV2Message(db2, "ses_run", 0, "compaction", { status: "running", reason: "auto", summary: "", recent: "" }, 5)
    const source2 = new Source(db2)
    expect(source2.compactionBoundary("ses_run")).toBe(0)
    expect(source2.parts("ses_run")).toHaveLength(0)
  })

  test("shell and skill messages become searchable tool parts", () => {
    const db = createSourceDb([{ id: "ses_sh", messages: [] }])
    insertV2Message(
      db,
      "ses_sh",
      0,
      "shell",
      {
        shellID: "shl_1",
        command: "kubectl rollout status",
        status: "exited",
        exit: 0,
        output: { output: "deployment rolled out", cursor: 21, size: 21, truncated: false },
        time: { created: 5 },
      },
      5,
    )
    insertV2Message(
      db,
      "ses_sh",
      1,
      "skill",
      { skill: "skl_1", name: "cne-architecture", text: "the CNE skill body", time: { created: 6 } },
      6,
    )
    const source = new Source(db)
    const extracted = source.parts("ses_sh").map((p) => extractPartText(parseJson(p.data), EXTRACT)!)
    expect(extracted[0]).toEqual({ kind: "tool", text: "shell kubectl rollout status\ndeployment rolled out" })
    expect(extracted[1]).toEqual({ kind: "tool", text: "skill cne-architecture\nthe CNE skill body" })
    expect(source.messages("ses_sh").map((m) => m.role)).toEqual(["shell", "skill"])
  })

  test("bookkeeping message types are invisible to recall", () => {
    const db = createSourceDb([{ id: "ses_bk", messages: [] }])
    insertV2Message(db, "ses_bk", 0, "agent-switched", { agent: "build", time: { created: 5 } }, 5)
    insertV2Message(db, "ses_bk", 1, "model-switched", { model: { id: "m", providerID: "p" }, time: { created: 6 } }, 6)
    const source = new Source(db)
    expect(source.messages("ses_bk")).toHaveLength(0)
    expect(source.messageCount("ses_bk")).toBe(0)
    expect(source.parts("ses_bk")).toHaveLength(0)
  })

  test("partData re-derives the exact text parts() produced, for stored-offset stability", () => {
    const db = createSourceDb([
      {
        id: "ses_rt",
        messages: [
          { role: "user", parts: [{ type: "text", text: "round trip" }] },
          {
            role: "assistant",
            parts: [
              { type: "text", text: "answer text" },
              { type: "tool", tool: "grep", title: "pattern", output: "match line" },
            ],
          },
        ],
      },
    ])
    const source = new Source(db)
    for (const part of source.parts("ses_rt")) {
      const fromRow = extractPartText(parseJson(part.data), EXTRACT)
      const fromLookup = extractPartText(source.partData(part.id), EXTRACT)
      expect(fromLookup).toEqual(fromRow)
    }
    expect(source.partData("msg_missing#0")).toBeNull()
    expect(source.partData(`msg_ses_rt_1#99`)).toBeNull()
  })

  test("renderMessage collapses repeated tool calls and trims text", () => {
    const db = createSourceDb([
      {
        id: "ses_rm",
        messages: [
          {
            role: "assistant",
            parts: [
              { type: "tool", tool: "edit", title: "file.ts", output: "ok" },
              { type: "tool", tool: "edit", title: "file.ts", output: "ok" },
              { type: "text", text: "done editing" },
            ],
          },
        ],
      },
    ])
    const source = new Source(db)
    const [m] = source.messages("ses_rm")
    const rendered = source.renderMessage(m, 800)!
    expect(rendered).toContain("[tool edit] file.ts (×2)")
    expect(rendered).toContain("done editing")
    expect(rendered).toContain(m.id)
  })
})

// ------------------------------------------------------- v1 fallback and union

describe("v1 fallback and union", () => {
  test("a v1-only database still works end to end", () => {
    const db = createSourceDbV1([
      { id: "ses_old", messages: [{ role: "user", parts: [{ type: "text", text: "legacy content" }] }] },
    ])
    const source = new Source(db)
    expect(source.allSessions().map((s) => s.id)).toEqual(["ses_old"])
    expect(source.messages("ses_old").map((m) => m.role)).toEqual(["user"])
    const [part] = source.parts("ses_old")
    expect(part.id.startsWith("prt_")).toBe(true)
    expect(extractPartText(source.partData(part.id), { toolOutputChars: 100 })!.text).toBe("legacy content")
  })

  test("legacy-only sessions union into a v2 database and read through v1 tables", () => {
    const db = createSourceDb([
      { id: "ses_new", created: 2_000_000_000_000, messages: [{ role: "user", parts: [{ type: "text", text: "new" }] }] },
    ])
    addV1Session(db, {
      id: "ses_orphan",
      created: 1_600_000_000_000,
      messages: [{ role: "user", parts: [{ type: "text", text: "orphanToken" }] }],
    })
    const source = new Source(db)
    expect(source.allSessions().map((s) => s.id)).toEqual(["ses_new", "ses_orphan"])
    expect(source.sessionCount()).toBe(2)
    expect(source.session("ses_orphan")!.title).toBe("session ses_orphan")
    const parts = source.parts("ses_orphan")
    expect(parts[0].id.startsWith("prt_")).toBe(true)
    expect(source.userTurns("ses_orphan").map((t) => t.txt)).toEqual(["orphanToken"])
  })

  test("a session present in both generations resolves to v2", () => {
    const db = createSourceDb([
      { id: "ses_dup", title: "v2 title", messages: [{ role: "user", parts: [{ type: "text", text: "v2 body" }] }] },
    ])
    addV1Session(db, {
      id: "ses_dup",
      title: "v1 title",
      messages: [
        { role: "user", parts: [{ type: "text", text: "v1 body" }] },
        { role: "assistant", parts: [{ type: "text", text: "v1 answer" }] },
      ],
    })
    const source = new Source(db)
    expect(source.session("ses_dup")!.title).toBe("v2 title")
    expect(source.allSessions()).toHaveLength(1)
    expect(source.messageCount("ses_dup")).toBe(1)
    const texts = source.parts("ses_dup").map((p) => extractPartText(parseJson(p.data), { toolOutputChars: 100 })!.text)
    expect(texts).toEqual(["v2 body"])
  })

  test("legacy prt_ ids from pre-cutover index rows resolve even when the session is migrated", () => {
    // A migrated session lives in v2, but index rows written before the cutover
    // still reference v1 part ids; those must keep resolving for snippets.
    const db = createSourceDb([
      { id: "ses_mig", messages: [{ role: "user", parts: [{ type: "text", text: "v2 body" }] }] },
    ])
    addV1Session(db, { id: "ses_mig", messages: [{ role: "user", parts: [{ type: "text", text: "old body" }] }] })
    const source = new Source(db)
    expect(extractPartText(source.partData("prt_ses_mig_0_0"), { toolOutputChars: 100 })!.text).toBe("old body")
  })

  test("a pure v2 database tolerates legacy part ids", () => {
    const db = createSourceDb([{ id: "ses_v2only", messages: [] }])
    const source = new Source(db)
    expect(source.partData("prt_whatever")).toBeNull()
  })
})

// ------------------------------------------------------------------ fusion

describe("fuse", () => {
  const hit = (session: string, message: string): Hit => ({
    session_id: session,
    message_id: message,
    time: 0,
    via: "lexical/text",
    src: { kind: "part", part_id: message, seg_start: 0, part_kind: "text" },
  })

  test("the per-branch cap bounds how far a flood of weak hits can climb", () => {
    // RRF with K=60 compresses ranks hard (rank 0 scores only ~2x rank 59), so
    // the cap does not make one strong hit beat three decent ones. What it does
    // guarantee is that hits beyond the cap add nothing at all: 20 weak matches
    // in a session score exactly the same as its best 3.
    const flood = (n: number) =>
      fuse([{ hits: Array.from({ length: n }, (_, i) => hit("s2", `m${i}`)), which: "lex" }], (h) => h.session_id, {
        rrfK: 60,
        perBranchCap: 3,
      })[0].score
    expect(flood(20)).toBeCloseTo(flood(3), 12)
    expect(flood(3)).toBeGreaterThan(flood(2))
  })

  test("perBranchCap limits how much one branch can contribute", () => {
    const many = Array.from({ length: 10 }, (_, i) => hit("s1", `m${i}`))
    const capped = fuse([{ hits: many, which: "lex" }], (h) => h.session_id, { rrfK: 60, perBranchCap: 3 })
    const uncapped = fuse([{ hits: many, which: "lex" }], (h) => h.session_id, { rrfK: 60 })
    expect(capped[0].score).toBeLessThan(uncapped[0].score)
    expect(capped[0].nLex).toBe(10) // counted, but not all scored
  })

  test("branch counts are reported separately", () => {
    const out = fuse(
      [
        { hits: [hit("s1", "m1")], which: "lex" },
        { hits: [hit("s1", "m2")], which: "sem" },
      ],
      (h) => h.session_id,
      { rrfK: 60, hitsPerKey: 2 },
    )
    expect(out[0]).toMatchObject({ nLex: 1, nSem: 1 })
    expect(out[0].hits).toHaveLength(2)
  })

  test("hitsPerKey de-duplicates by message", () => {
    const out = fuse(
      [{ hits: [hit("s1", "m1"), hit("s1", "m1"), hit("s1", "m2")], which: "lex" }],
      (h) => h.session_id,
      { rrfK: 60, hitsPerKey: 2 },
    )
    expect(out[0].hits.map((h) => h.message_id)).toEqual(["m1", "m2"])
  })

  test("higher rank contributes more score", () => {
    const out = fuse([{ hits: [hit("a", "1"), hit("b", "2")], which: "lex" }], (h) => h.session_id, { rrfK: 60 })
    expect(out[0].key).toBe("a")
  })
})

// -------------------------------------------------------------- integration

const DIMS = 8

function buildIndexFromDb(src: Database, overrides: Record<string, unknown> = {}) {
  const idx = new Database(":memory:")
  openIndex(idx)
  const { config } = loadConfig(
    {},
    () => JSON.stringify({ embed: { dims: DIMS }, fts: { segmentChars: 300, toolOutputChars: 400 }, ...overrides }),
    "/home/t",
  )
  migrate(idx, "test:8", () => 0)
  const source = new Source(src)
  const embedder = createFakeEmbedder(DIMS)
  const exclusions = new DirectoryExclusions(config.index.excludeDirectories, "/home/t")
  const indexer = new Indexer({
    idx,
    source,
    embedder,
    config,
    exclusions,
    log: () => {},
    skipTools: new Set(["recall_search"]),
    workerPrefix: WORKER_PREFIX,
  })
  const searcher = new SearchIndex(idx, source, embedder, config, () => {})
  return { src, idx, source, indexer, searcher, config, exclusions }
}

function buildIndex(sessions: FixtureSession[], overrides: Record<string, unknown> = {}) {
  return buildIndexFromDb(createSourceDb(sessions), overrides)
}

const NO_FILTER: Filters = {
  since: 0,
  until: Number.MAX_SAFE_INTEGER,
  includeTools: true,
  excludeBefore: 0,
}

describe("indexing and search", () => {
  test("round trip: index, find lexically, snippet from source", async () => {
    const { indexer, searcher } = buildIndex([
      {
        id: "ses_a",
        title: "cilium upgrade",
        messages: [
          { role: "user", parts: [{ type: "text", text: "should we upgrade cilium on the mgmt cluster?" }] },
          { role: "assistant", parts: [{ type: "text", text: "yes, pin it to 1.16.4 first" }] },
        ],
      },
    ])
    await indexer.indexSession("ses_a")
    const hits = searcher.lexical("cilium", NO_FILTER)
    expect(hits.length).toBeGreaterThan(0)
    const snips = searcher.snippets(hits.slice(0, 1), "cilium")
    expect([...snips.values()][0]).toContain("«cilium»")
  })

  test("tool output is searchable and can be excluded", async () => {
    const { indexer, searcher } = buildIndex([
      {
        id: "ses_t",
        messages: [
          { role: "user", parts: [{ type: "text", text: "check the pods" }] },
          {
            role: "assistant",
            parts: [{ type: "tool", tool: "bash", title: "kubectl", output: "kube-proxy CrashLoopBackOff" }],
          },
        ],
      },
    ])
    await indexer.indexSession("ses_t")
    expect(searcher.lexical("CrashLoopBackOff", NO_FILTER)).toHaveLength(1)
    expect(searcher.lexical("CrashLoopBackOff", { ...NO_FILTER, includeTools: false })).toHaveLength(0)
  })

  test("reasoning is searchable", async () => {
    const { indexer, searcher } = buildIndex([
      {
        id: "ses_r",
        messages: [
          { role: "user", parts: [{ type: "text", text: "hi" }] },
          { role: "assistant", parts: [{ type: "reasoning", text: "the user probably wants idempotency" }] },
        ],
      },
    ])
    await indexer.indexSession("ses_r")
    expect(searcher.lexical("idempotency", NO_FILTER)).toHaveLength(1)
  })

  test("recall's own tool output is never indexed", async () => {
    const { indexer, searcher } = buildIndex([
      {
        id: "ses_m",
        messages: [
          { role: "user", parts: [{ type: "text", text: "search" }] },
          { role: "assistant", parts: [{ type: "tool", tool: "recall_search", output: "unmistakableToken" }] },
        ],
      },
    ])
    await indexer.indexSession("ses_m")
    expect(searcher.lexical("unmistakableToken", NO_FILTER)).toHaveLength(0)
  })

  test("summarizer worker sessions are never indexed", async () => {
    const { indexer, idx } = buildIndex([
      {
        id: "ses_w",
        title: `${WORKER_PREFIX}ses_other`,
        messages: [{ role: "user", parts: [{ type: "text", text: "transcript goes here" }] }],
      },
    ])
    await indexer.indexSession("ses_w")
    expect(idx.query(`SELECT count(*) c FROM parts`).get()).toEqual({ c: 0 })
  })

  test("long parts are segmented rather than truncated", async () => {
    const needle = "buriedNeedleToken"
    const long = "padding ".repeat(400) + needle + " tail"
    const { indexer, searcher, idx } = buildIndex([
      { id: "ses_l", messages: [{ role: "user", parts: [{ type: "text", text: long }] }] },
    ])
    await indexer.indexSession("ses_l")
    // segmentChars is 300 in the test config, so this is many rows for one part.
    expect((idx.query(`SELECT count(*) c FROM parts`).get() as { c: number }).c).toBeGreaterThan(5)
    const hits = searcher.lexical(needle, NO_FILTER)
    expect(hits).toHaveLength(1)
    // The snippet is regenerated from the source using the stored segment offset.
    expect([...searcher.snippets(hits, needle).values()][0]).toContain(`«${needle}»`)
  })

  test("a long assistant turn is embedded in full, not truncated to its first 900 chars", async () => {
    const tail = "conclusionSentinel"
    const body = Array.from({ length: 600 }, (_, i) => `sentence number ${i} about deployment`).join(". ")
    const { indexer, idx } = buildIndex([
      {
        id: "ses_c",
        messages: [
          { role: "user", parts: [{ type: "text", text: "explain the rollout" }] },
          { role: "assistant", parts: [{ type: "text", text: `${body}. ${tail}` }] },
        ],
      },
    ])
    await indexer.indexSession("ses_c")
    const chunks = idx.query(`SELECT text FROM chunks`).all() as { text: string }[]
    expect(chunks.length).toBeGreaterThan(5)
    expect(chunks.some((c) => c.text.includes(tail))).toBe(true)
    // Every chunk after the first is re-anchored to the user's intent.
    expect(chunks.slice(1).every((c) => c.text.startsWith("(re: "))).toBe(true)
  })

  test("filters are applied before the BM25 cut, not after it", async () => {
    // 40 sessions all matching 'deploy', one of them in a distinct directory.
    // A post-filter over a fixed top-N would return nothing for the directory
    // query whenever the target's rows fall outside that N.
    const sessions: FixtureSession[] = Array.from({ length: 40 }, (_, i) => ({
      id: `ses_bulk${i}`,
      directory: "/Users/test/Projects/noise",
      messages: [{ role: "user", parts: [{ type: "text", text: `deploy the thing number ${i}` }] }],
    }))
    sessions.push({
      id: "ses_target",
      directory: "/Users/test/Projects/infrastructure",
      created: 1_600_000_000_000,
      messages: [
        {
          role: "user",
          parts: [{ type: "text", text: "deploy " + "filler ".repeat(300) + " the infrastructure rollout" }],
        },
      ],
    })
    const { indexer, searcher } = buildIndex(sessions, { search: { candidates: 5, rrfK: 60, inspectSemMin: 0.55 } })
    for (const s of sessions) await indexer.indexSession(s.id)

    const unfiltered = searcher.lexical("deploy", NO_FILTER)
    expect(unfiltered).toHaveLength(5)
    expect(unfiltered.some((h) => h.session_id === "ses_target")).toBe(false) // buried by BM25

    const filtered = searcher.lexical("deploy", { ...NO_FILTER, directory: "infrastructure" })
    expect(filtered.map((h) => h.session_id)).toEqual(["ses_target"])
  })

  test("date filters are applied in SQL too", async () => {
    const sessions: FixtureSession[] = Array.from({ length: 20 }, (_, i) => ({
      id: `ses_d${i}`,
      created: 1_700_000_000_000 + i * 86_400_000,
      messages: [{ role: "user", parts: [{ type: "text", text: "recurring topic" }] }],
    }))
    const { indexer, searcher } = buildIndex(sessions, { search: { candidates: 3, rrfK: 60, inspectSemMin: 0.55 } })
    for (const s of sessions) await indexer.indexSession(s.id)
    const late = searcher.lexical("recurring", { ...NO_FILTER, since: 1_700_000_000_000 + 18 * 86_400_000 })
    expect(late.length).toBeGreaterThan(0)
    expect(late.every((h) => h.session_id === "ses_d18" || h.session_id === "ses_d19")).toBe(true)
  })

  test("the calling session is excluded only after its compaction boundary", async () => {
    const { indexer, searcher, source } = buildIndex([
      {
        id: "ses_self",
        messages: [
          { role: "user", parts: [{ type: "text", text: "earlyUniqueToken before compaction" }] },
          { role: "assistant", parts: [{ type: "text", text: "ack" }], summary: true },
          { role: "user", parts: [{ type: "text", text: "lateUniqueToken after compaction" }] },
        ],
      },
    ])
    await indexer.indexSession("ses_self")
    const boundary = source.compactionBoundary("ses_self")
    expect(boundary).toBeGreaterThan(0)
    const f = { ...NO_FILTER, excludeSession: "ses_self", excludeBefore: boundary }
    expect(searcher.lexical("earlyUniqueToken", f)).toHaveLength(1)
    expect(searcher.lexical("lateUniqueToken", f)).toHaveLength(0)
  })

  test("an uncompacted calling session is excluded entirely", async () => {
    const { indexer, searcher } = buildIndex([
      { id: "ses_now", messages: [{ role: "user", parts: [{ type: "text", text: "visibleToken" }] }] },
    ])
    await indexer.indexSession("ses_now")
    expect(
      searcher.lexical("visibleToken", { ...NO_FILTER, excludeSession: "ses_now", excludeBefore: 0 }),
    ).toHaveLength(0)
  })

  test("reindex is idempotent and reuses embeddings", async () => {
    const { indexer, idx } = buildIndex([
      {
        id: "ses_i",
        messages: [{ role: "user", parts: [{ type: "text", text: "stable content" }] }],
      },
    ])
    await indexer.indexSession("ses_i")
    const before = idx.query(`SELECT count(*) c FROM parts`).get() as { c: number }
    const embBefore = idx.query(`SELECT hash FROM chunks ORDER BY hash`).all()
    // Force a rebuild by moving the source watermark forward.
    idx.run(`UPDATE indexed_sessions SET time_updated = 0 WHERE session_id='ses_i'`)
    await indexer.indexSession("ses_i")
    expect(idx.query(`SELECT count(*) c FROM parts`).get()).toEqual(before)
    expect(idx.query(`SELECT hash FROM chunks ORDER BY hash`).all()).toEqual(embBefore)
  })

  test("watermark short-circuits an unchanged session", async () => {
    const { indexer, idx } = buildIndex([
      { id: "ses_wm", messages: [{ role: "user", parts: [{ type: "text", text: "hello" }] }] },
    ])
    await indexer.indexSession("ses_wm")
    const sig = idx.query(`SELECT count(*) c, max(id) m FROM parts`).get()
    await indexer.indexSession("ses_wm")
    expect(idx.query(`SELECT count(*) c, max(id) m FROM parts`).get()).toEqual(sig)
  })

  test("purge removes fts rows, chunks and metadata together", async () => {
    const { indexer, idx, searcher } = buildIndex([
      { id: "ses_p", messages: [{ role: "user", parts: [{ type: "text", text: "purgeMeToken" }] }] },
    ])
    await indexer.indexSession("ses_p")
    expect(searcher.lexical("purgeMeToken", NO_FILTER)).toHaveLength(1)
    indexer.purge("ses_p")
    expect(searcher.lexical("purgeMeToken", NO_FILTER)).toHaveLength(0)
    for (const t of ["parts", "chunks", "indexed_sessions"]) {
      expect(idx.query(`SELECT count(*) c FROM ${t}`).get()).toEqual({ c: 0 })
    }
  })

  test("backfill indexes everything and prunes deleted sessions", async () => {
    const { indexer, idx, src } = buildIndex([
      { id: "ses_x", messages: [{ role: "user", parts: [{ type: "text", text: "alpha" }] }] },
      { id: "ses_y", messages: [{ role: "user", parts: [{ type: "text", text: "beta" }] }] },
    ])
    await indexer.backfill()
    expect(idx.query(`SELECT count(*) c FROM indexed_sessions`).get()).toEqual({ c: 2 })
    src.run(`DELETE FROM session_v2 WHERE id='ses_y'`)
    await indexer.backfill()
    expect(idx.query(`SELECT session_id FROM indexed_sessions`).all()).toEqual([{ session_id: "ses_x" }])
  })

  test("a legacy v1-only session is indexed through the union source", async () => {
    const src = createSourceDb([
      { id: "ses_new", messages: [{ role: "user", parts: [{ type: "text", text: "modernToken" }] }] },
    ])
    addV1Session(src, {
      id: "ses_orphan",
      messages: [
        { role: "user", parts: [{ type: "text", text: "orphanLegacyToken" }] },
        { role: "assistant", parts: [{ type: "tool", tool: "bash", title: "ls", output: "orphanToolToken" }] },
      ],
    })
    const { indexer, searcher, idx } = buildIndexFromDb(src)
    await indexer.backfill()
    expect(idx.query(`SELECT count(*) c FROM indexed_sessions`).get()).toEqual({ c: 2 })
    const hits = searcher.lexical("orphanLegacyToken", NO_FILTER)
    expect(hits).toHaveLength(1)
    expect(hits[0].session_id).toBe("ses_orphan")
    // Snippets for legacy hits resolve through the v1 part table.
    expect([...searcher.snippets(hits, "orphanLegacyToken").values()][0]).toContain("«orphanLegacyToken»")
    expect(searcher.lexical("orphanToolToken", NO_FILTER)).toHaveLength(1)
  })

  test("excluded directories are never indexed and are purged with cached summaries", async () => {
    const { indexer, idx, source, config, exclusions } = buildIndex([
      {
        id: "ses_allowed",
        directory: "/home/t/Projects/allowed",
        messages: [{ role: "user", parts: [{ type: "text", text: "allowed" }] }],
      },
      {
        id: "ses_private",
        directory: "/home/t/Projects/private/child",
        messages: [{ role: "user", parts: [{ type: "text", text: "private" }] }],
      },
    ])
    await indexer.backfill()
    idx.run(
      `INSERT INTO summaries(session_id,model,focus,time_updated,summary,created) VALUES ('ses_private','m','',1,'secret',1)`,
    )
    exclusions.update(["~/Projects/private"])
    expect(indexer.reconcileExclusions()).toBe(1)
    await indexer.indexSession("ses_private")
    expect(idx.query(`SELECT session_id FROM indexed_sessions ORDER BY session_id`).all()).toEqual([
      { session_id: "ses_allowed" },
    ])
    expect(idx.query(`SELECT count(*) c FROM summaries`).get()).toEqual({ c: 0 })

    const summarizer = new Summarizer({
      idx,
      source,
      config,
      exclusions,
      sessions: {
        create: async () => ({ id: "ses_worker" }),
        get: async () => ({}),
        generate: async () => ({ text: "" }),
      },
      home: "/home/t",
      log: () => {},
    })
    await expect(summarizer.summarize(source.session("ses_private")!, "", false)).rejects.toThrow(
      "session is excluded",
    )
  })

  test("backfill defers to a held lease", async () => {
    const { indexer, idx } = buildIndex([
      { id: "ses_z", messages: [{ role: "user", parts: [{ type: "text", text: "gamma" }] }] },
    ])
    const other = new BackfillLease(idx, 60_000)
    expect(other.tryAcquire()).toBe(true)
    await indexer.backfill(new BackfillLease(idx, 60_000))
    expect(indexer.state.skippedLocked).toBe(true)
    expect(idx.query(`SELECT count(*) c FROM indexed_sessions`).get()).toEqual({ c: 0 })
    other.release()
    await indexer.backfill(new BackfillLease(idx, 60_000))
    expect(idx.query(`SELECT count(*) c FROM indexed_sessions`).get()).toEqual({ c: 1 })
  })

  test("semantic search ranks and respects the session filter", async () => {
    const { indexer, searcher } = buildIndex([
      { id: "ses_s1", messages: [{ role: "user", parts: [{ type: "text", text: "kubernetes ingress routing" }] }] },
      { id: "ses_s2", messages: [{ role: "user", parts: [{ type: "text", text: "sourdough bread starter" }] }] },
    ])
    await indexer.indexSession("ses_s1")
    await indexer.indexSession("ses_s2")
    const all = await searcher.semantic("kubernetes ingress routing", NO_FILTER)
    expect(all[0].session_id).toBe("ses_s1")
    const scoped = await searcher.semantic("kubernetes ingress routing", { ...NO_FILTER, sessionId: "ses_s2" })
    expect(scoped.every((h) => h.session_id === "ses_s2")).toBe(true)
  })

  test("matrix signature changes whenever chunk contents could have changed", async () => {
    const { indexer, searcher, idx } = buildIndex([
      { id: "ses_sig", messages: [{ role: "user", parts: [{ type: "text", text: "one" }] }] },
      { id: "ses_sig2", messages: [{ role: "user", parts: [{ type: "text", text: "two" }] }] },
    ])
    await indexer.indexSession("ses_sig")
    await indexer.indexSession("ses_sig2")
    const sig = searcher.matrixSignature()
    // Delete one chunk and insert a different one: count returns to its old
    // value, but AUTOINCREMENT guarantees max(id) moved.
    const victim = idx.query(`SELECT id FROM chunks ORDER BY id LIMIT 1`).get() as { id: number }
    idx.run(`DELETE FROM chunks WHERE id=?`, [victim.id])
    idx.run(`INSERT INTO chunks(session_id,message_id,time,hash,text,emb)
             VALUES ('ses_sig','m',1,'h','other', zeroblob(?))`, [DIMS * 4])
    expect(searcher.matrixSignature()).not.toBe(sig)
  })

  test("a query with no lexical match falls back from AND to OR", async () => {
    const { indexer, searcher } = buildIndex([
      { id: "ses_f", messages: [{ role: "user", parts: [{ type: "text", text: "the terraform state was locked" }] }] },
    ])
    await indexer.indexSession("ses_f")
    expect(searcher.lexical("terraform locked", NO_FILTER)).toHaveLength(1)
    // 'kubernetes' is absent, so AND finds nothing and OR rescues the query.
    expect(searcher.lexical("terraform kubernetes", NO_FILTER).length).toBeGreaterThan(0)
    expect(searcher.lexical("absolutelyNoSuchToken", NO_FILTER)).toHaveLength(0)
  })

  test("a hostile query cannot break the FTS parser", async () => {
    const { indexer, searcher } = buildIndex([
      { id: "ses_h", messages: [{ role: "user", parts: [{ type: "text", text: "normal content" }] }] },
    ])
    await indexer.indexSession("ses_h")
    for (const q of ['" OR 1=1 --', "NEAR(a b", "*", "^^^", "content AND"]) {
      expect(() => searcher.lexical(q, NO_FILTER)).not.toThrow()
    }
  })

  test("a missing source message degrades the snippet instead of throwing", async () => {
    const { indexer, searcher, src } = buildIndex([
      { id: "ses_g", messages: [{ role: "user", parts: [{ type: "text", text: "ghostToken" }] }] },
    ])
    await indexer.indexSession("ses_g")
    const hits = searcher.lexical("ghostToken", NO_FILTER)
    src.run(`DELETE FROM session_message`)
    expect([...searcher.snippets(hits, "ghostToken").values()][0]).toContain("no longer available")
  })
})

// ------------------------------------------------------------------ summarize

describe("Summarizer", () => {
  const stubSessions = (calls: { create: number; generate: number }, workerId = "ses_worker1"): SessionClient => ({
    create: async () => {
      calls.create++
      return { id: workerId }
    },
    get: async ({ sessionID }) => {
      if (sessionID !== workerId) throw new Error("session not found")
      return {}
    },
    generate: async ({ prompt }) => {
      calls.generate++
      expect(prompt).toContain("TRANSCRIPT:")
      return { text: "the digested summary" }
    },
  })

  const build = () =>
    buildIndex([
      {
        id: "ses_sum",
        messages: [
          { role: "user", parts: [{ type: "text", text: "how do we deploy?" }] },
          { role: "assistant", parts: [{ type: "text", text: "with argocd, obviously" }] },
        ],
      },
    ])

  test("generates through a reusable worker session and caches the result", async () => {
    const { idx, source, config, exclusions } = build()
    const calls = { create: 0, generate: 0 }
    const deps = { idx, source, config, exclusions, sessions: stubSessions(calls), home: "/home/t", log: () => {} }
    const summarizer = new Summarizer(deps)
    const s = source.session("ses_sum")!

    const fresh = await summarizer.summarize(s, "", false)
    expect(fresh.summary).toBe("the digested summary")
    expect(fresh.cachedAt).toBeUndefined()
    expect(calls).toEqual({ create: 1, generate: 1 })
    // The worker session id is remembered in the sidecar for reuse across restarts.
    expect(getMeta(idx, `summary_worker:${summarizer.modelTag}`)).toBe("ses_worker1")

    const cached = await summarizer.summarize(s, "", false)
    expect(cached.cachedAt).toBeGreaterThan(0)
    expect(calls.generate).toBe(1)

    // A different focus is a different cache key but reuses the same worker.
    const focused = await summarizer.summarize(s, "what tool deploys?", false)
    expect(focused.summary).toBe("the digested summary")
    expect(calls).toEqual({ create: 1, generate: 2 })

    // A second instance (fresh process) revalidates the stored worker instead of creating one.
    const again = new Summarizer(deps)
    await again.summarize(s, "", true)
    expect(calls.create).toBe(1)
  })

  test("recreates the worker session when the stored one is gone", async () => {
    const { idx, source, config, exclusions } = build()
    const calls = { create: 0, generate: 0 }
    setMeta(idx, `summary_worker:${summaryModelTag({ summary: { model: config.summary.model } })}`, "ses_deleted")
    const summarizer = new Summarizer({
      idx,
      source,
      config,
      exclusions,
      sessions: stubSessions(calls),
      home: "/home/t",
      log: () => {},
    })
    const r = await summarizer.summarize(source.session("ses_sum")!, "", false)
    expect(r.summary).toBe("the digested summary")
    expect(calls.create).toBe(1)
    expect(getMeta(idx, `summary_worker:${summarizer.modelTag}`)).toBe("ses_worker1")
  })

  test("is unavailable without a session client", () => {
    const { idx, source, config, exclusions } = build()
    const summarizer = new Summarizer({ idx, source, config, exclusions, sessions: null, home: "/home/t", log: () => {} })
    expect(summarizer.available).toBe(false)
  })
})

describe("pool", () => {
  test("preserves order and bounds concurrency", async () => {
    let active = 0
    let peak = 0
    const out = await pool([1, 2, 3, 4, 5, 6, 7], 3, async (n) => {
      active++
      peak = Math.max(peak, active)
      await Bun.sleep(5)
      active--
      return n * 2
    })
    expect(out).toEqual([2, 4, 6, 8, 10, 12, 14])
    expect(peak).toBeLessThanOrEqual(3)
  })
})
