import { execFileSync } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import path from "node:path"
import type { Plugin, PluginOptions } from "@opencode-ai/plugin"
import { tool } from "@opencode-ai/plugin"

type GuardOptions = PluginOptions & {
  protected?: string[]
  allowEnvKeyListingFor?: string[]
  blockCopy?: boolean
}

type Match = {
  path: string
  pattern: string
  abs: string
}

type BashDecision =
  | { blocked: false }
  | { blocked: true; correction: string; reason: string }
  | { blocked: true; match: Match; reason: string }

// Narrow, intent-specific patterns. Broader substring globs like `**/*secret*`
// and `**/*credential*` are intentionally NOT here because they generate too
// many false positives (Helm ExternalSecret templates, docs, test fixtures,
// search keywords, branch names, etc.). Real raw Secret manifests are caught
// by content sniffing instead.
const DEFAULT_PROTECTED = [
  // dotenv files (.env.example is allowlisted separately)
  ".env",
  ".env.*",
  "**/.env",
  "**/.env.*",
  // SSH / TLS private keys (*.pub is allowlisted separately)
  "**/id_rsa",
  "**/id_dsa",
  "**/id_ecdsa",
  "**/id_ed25519",
  "**/*.pem",
  "**/*.pfx",
  "**/*.p12",
  "**/*.jks",
  // package-manager / language credential files
  "**/.netrc",
  "**/.npmrc",
  "**/.pypirc",
  // cloud / k8s credential files
  "**/.aws/credentials",
  "**/kubeconfig",
  "**/*.kubeconfig",
  "**/service-account*.json",
]

const DEFAULT_ENV_KEY_LISTING = [".env", ".env.*", "**/.env", "**/.env.*"]

const PATH_ARG_KEYS = new Set(["path", "file", "filepath", "filePath"])

const READ_COMMANDS = new Set([
  "awk",
  "base64",
  "cat",
  "grep",
  "head",
  "hexdump",
  "jq",
  "less",
  "more",
  "nl",
  "od",
  "rg",
  "sed",
  "strings",
  "tac",
  "tail",
  "xxd",
  "yq",
])

const COPY_COMMANDS = new Set(["cp", "mv", "install", "rsync", "scp"])
const ARCHIVE_COMMANDS = new Set(["tar", "zip", "gzip", "bzip2", "xz", "7z"])
const ENV_DUMP_COMMANDS = new Set(["env", "printenv", "set", "export", "declare"])

const SOURCE_RE = /(?:^|[;&|]\s*)(?:source|\.)\s+(["']?[^\s;&|"']+["']?)/g
const INTERPRETER_READ_RE = /\b(?:python\d*|node|ruby|perl|php|bun|deno)\b[\s\S]*\b(?:open|readFileSync|readFile|File\.read|IO\.read|file_get_contents)\s*\(/i
const SHELL_LIST_ENV_KEYS_RE = /(?:^|[;&|()]\s*)list_env_keys(?:\s|$)/

// Used by protectedRawMatch to detect protected files embedded inside larger
// non-token-shaped command fragments (stdin redirects, interpreter strings,
// curl @uploads). Narrow on purpose — token-level matching handles plain CLI
// arguments. Bare words like "secret", "credential", or "kubeconfig" must NOT
// match here, or grep patterns and English fragments trigger false positives.
const EMBEDDED_PROTECTED_RE = /@?[A-Za-z0-9_./~:\\-]*?\.env(?:\.[A-Za-z0-9_.-]+)?(?![A-Za-z0-9_])/gi

function shellBase(command: string): string {
  return path.basename(command).toLowerCase()
}

function escapeRegExp(value: string): string {
  return value.replace(/[|\\{}()[\]^$+?.]/g, "\\$&")
}

function globToRegExp(glob: string): RegExp {
  let out = "^"
  for (let i = 0; i < glob.length; i++) {
    const char = glob[i]
    const next = glob[i + 1]
    if (char === "*" && next === "*") {
      out += ".*"
      i++
    } else if (char === "*") {
      out += "[^/]*"
    } else if (char === "?") {
      out += "[^/]"
    } else {
      out += escapeRegExp(char)
    }
  }
  return new RegExp(out + "$")
}

function stripOuterQuotes(value: string): string {
  const trimmed = value.trim()
  if (trimmed.length < 2) return trimmed
  const first = trimmed[0]
  const last = trimmed[trimmed.length - 1]
  if ((first === "'" && last === "'") || (first === '"' && last === '"')) {
    return trimmed.slice(1, -1)
  }
  return trimmed
}

function cleanPathToken(token: string): string | undefined {
  let cleaned = stripOuterQuotes(token.trim())
  if (/^[A-Za-z_][A-Za-z0-9_-]*=@/.test(cleaned)) cleaned = cleaned.slice(cleaned.indexOf("=@") + 1)
  cleaned = cleaned.replace(/^@/, "")
  cleaned = cleaned.replace(/^[<>{}(),]+|[<>{}(),]+$/g, "")
  cleaned = stripOuterQuotes(cleaned)
  if (!cleaned || cleaned.startsWith("-") || cleaned.includes("$")) return undefined
  if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(cleaned)) return undefined
  return cleaned
}

