#!/usr/bin/env bash
# Read-only pre-push audit. Usage: scripts/publish/prepush-check.sh [repo-dir]
# Fails (exit 1) if the repo would publish a personal email, a home-directory
# path, a key-shaped string, or a file that must stay local.
# Your identity is read from git config, so nothing personal is stored here.
set -u
cd "${1:-.}" || exit 2
fail=0
bad() { echo "FAIL: $*"; fail=1; }

email=$(git config user.email); name=$(git config user.name)
user=$(basename "${USERPROFILE:-$HOME}")

echo "== files that must never be tracked"
git ls-files | grep -Ei '(^|/)(\.env(\..*)?|.*\.(pem|key|p12|pfx|ppk|jks|keystore|sqlite.*)|credentials\.json|settings\.local\.json|scheduled_tasks\.lock|agent-memory/.*|\.se/(state|cache|sessions)/.*|audit\.jsonl)$' | grep -v '\.env\.example$' | while read -r f; do echo "  $f"; done | tee /tmp/_pp_files >/dev/null
[ -s /tmp/_pp_files ] && { cat /tmp/_pp_files; bad "private files are tracked"; }
rm -f /tmp/_pp_files

echo "== current tree: email, home path, key shapes"
[ -n "$email" ] && git grep -nIF -- "$email" -- . ':!scripts/publish' && bad "your email is in tracked files"
[ -n "$user" ] && git grep -nIiE -- "(Users[\\/]+|/home/)$user([\\/]|\b)" -- . ':!scripts/publish' && bad "home-directory path is in tracked files"
git grep -nIE -- '(sk-ant-[A-Za-z0-9_-]{20,}|nvapi-[A-Za-z0-9_-]{20,}|ghp_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{35}|-----BEGIN [A-Z ]*PRIVATE KEY-----)' -- . ':!tests' ':!*.rs' && bad "key-shaped string in non-test files (review: fixture or real?)"

echo "== history: author/committer emails"
git log --all --format='%ae%n%ce' | sort -u | grep -v 'users\.noreply\.github\.com$' | sed 's/^/  /' | tee /tmp/_pp_mail >/dev/null
[ -s /tmp/_pp_mail ] && { cat /tmp/_pp_mail; bad "history exposes non-noreply emails (run scripts/publish/scrub-history.sh)"; }
rm -f /tmp/_pp_mail

echo "== history: email / home path in any commit"
[ -n "$email" ] && [ -n "$(git log --all -p --format= -S"$email" --pickaxe-all -- . ':!scripts/publish' | head -1)" ] && bad "email text appears in history diffs"
[ -n "$user" ] && [ -n "$(git log --all -p --format= -G"Users[\\\\/]+$user" -- . ':!scripts/publish' | head -1)" ] && bad "home path appears in history diffs"

echo "== history: co-author trailers"
[ -n "$(git log --all --format=%B | grep -iE '^co-authored-by:' | head -1)" ] && bad "commit messages contain Co-Authored-By trailers (contributors list)"

echo "== history: AI session artifacts / tool config ever committed"
git log --all --name-only --format= | sort -u | grep -E '(^|/)(origin-prompt|catalogue-progress|spec-amendments|TUI_REPAIR_REPORT|SECURITY_FINDINGS_DISPOSITION|IMPLEMENTATION_BASELINE)\.md$|^\.claude/|(^|/)\.mcp\.json$|(^|/)CLAUDE\.md$' | sed 's/^/  /' | tee /tmp/_pp_art >/dev/null
[ -s /tmp/_pp_art ] && { cat /tmp/_pp_art; bad "session artifacts / tool config in history (run scrub-history.sh)"; }
rm -f /tmp/_pp_art

echo "== remotes / branches"
git remote -v; git branch -a
[ $fail = 0 ] && echo "PASS: nothing private found" || echo "NOT SAFE TO PUSH"
exit $fail
