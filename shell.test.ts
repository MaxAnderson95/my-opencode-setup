import { expect, test } from "bun:test"
import { evaluate, hasFileRedirect, normalize, type Rule } from "./shell"

test("normalize rewrites only forms with an equivalent-risk command", () => {
  expect(normalize(["git -C ../repo status --short"], "")).toEqual(["git status --short"])
  expect(normalize(['git -C "$HOME/x y" log'], "")).toEqual(["git log"])
  expect(normalize(["git -C $(rm -rf ~) status"], "")).toEqual(["git -C $(rm -rf ~) status"])
  expect(normalize(["sed -n '10,40p' src/a.ts"], "")).toEqual(["cat src/a.ts"])
  expect(normalize(["sed -n '/a/,/b/p' f"], "")).toEqual(["sed -n '/a/,/b/p' f"])
  expect(normalize(["sed -n '1,5p;w out' f"], "")).toEqual(["sed -n '1,5p;w out' f"])
})

test("a GH_TOKEN prefix accounts for exactly one gh auth token resource", () => {
  const command = 'GH_TOKEN="$(gh auth token --user u)" gh pr view 1'
  expect(normalize([command, "gh auth token --user u"], command)).toEqual(["gh pr view 1"])
  const leak = `${command}; gh auth token --user u`
  expect(normalize([command, "gh auth token --user u", "gh auth token --user u"], leak)).toEqual([
    "gh pr view 1",
    "gh auth token --user u",
  ])
})

test("evaluate matches OpenCode's wildcard rules, last match winning", () => {
  const rules: Rule[] = [
    { action: "shell", resource: "*", effect: "ask" },
    { action: "shell", resource: "git log *", effect: "allow" },
    { action: "shell", resource: "git *--output*", effect: "ask" },
  ]
  expect(evaluate(rules, "shell", "git log")).toBe("allow")
  expect(evaluate(rules, "shell", "git log -5 --oneline")).toBe("allow")
  expect(evaluate(rules, "shell", "git logx")).toBe("ask")
  expect(evaluate(rules, "shell", "git log --output=/etc/passwd")).toBe("ask")
})

test("file redirects are detected outside quotes, ignoring fd duplication and /dev/null", () => {
  expect(hasFileRedirect("git status 2>&1")).toBe(false)
  expect(hasFileRedirect("ls >/dev/null 2>&1 && echo ok")).toBe(false)
  expect(hasFileRedirect("jq '.a > 1' f.json")).toBe(false)
  expect(hasFileRedirect('echo "a > b"')).toBe(false)
  expect(hasFileRedirect("{ echo x; } > ~/.zshrc")).toBe(true)
  expect(hasFileRedirect("cat < secret")).toBe(true)
  expect(hasFileRedirect('echo "$(ls > out)"')).toBe(true)
  expect(hasFileRedirect("cat <<'EOF'\nx\nEOF")).toBe(true)
})
