# Publishing SE safely (owner checklist)

SE is **two separate GitHub repositories**: `SE` (catalogue + TypeScript CLI)
and `SE/se-rust` (the Rust CLI, its own git). Others may read, clone, fork and
use both; only the owner can change `main`.

## 1. Commit locally (you)

In each repo review `git status`, then `git add` and `git commit`. Never
`git add -f`. Ignored on purpose: `.claude/`, `.se/state`, `archive/`, agent
memory, `target/`, `node_modules/`, key and `.env` files.

## 2. Scrub history (once, before the first push)

Commits carry your personal email and `C:\Users\<you>` paths. Make your GitHub
noreply address at Settings > Emails ("Keep my email addresses private").

    pip install git-filter-repo
    scripts/publish/scrub-history.sh ~/SE  <id+login@users.noreply.github.com> "Your Name"
    scripts/publish/scrub-history.sh ~/SE/se-rust <same> "Your Name"
    git config --global user.email <id+login@users.noreply.github.com>   # future commits

It makes a `.bundle` backup first (keep it offline, it holds your real email).

## 3. Verify

    scripts/publish/prepush-check.sh ~/SE
    scripts/publish/prepush-check.sh ~/SE/se-rust

Both must print `PASS`. Optionally also run `gitleaks git -v` in each repo.

## 4. Create the repos and push (empty repos, no README/licence from GitHub)

    gh repo create SE --public --source ~/SE --remote origin --push
    gh repo create se-rust --public --source ~/SE/se-rust --remote origin --push

Push only `main` unless you want other branches public.

## 5. Lock `main` so only you can change it

Rulesets need GitHub Free public repos or better. Run per repo (`OWNER/REPO`):

    gh api -X POST repos/OWNER/REPO/rulesets --input - <<'JSON'
    {
      "name": "protect-main", "target": "branch", "enforcement": "active",
      "conditions": {"ref_name": {"include": ["~DEFAULT_BRANCH"], "exclude": []}},
      "rules": [
        {"type": "deletion"},
        {"type": "non_fast_forward"},
        {"type": "pull_request", "parameters": {
          "required_approving_review_count": 1,
          "require_code_owner_review": true,
          "dismiss_stale_reviews_on_push": true,
          "require_last_push_approval": false,
          "required_review_thread_resolution": false}}
      ],
      "bypass_actors": [{"actor_id": 5, "actor_type": "RepositoryRole", "bypass_mode": "always"}]
    }
    JSON

Outside collaborators have read-only access by default; forks can only propose
pull requests, which `.github/CODEOWNERS` routes to you. Also in Settings:
Actions > "Require approval for all outside collaborators"; workflow
permissions "Read repository contents"; enable secret scanning + push
protection; enable private vulnerability reporting.

## 6. Rotate anything that ever leaked

No real key was found in either history (fixtures only, allowlisted in
`.gitleaks.toml`). If you ever pasted a key into a chat or file, rotate it.
