// Shell commands the user's own permission rules already allow, written in forms OpenCode's
// wildcard rules cannot match safely. A rule such as `git -C * status *` would also match
// `git -C x push origin status`, because `*` spans spaces. These rewrites turn each form into an
// equivalent-risk command, which then goes through the same rules as everything else.

export type Rule = { readonly action: string; readonly resource: string; readonly effect: "allow" | "deny" | "ask" }

// The directory may be a plain or variable path; a command substitution inside it is a separate resource.
const gitDirectory = /^git -C (?:"[^"`]*"|'[^']*'|[^\s"'`;&|<>()]+) +/
const ghToken = /^GH_TOKEN="\$\(gh auth token --user ([\w.-]+)\)" +/
const sedRange = /^sed -n (['"]?)\d+(?:,(?:\d+|\$))?p\1(?= |$)/

export function normalize(resources: readonly string[], command: string): string[] {
  // `$(gh auth token --user X)` is its own resource; it is safe only as the value of the
  // GH_TOKEN prefix it came from, so each prefix accounts for exactly one such resource.
  const tokens = new Map<string, number>()
  for (const match of command.matchAll(/GH_TOKEN="\$\(gh auth token --user ([\w.-]+)\)"/g))
    tokens.set(match[1]!, (tokens.get(match[1]!) ?? 0) + 1)
  return resources.flatMap((resource) => {
    const inner = /^gh auth token --user ([\w.-]+)$/.exec(resource)
    if (inner) {
      const left = tokens.get(inner[1]!) ?? 0
      if (left > 0) {
        tokens.set(inner[1]!, left - 1)
        return []
      }
      return [resource]
    }
    return [
      resource
        .replace(ghToken, "")
        .replace(gitDirectory, "git ")
        .replace(sedRange, "cat"),
    ]
  })
}

/** OpenCode's permission matcher (`packages/core/src/util/wildcard.ts`, last matching rule wins). */
export function evaluate(rules: readonly Rule[], action: string, resource: string) {
  return rules.findLast((rule) => match(action, rule.action) && match(resource, rule.resource))?.effect ?? "ask"
}

function match(input: string, pattern: string) {
  let escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".")
  if (escaped.endsWith(" .*")) escaped = escaped.slice(0, -3) + "( .*)?"
  return new RegExp(`^${escaped}$`, "s").test(input)
}

// OpenCode checks shell rules per command, and a redirect on a compound statement
// (`{ echo x; } > file`, `for ...; done > file`) is not part of any command's resource, so allow
// rules can approve a command that writes or reads a file through a redirect. This check runs on
// the full command text instead.

/** True when the command may redirect to or from a file. Errs toward true. */
export function hasFileRedirect(command: string) {
  const text = command
    // A `>` or `<` inside single quotes is literal text.
    .replace(/'[^']*'/g, "''")
    // So is one inside double quotes, unless the string contains a substitution.
    .replace(/"(?:[^"\\$`]|\\.)*"/g, '""')
    .replace(/\d*>&\s*(?:\d+|-)/g, " ")
    .replace(/(?:&|\d*)>>?\s*\/dev\/null\b/g, " ")
    .replace(/\d*<&\s*(?:\d+|-)/g, " ")
  return /[<>]/.test(text)
}
