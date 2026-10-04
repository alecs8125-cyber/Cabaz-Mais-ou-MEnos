# Continente daily sync

The daily command refreshes saved Continente Online price references first, then resumes discovery in deterministic product-sitemap order. It stores `refresh`, `discovery`, `sitemapIndex`, `offset`, cycle, and run-lock metadata in the existing `public.source_sync_state` row for `source_type=continente`. It does not create a table or run SQL migrations.

The command is read-only by default:

```sh
pnpm --filter @workspace/api-server run sync:continente:daily -- --limit=100 --resume
```

An authorized write run must explicitly include both flags:

```sh
pnpm --filter @workspace/api-server run sync:continente:daily -- --limit=100 --resume --commit
```

`--limit` is the maximum number of first-pass product URLs handled across both refresh and discovery, from 1 to 100. The refresh queue is prioritized by expired prices, prices expiring within 12 hours, and then oldest capture time. Discovery advances through at most 20 URLs per checkpointed sublot. A commit caps product-page HTTP requests at three times `--limit`, including retries and ID-stability rereads. Requests are serial (concurrency 1); transient timeouts, HTTP 408, 429, and 5xx responses receive at most two short retries. Blocks, unsafe sitemap changes, invalid pages, and failed identity checks stop the current sublot without advancing its checkpoint. Redirects are followed only when HTTPS, same-origin, product-path, and product ID all match; other redirects are reported and skipped.

The job reconciles the atomic price RPC with read-only price/history queries before advancing a committed checkpoint. After a successful run, verify the full persisted set with:

```sh
pnpm --filter @workspace/api-server run verify:continente
```

The intended run time is 05:00 `Europe/Lisbon`. The GitHub Actions workflow is `.github/workflows/continente-daily-sync.yml`; it uses GitHub's timezone-aware schedule syntax and does not create a Replit scheduled deployment.

## GitHub Actions

Before activating the workflow on the repository's default branch, add these GitHub repository secrets:

- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`

The workflow checks only whether the secrets are present and never prints their values. The scheduled command is:

```sh
pnpm --filter @workspace/api-server run sync:continente:scheduled -- --limit=100 --resume --commit
```

`--limit=100` allows at most 100 first-pass product URLs across refresh and discovery. A commit may make up to 300 product-page HTTP requests because bounded retries and identity-stability rereads also count toward the command's request budget.

To run it manually, open **Actions → Continente daily sync → Run workflow**. `dry_run` defaults to `true`; turn it off only to request a real commit. Manual runs are restricted to the default branch. To stop future scheduled runs, disable this workflow in GitHub Actions or remove its `schedule` trigger.