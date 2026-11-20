#!/usr/bin/env bash
# One-time history rewrite BEFORE the first push (rewrites every commit hash).
# Usage: scripts/publish/scrub-history.sh <repo-dir> <github-noreply-email> [github-display-name]
#   e.g. scripts/publish/scrub-history.sh ~/SE 12345+login@users.noreply.github.com "Your Name"
# Needs: pip install git-filter-repo. Refuses a dirty tree or an existing remote.
# Does: bundle backup -> author/committer email+name -> noreply; your email text
# and home-directory paths in file contents -> placeholders; drops /archive/;
# removes every Co-Authored-By trailer (so no AI tool shows as a contributor).
set -eu
repo=${1:?repo dir}; noreply=${2:?noreply email}; display=${3:-}
case "$noreply" in *@users.noreply.github.com) ;; *) echo "not a noreply address"; exit 2;; esac
cd "$repo"
git filter-repo --version >/dev/null 2>&1 || { echo "install: pip install git-filter-repo"; exit 2; }
[ -z "$(git status --porcelain)" ] || { echo "commit or stash your changes first"; exit 2; }
[ -z "$(git remote)" ] || { echo "has a remote; this is for a never-pushed repo"; exit 2; }

old_email=$(git config user.email); old_name=$(git config user.name)
user=$(basename "${USERPROFILE:-$HOME}")
bundle="../$(basename "$PWD")-backup-$(date +%Y%m%d%H%M%S).bundle"
git bundle create "$bundle" --all
echo "backup: $bundle  (keep it OFFLINE; it still has your real email)"

# Local working notes and tool config: purged from every commit. Edit to keep one.
PURGE="archive docs/origin-prompt.md docs/catalogue-progress.md docs/audit-2026-10-23.md docs/spec-amendments.md
 .claude .mcp.json docs/TUI_REPAIR_REPORT.md docs/SECURITY_FINDINGS_DISPOSITION.md docs/IMPLEMENTATION_BASELINE.md
 docs/RUNTIME_DETECTION_FINDINGS.md .claude/agent-memory"

tmp=$(mktemp -d)
{
  echo "literal:$old_email==>$noreply"
  echo "regex:(?i)[A-Za-z]:\\\\+Users\\\\+$user==>%USERPROFILE%"
  echo "regex:(?i)(/[a-z]|[A-Za-z]:)/Users/$user==>%USERPROFILE%"
} > "$tmp/replace.txt"
{
  git log --all --format='%an <%ae>' | sort -u | while IFS= read -r line; do
    n=${line% <*}; e=${line##*<}; e=${e%>}
    echo "${display:-$n} <$noreply> $n <$e>"
  done
} > "$tmp/mailmap.txt"

git filter-repo --force --replace-text "$tmp/replace.txt" --mailmap "$tmp/mailmap.txt" \
  --message-callback 'import re; return re.sub(rb"(?im)^co-authored-by:.*(
?
|$)", b"", message).rstrip() + b"
"' \n  $(for x in $PURGE; do printf -- '--path %s ' "$x"; done) --invert-paths
rm -rf "$tmp"
echo "done. Verify: scripts/publish/prepush-check.sh ."
