# Phase 5: Admin remove-repo (low priority)

## Flow

Simpler than add-repo — a one-shot confirm rather than a multi-step wizard, since there's nothing to craft:

```
1. Admin: `/ask-admin remove-repo <name>` (same `api/ask-admin.ts` handler as add-repo).
2. Bot checks isAdmin(userId) and that <name> exists in the registry (read via a lightweight
   GitHub Contents API fetch of repos.json from the request-handling side, or a cached copy — no need to
   check out the KB repo just to validate a name).
3. Bot posts a Yes/No confirm: "Remove '<name>' (owner/repo) and delete its knowledge base?
   This can't be undone." Buttons: remove_repo_confirm / remove_repo_cancel, value = the repo
   name (reusing the same action-id + button-value pattern as the feedback buttons).
4. Yes → dispatch kb-remove-repo.yml via the same REST workflow_dispatch mechanism.
   No → ephemeral "cancelled."
```

## `removeRepo.ts` entrypoint

```
1. Read repo_name from env (workflow_dispatch input).
2. Checkout ask-d2e-kb.
3. git rm -r repos/<repo_name> (fails loudly if the folder doesn't exist — don't silently no-op).
4. withRegistryRetry: filter out the entry named repo_name.
5. Single commit ("chore(kb): remove <repo_name>"), push.
6. curl the deploy hook.
7. Slack notice confirming removal.
```

Support a dry-run env flag that does steps 1-4 and prints what would be deleted, skipping the actual `git rm`/commit/push/dispatch.

## Workflow: `.github/workflows/kb-remove-repo.yml`

```yaml
on:
  workflow_dispatch:
    inputs:
      repo_name: {required: true}

permissions:
  contents: write

jobs:
  remove:
    steps:
      - checkout ask-d2e (code)
      - checkout ask-d2e-kb into ./kb (KB_REPO_TOKEN)
      - setup-node, npm ci
      - run npm run kb-remove-repo
```

No Claude call needed at all for this phase — it's pure git/registry manipulation.

## Verification

- Dry-run flag against the real registry (no destructive action) to confirm the right folder/entry is targeted.
- Manual dispatch against a disposable test entry (create one via the add-repo wizard against a throwaway tiny repo, then remove it) to confirm the full round trip.
