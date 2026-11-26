# Operating the hosted Cyber instance

This runbook is for maintainers with access to the hosted service. For a credential-free checkout, start with the [local quickstart](../README.md#local-quickstart).

## Deploy and publish are separate

- **Worker deploy:** [`deploy.yml`](../.github/workflows/deploy.yml) deploys from `main` for changes under `site/`, `worker/`, `container/`, and to `wrangler.jsonc` or package files. GitHub Actions uses `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`.
- **Hourly publication:** the Cloudflare Worker triggers Builder at `:07` UTC. Builder downloads `main`, restores caches from `state.tar.gz`, and generates the data, pages and search documents. The Worker writes the generated output to R2 (`breach-ledger-state` for site data and `breach-ledger-ai-search` for search documents). Generated pages become visible when the Worker publishes the pages manifest. A pipeline-only merge does not deploy the Worker; it takes effect on the next successful hourly build.
- **Gates:** merging requires a PR and the `check` job. It validates curated input, generates committed-snapshot fixtures and exercises the local Worker. This does not validate each hourly publication candidate. [Post-deploy verification](../.github/workflows/post-deploy.yml) checks the live service after a successful deployment. [Build freshness](../.github/workflows/build-freshness.yml) is scheduled at `:43` UTC and fails if the served build is over 75 minutes old when the workflow runs.

## Diagnose a stale build

1. Check the timestamp: `curl -fsSI https://cyber.askgina.ai/data-hot.json`. Compare `Last-Modified` with the expected hourly generation. If the timestamp advances but a page is stale, probe the affected route itself; data freshness alone doesn't verify page publication.
2. Inspect the **Deploy**, **Post-deploy verification**, and **Build freshness** runs in [GitHub Actions](https://github.com/askgina/cyber/actions). If the scheduled freshness workflow did not run, dispatch it manually: `gh workflow run "Build freshness" -R askgina/cyber`.
3. In Cloudflare Worker observability, inspect `breach-ledger` around the expected `:07` tick. Look for the cron invocation, `builder/run`, page bundle upload failures, and `build ok`. Compare `state.tar.gz`, `data.json`, and `pages-manifest.json` upload times in R2 to distinguish a missing build from an incomplete page publish.
4. If a rerun is needed and no build is active, an authorized operator can send `POST /__build` to the hosted Worker with the `BUILD_TOKEN` bearer credential. Keep the token in approved secret storage. Verify the timestamp and affected route after completion; a successful trigger alone is not proof of publication.

`VISITOR_SECRET` and `POSTHOG_KEY` are optional analytics bindings, not local setup inputs. Production bindings are defined in [`wrangler.jsonc`](../wrangler.jsonc); do not point a contributor preview at those resources.

## Refresh live feeds in a maintainer checkout

Use `python3 pipeline/build_data.py` only when intentionally refreshing from upstream feeds. Run it in a disposable worktree or separate clone: it makes network calls, can be slow or rate-limited, and rewrites tracked data and caches. Review the diff before committing any refreshed artifacts. This command is **not** required for a local preview or a PR check.

[`docs/baselines/`](baselines/) contains historical measurements and proposals, not current setup or operating instructions.