function normalizeForDisplay(abs: string, directory: string): string {
  const rel = path.relative(directory, abs)
  if (!rel.startsWith("..") && !path.isAbsolute(rel)) return rel || "."
  return abs
}

function pathCandidates(abs: string, directory: string, worktree: string): string[] {
  const candidates = new Set<string>()
  const basename = path.basename(abs)
  candidates.add(basename)
  for (const root of [directory, worktree]) {
    const rel = path.relative(root, abs)
    candidates.add(rel || basename)
  }
  candidates.add(abs)
  return [...candidates].map((candidate) => candidate.replaceAll(path.sep, "/"))
}

function matchesGlob(pattern: string, candidate: string): boolean {
  if (globToRegExp(pattern).test(candidate)) return true
  if (pattern.startsWith("**/") && globToRegExp(pattern.slice(3)).test(candidate)) return true
  return false
}

// A token is "path-shaped" if it contains a path separator, a dot, a leading
// dot (dotfile), or a leading @ (curl upload). Bare identifiers like "secret"
// or "kubeconfig" are NOT path-shaped and would only be treated as paths if
// they happen to exist as actual files on disk (the existsSync fallback).
function looksLikePath(token: string): boolean {
  return /[./~]|\\|\//.test(token)
}

function matchProtectedPath(
  rawPath: string,
  directory: string,
  worktree: string,
  patterns: string[],
): Match | undefined {
  const cleaned = cleanPathToken(rawPath)
  if (!cleaned) return undefined
  const abs = path.resolve(path.isAbsolute(cleaned) ? cleaned : path.join(directory, cleaned))

  // Path-shape gate: a bare word like "secret" or "credentials" is only
  // considered a candidate path if it actually exists on disk. Without this
  // gate, grep patterns and English fragments trigger false positives.
  if (!looksLikePath(cleaned) && !existsSync(abs)) return undefined

  const candidates = pathCandidates(abs, directory, worktree)

  for (const pattern of patterns) {
    const normalizedPattern = pattern.replaceAll(path.sep, "/")
    const basenameOnly = !normalizedPattern.includes("/")
    for (const candidate of candidates) {
      const value = basenameOnly ? path.posix.basename(candidate) : candidate
      if (matchesGlob(normalizedPattern, value)) {
        return { path: normalizeForDisplay(abs, directory), pattern, abs }
      }
    }
  }

  return undefined
}

function stripShellComments(command: string): string {
  let result = ""
  let quote: string | undefined
  let escaped = false

  for (const char of command) {
    if (escaped) {
      result += char
      escaped = false
      continue
    }
    if (char === "\\") {
      result += char
      escaped = true
      continue
    }
    if (quote) {
      result += char
      if (char === quote) quote = undefined
      continue
    }
    if (char === "'" || char === '"') {
      quote = char
      result += char
      continue
    }
    if (char === "#") break
    result += char
  }

  return result
}

