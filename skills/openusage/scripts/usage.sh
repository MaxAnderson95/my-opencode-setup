#!/usr/bin/env bash
# Fetch AI-subscription usage/limits from the local OpenUsage menu-bar app and
# render a concise markdown summary. No AI model involved — pure curl + jq.
#
# Usage:
#   usage.sh                # all ENABLED providers (GET /v1/usage)
#   usage.sh <providerId>   # one provider, incl. disabled (GET /v1/usage/:id)
#                           # e.g. claude | codex | copilot | opencode-go | cursor
#
# Env overrides: OPENUSAGE_HOST (default 127.0.0.1), OPENUSAGE_PORT (default 6736)
#
# The OpenUsage API binds loopback only. Run this on the SAME machine OpenUsage
# runs on (the opencode server host). The agent's bash tool already runs there,
# so this works regardless of which client UI (OpenChamber, web, TUI) is in use.
set -uo pipefail

HOST="${OPENUSAGE_HOST:-127.0.0.1}"
PORT="${OPENUSAGE_PORT:-6736}"
BASE="http://${HOST}:${PORT}"
PROVIDER="${1:-}"

if [[ -n "$PROVIDER" ]]; then
  URL="${BASE}/v1/usage/${PROVIDER}"
else
  URL="${BASE}/v1/usage"
fi

out="$(curl -sS -m 5 -o - -w $'\n__HTTP__%{http_code}' "$URL" 2>/dev/null)"
if [[ $? -ne 0 || -z "$out" ]]; then
  echo "Could not reach OpenUsage at ${BASE}."
  echo "Is the OpenUsage menu-bar app running on this machine? (port ${PORT} closed = app not running, or API disabled because the port was taken.)"
  exit 0
fi

code="${out##*__HTTP__}"
body="${out%__HTTP__*}"

case "$code" in
  204)
    echo "Provider '${PROVIDER}' is known to OpenUsage but has no cached snapshot yet (no successful probe so far)."
    exit 0
    ;;
  404)
    echo "Unknown provider '${PROVIDER}'. Try one of: claude, codex, copilot, opencode-go, cursor (or run with no argument to list all enabled providers)."
    exit 0
    ;;
  200) : ;;
  *)
    echo "OpenUsage returned HTTP ${code}: ${body}"
    exit 0
    ;;
esac

printf '%s' "$body" | jq -r '
  def rep($c;$n): if $n <= 0 then "" else ($c * $n) end;
  def bar($pct):
    (([$pct,0] | max) | [.,100] | min) as $p
    | ($p/10 | floor) as $f
    | rep("\u2588";$f) + rep("\u2591"; 10 - $f);
  def parsets($t): ($t | sub("\\.[0-9]+";"") | fromdateiso8601);
  def human($secs):
    ($secs | floor) as $s
    | if $s <= 0 then "now"
      elif $s < 3600 then "\(($s/60)|floor)m"
      elif $s < 86400 then "\(($s/3600)|floor)h \((($s%3600)/60)|floor)m"
      else "\(($s/86400)|floor)d \((($s%86400)/3600)|floor)h"
      end;
  (now) as $now
  | (if type == "array" then . else [.] end) as $providers
  | if ($providers | length) == 0 then
      "No enabled providers have cached usage yet."
    else
      $providers
      | map(
          (.displayName // .providerId) as $name
          | "### \($name)\(if .plan then " — \(.plan)" else "" end)",
          (
            .lines[]?
            | if .type == "progress" then
                (.used / (if .limit == 0 then 1 else .limit end) * 100) as $pct
                | (if .format.kind == "count"
                     then "\(.used)/\(.limit)\(if .format.suffix then " \(.format.suffix)" else "" end)"
                     else "\((.used*10|round)/10)%" end) as $val
                | (if .resetsAt then " · resets in \(human(parsets(.resetsAt) - $now))" else "" end) as $reset
                | "- \(.label): `\(bar($pct))` \($val)\($reset)"
              elif .type == "badge" then
                "- \(.label): **\(.text)**"
              elif .type == "text" then
                "- \(.label): \(.value)"
              else empty end
          ),
          (if .fetchedAt then
             (($now - parsets(.fetchedAt))) as $age
             | if $age > 900 then "- _data is ~\(human($age)) old (fetchedAt \(.fetchedAt))_" else empty end
           else empty end),
          ""
        )
      | .[]
    end
'