function tokenize(command: string): string[] {
  const tokens: string[] = []
  let current = ""
  let quote: string | undefined
  let escaped = false

  function push() {
    if (!current) return
    tokens.push(current)
    current = ""
  }

  for (const char of stripShellComments(command)) {
    if (escaped) {
      current += char
      escaped = false
      continue
    }
    if (char === "\\") {
      escaped = true
      continue
    }
    if (quote) {
      if (char === quote) quote = undefined
      else current += char
      continue
    }
    if (char === "'" || char === '"') {
      quote = char
      continue
    }
    if (/\s/.test(char)) {
      push()
      continue
    }
    if (";&|()<>".includes(char)) {
      push()
      tokens.push(char)
      continue
    }
    current += char
  }

  push()
  return tokens
}

function commandSegments(tokens: string[]): string[][] {
  const segments: string[][] = []
  let current: string[] = []
  for (const token of tokens) {
    if ([";", "&", "|", "(" , ")"].includes(token)) {
      if (current.length) segments.push(current)
      current = []
      continue
    }
    current.push(token)
  }
  if (current.length) segments.push(current)
  return segments
}

function firstCommand(segment: string[]): string | undefined {
  for (let index = 0; index < segment.length; index++) {
    const token = segment[index]
    if (!token || token === "<" || token === ">") continue
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(token)) continue
    if (token === "command" || token === "builtin") continue
    if (token === "env") {
      const hasWrappedCommand = segment.slice(index + 1).some((entry) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(entry) && !entry.startsWith("-"))
      if (hasWrappedCommand) continue
      return "env"
    }
    return shellBase(token)
  }
  return undefined
}

function protectedTokenMatch(
  tokens: string[],
  directory: string,
  worktree: string,
  patterns: string[],
): Match | undefined {
  for (const token of tokens) {
    const match = matchProtectedPath(token, directory, worktree, patterns)
    if (match) return match
  }
  return undefined
}

function protectedRawMatch(
  command: string,
  directory: string,
  worktree: string,
  patterns: string[],
): Match | undefined {
  const rawTokens = command.match(EMBEDDED_PROTECTED_RE) ?? []
  return protectedTokenMatch(rawTokens, directory, worktree, patterns)
}

function sourcedProtectedEnvFiles(
  command: string,
  directory: string,
  worktree: string,
  patterns: string[],
): Match[] {
  const matches: Match[] = []
  for (const sourceMatch of command.matchAll(SOURCE_RE)) {
    const file = sourceMatch[1]
    const match = file ? matchProtectedPath(file, directory, worktree, patterns) : undefined
    if (match) matches.push(match)
  }
  return matches
}

function sourceFollowedByDump(tokens: string[]): boolean {
  const sourceIndex = tokens.findIndex((token) => token === "source" || token === ".")
  if (sourceIndex === -1) return false
  const rest = tokens.slice(sourceIndex + 2)
  for (const segment of commandSegments(rest)) {
    const command = firstCommand(segment)
    if (!command) continue
    if (!ENV_DUMP_COMMANDS.has(command)) continue
    if (command === "set") {
      if (segment.length === 1) return true
      continue
    }
    if (command === "export" || command === "declare") {
      if (segment.length === 1 || segment.includes("-p")) return true
      continue
    }
    return true
  }
  return false
}

function tokenContainsShellVariable(token: string): boolean {
  return /\$(?:[A-Za-z_][A-Za-z0-9_]*|\{[A-Za-z_][A-Za-z0-9_]*\})/.test(token)
}

function sourceFollowedByVariablePrint(tokens: string[]): boolean {
  const sourceIndex = tokens.findIndex((token) => token === "source" || token === ".")
  if (sourceIndex === -1) return false
  const rest = tokens.slice(sourceIndex + 2)

  for (const segment of commandSegments(rest)) {
    const command = firstCommand(segment)
    if (command !== "echo" && command !== "printf") continue
    if (segment.some(tokenContainsShellVariable)) return true
  }

  return false
}

export function analyzeBashCommand(
  command: string,
  directory: string,
  worktree: string,
  patterns = DEFAULT_PROTECTED,
  blockCopy = true,
  isExempt: (abs: string) => boolean = defaultBashExempt,
): BashDecision {
  if (SHELL_LIST_ENV_KEYS_RE.test(command)) {
    return {
      blocked: true,
      correction:
        "list_env_keys is an OpenCode tool, not a shell command. Call the list_env_keys tool directly with a path argument, for example path: .env.",
      reason: "list_env_keys invoked as shell command",
    }
  }

  const tokens = tokenize(command)
  const sourced = sourcedProtectedEnvFiles(command, directory, worktree, patterns)
  if (sourced.length > 0) {
    if (sourceFollowedByDump(tokens)) return { blocked: true, match: sourced[0], reason: "env dump after sourcing" }
    if (sourceFollowedByVariablePrint(tokens)) return { blocked: true, match: sourced[0], reason: "variable print after sourcing" }
  }

  const rawMatch = protectedRawMatch(command, directory, worktree, patterns)
  for (const segment of commandSegments(tokens)) {
    const commandName = firstCommand(segment)
    const segmentMatch = protectedTokenMatch(segment, directory, worktree, patterns)
    if (!commandName || !segmentMatch) continue
    if (isExempt(segmentMatch.abs)) continue

    if (READ_COMMANDS.has(commandName)) {
      return { blocked: true, match: segmentMatch, reason: `${commandName} can disclose file contents` }
    }
    if (ARCHIVE_COMMANDS.has(commandName)) return { blocked: true, match: segmentMatch, reason: `${commandName} can package file contents` }
    if (blockCopy && COPY_COMMANDS.has(commandName)) return { blocked: true, match: segmentMatch, reason: `${commandName} can move protected contents out of policy` }
    if (commandName === "curl" && segment.some((token) => /(?:^|=)@/.test(token))) return { blocked: true, match: segmentMatch, reason: "curl file upload" }
  }

  if (rawMatch && !isExempt(rawMatch.abs)) {
    if (/<\s*["']?[^\s;&|"']*\.env/i.test(command) && /\b(?:read|echo|printf|cat|sed|awk|grep|while)\b/.test(command)) {
      return { blocked: true, match: rawMatch, reason: "stdin redirection from protected file" }
    }
    if (/[;&|]\s*(?:echo|printf)\b[\s\S]*\$\(<\s*/.test(command)) return { blocked: true, match: rawMatch, reason: "shell read substitution" }
    if (INTERPRETER_READ_RE.test(command)) return { blocked: true, match: rawMatch, reason: "interpreter file read" }
    if (/@["']?[^\s;&|"']*\.env/i.test(command)) return { blocked: true, match: rawMatch, reason: "file upload/include syntax" }
  }

  return { blocked: false }
}

function defaultBashExempt(abs: string): boolean {
  return isAllowedEnvExample(abs)
}

function collectPathArgs(value: unknown): string[] {
  const paths: string[] = []
  if (!value || typeof value !== "object") return paths
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === "string" && PATH_ARG_KEYS.has(key)) paths.push(entry)
    else if (entry && typeof entry === "object") paths.push(...collectPathArgs(entry))
  }
  return paths
}

function blockedMessage(match: Match, kind: string): string {
  return [
    `Blocked sensitive file ${kind}: ${match.path} matches ${match.pattern}.`,
    "Do not continue trying to read this file via other tools or shell commands.",
    "If you need configuration shape, call the OpenCode list_env_keys tool directly with the env file path; do not run list_env_keys in bash.",
    "If you need the variables for a command, source the file without printing it: set -a; source .env; set +a; your-command-here",
  ].join(" ")
}

function isYamlPath(file: string): boolean {
  return /\.ya?ml$/i.test(file)
}

function yamlDocumentBodies(contents: string): string[] {
  return contents
    .split(/^---\s*$/m)
    .map((document) => document.trim())
    .filter(Boolean)
}

function stripHelmDirectives(contents: string): string {
  // Drop everything between {{ }} / {{- -}} including the braces. This keeps
  // the surrounding YAML structure intact so document splits and scalar
  // matches behave normally on templated manifests.
  return contents.replace(/\{\{-?[\s\S]*?-?\}\}/g, "")
}

function yamlScalar(contents: string, key: string): string | undefined {
  const escaped = escapeRegExp(key)
  const match = new RegExp(`^\\s*${escaped}\\s*:\\s*["']?([^"'\\s#]+)`, "m").exec(contents)
  return match?.[1]
}

function hasTopLevelSecretData(contents: string): boolean {
  return /^data\s*:/m.test(contents) || /^stringData\s*:/m.test(contents)
}

function hasTopLevelKey(contents: string, key: string): boolean {
  return new RegExp(`^${escapeRegExp(key)}\\s*:`, "m").test(contents)
}

// Returns true if the YAML file contains at least one document that declares a
// core Kubernetes Secret (apiVersion: v1, kind: Secret) with literal `data:`
// or `stringData:` at the top level. This is the actual leakage shape we want
// to block — every other "secret"-named manifest (ExternalSecret, SealedSecret,
// references, Helm templates) is safe to read.
function containsUnsafeRawSecret(abs: string): boolean {
  if (!isYamlPath(abs) || !existsSync(abs)) return false

  try {
    const raw = readFileSync(abs, "utf8")
    const stripped = stripHelmDirectives(raw)
    const documents = yamlDocumentBodies(stripped)
    if (documents.length === 0) return false

    return documents.some((document) => {
      const kind = yamlScalar(document, "kind")
      if (kind !== "Secret") return false
      const apiVersion = yamlScalar(document, "apiVersion")
      // core Secret is apiVersion: v1; reject if some other group/version (we
      // don't know its semantics) — but a missing apiVersion still counts as
      // suspicious because someone may have written a Secret with `data:`.
      if (apiVersion && apiVersion !== "v1") return false
      return hasTopLevelSecretData(document)
    })
  } catch {
    return false
  }
}

function isHardBlockedEnvFile(abs: string): boolean {
  const base = path.basename(abs)
  if (base === ".env.example") return false
  return base === ".env" || base.startsWith(".env.")
}

function isPublicKeyFile(abs: string): boolean {
  return /\.pub$/i.test(abs)
}

function isAllowedEnvExample(abs: string): boolean {
  return path.basename(abs) === ".env.example"
}

function isHelmTemplatePath(abs: string): boolean {
  const normalized = abs.replaceAll(path.sep, "/")
  const templatesIndex = normalized.lastIndexOf("/templates/")
  if (templatesIndex < 0) return false
  if (!/\.(ya?ml|tpl|txt)$/i.test(normalized)) return false

  let dir = normalized.slice(0, templatesIndex)
  while (dir.includes("/")) {
    if (existsSync(path.join(dir, "Chart.yaml"))) return true
    const next = dir.slice(0, dir.lastIndexOf("/"))
    if (next === dir) break
    dir = next
  }
  return false
}

function isSafeHelmUnittestSpec(abs: string): boolean {
  if (!isYamlPath(abs) || !existsSync(abs)) return false

  const normalized = abs.replaceAll(path.sep, "/")
  if (!/\/charts\/[^/]+\/tests\/[^/]+_test\.ya?ml$/i.test(normalized)) return false

  try {
    const documents = yamlDocumentBodies(readFileSync(abs, "utf8"))
    if (documents.length === 0) return false

    return documents.every((document) => {
      return Boolean(yamlScalar(document, "suite")) && hasTopLevelKey(document, "templates") && hasTopLevelKey(document, "tests")
    })
  } catch {
    return false
  }
}

const gitTrackedCache = new Map<string, boolean>()

function isGitTracked(abs: string, worktree: string): boolean {
  const key = `${worktree}\0${abs}`
  const cached = gitTrackedCache.get(key)
  if (cached !== undefined) return cached

  let tracked = false
  try {
    execFileSync("git", ["ls-files", "--error-unmatch", "--", abs], {
      cwd: worktree,
      stdio: "ignore",
    })
    tracked = true
  } catch {
    tracked = false
  }
  gitTrackedCache.set(key, tracked)
  return tracked
}

// Decide whether a matched path should be exempted from blocking. Used by both
// the bash and read hooks. `.env*` files are NEVER exempted here (except for
// `.env.example`) — handle them with `isHardBlockedEnvFile` before calling.
function shouldExempt(abs: string, worktree: string): boolean {
  if (isAllowedEnvExample(abs)) return true
  if (isPublicKeyFile(abs)) return true
  if (isSafeHelmUnittestSpec(abs)) return true

  // Anything that looks safe by location/tracking is only allowed if its
  // content does NOT contain a raw Secret manifest.
  if (containsUnsafeRawSecret(abs)) return false

  if (isHelmTemplatePath(abs)) return true
  if (isGitTracked(abs, worktree)) return true
  return false
}

function isExemptForHook(abs: string, worktree: string): boolean {
  if (isHardBlockedEnvFile(abs)) return isAllowedEnvExample(abs)
  return shouldExempt(abs, worktree)
}

function correctionMessage(correction: string): string {
  return [
    `Blocked command: ${correction}`,
    "Do not retry this as a shell command.",
    "Use the tool call interface for list_env_keys, or source the env file inside bash only when running a command that needs the variables.",
  ].join(" ")
}

function parseEnvKeys(contents: string): { keys: string[]; blankOrComment: number; malformed: number } {
  const keys: string[] = []
  let blankOrComment = 0
  let malformed = 0

  for (const line of contents.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith("#")) {
      blankOrComment++
      continue
    }
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(trimmed)
    if (!match) {
      malformed++
      continue
    }
    keys.push(match[1])
  }

  return { keys: [...new Set(keys)].sort(), blankOrComment, malformed }
}

export const SensitiveFileGuard: Plugin = async (ctx, options?: GuardOptions) => {
  const protectedPatterns = options?.protected ?? DEFAULT_PROTECTED
  const envKeyPatterns = options?.allowEnvKeyListingFor ?? DEFAULT_ENV_KEY_LISTING
  const blockCopy = options?.blockCopy ?? true

  const exempt = (abs: string) => isExemptForHook(abs, ctx.worktree)

  return {
    tool: {
      list_env_keys: tool({
        description:
          "Safely list variable names from a protected key=value env file. Returns keys only, never values. This is an OpenCode tool, not a shell command; call it directly instead of running list_env_keys in bash.",
        args: {
          path: tool.schema.string().describe("Path to an env file such as .env or .env.local"),
        },
        async execute(args, context) {
          const match = matchProtectedPath(args.path, context.directory, context.worktree, envKeyPatterns)
          if (!match) throw new Error("Env key listing is only allowed for configured env-file patterns.")

          const abs = path.resolve(path.isAbsolute(args.path) ? args.path : path.join(context.directory, args.path))
          if (!existsSync(abs)) throw new Error(`Env file not found: ${normalizeForDisplay(abs, context.directory)}`)

          const parsed = parseEnvKeys(readFileSync(abs, "utf8"))
          const lines = [
            `Found ${parsed.keys.length} keys in ${normalizeForDisplay(abs, context.directory)}:`,
            ...parsed.keys.map((key) => `- ${key}`),
            "",
            `Skipped ${parsed.blankOrComment} blank/comment lines and ${parsed.malformed} malformed lines.`,
            "Values were not included. This was an OpenCode tool call, not a shell command. To run a command with these values available, use: set -a; source .env; set +a; <command>",
          ]
          return lines.join("\n")
        },
      }),
    },

    "tool.execute.before": async (input, output) => {
      if (input.tool === "read") {
        for (const rawPath of collectPathArgs(output.args)) {
          const match = matchProtectedPath(rawPath, ctx.directory, ctx.worktree, protectedPatterns)
          if (!match) continue
          if (exempt(match.abs)) continue
          throw new Error(blockedMessage(match, "read"))
        }
        return
      }

      if (input.tool === "bash") {
        const command = typeof output.args?.command === "string" ? output.args.command : undefined
        if (!command) return
        const decision = analyzeBashCommand(command, ctx.directory, ctx.worktree, protectedPatterns, blockCopy, exempt)
        if (decision.blocked) {
          if ("correction" in decision) throw new Error(correctionMessage(decision.correction))
          throw new Error(blockedMessage(decision.match, `disclosure (${decision.reason})`))
        }
      }
    },

    "tool.definition": async (input, output) => {
      if (input.toolID === "read") {
        output.description += " Do not read protected sensitive files such as .env; use the OpenCode list_env_keys tool directly for env variable names only. Do not run list_env_keys in bash."
      }
      if (input.toolID === "bash") {
        output.description += " Do not print, transform, copy, archive, or upload protected sensitive files such as .env. list_env_keys is an OpenCode tool, not a shell command; do not run it in bash. If env vars are needed, source the env file without printing it, for example: set -a; source .env; set +a; your-command-here."
      }
    },
  }
}

export default SensitiveFileGuard
