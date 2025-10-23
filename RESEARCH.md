# GitLab Search CLI Research (gls)

## 1. Project Goal
Create a fast, ergonomic CLI (`gls`) to interactively search and open GitLab projects. Primary UX flow:
1. User runs `gls`.
2. CLI ensures a local cache of projects (SQLite) is present.
3. Existing cached projects are streamed into an interactive fuzzy finder (fzf-like experience using Bun Shell piping) for immediate selection.
4. In the background, a stale-while-revalidate (SWR) refresh refetches project lists from configured GitLab group/path scopes, inserting/upserting into SQLite.
5. As new/changed projects arrive, they become available in the interactive picker (live updates) until user selects.

## 2. Functional Requirements
- Single executable entrypoint (TypeScript) runnable with `bun run gls` or via a bin alias `gls`.
- Read GitLab Personal Access Token from environment (`GITLAB_TOKEN`) – support `.env` loading via Bun.
- Support configuration for one or more GitLab path scopes (e.g. groups, subgroups, or namespaces) via env `GITLAB_PATHS` (comma‑separated) or config file later.
- Fetch all projects under each path scope.
- Cache projects in a local SQLite DB (`gls.db`) located adjacent to script.
- Implement SWR:
  - First run: cold cache → perform full fetch → build DB → open fzf.
  - Subsequent runs: load cached projects instantly → spawn background refresh → allow interactive selection while refresh occurs.
- Live update picker with newly fetched projects (optional phase 2; MVP can skip if complex – but design for it now).
- Fast pagination strategy: REST first page to get total count, then GraphQL parallel pagination.
 - Fast pagination strategy: GraphQL single count query per scope to get total project count, then REST offset/page-based parallel pagination using that total.
- Output: open project URL in browser
 - Stale removal: Track a `last_seen_at` timestamp per project during each refresh; prune projects not seen for configured duration (default 1 day) only after a successful full refresh.
 - Refresh throttling: Skip background refresh if the last full refresh finished less than the minimum interval ago (default 10 minutes); still serve cached results.

## 3. Non-Functional Requirements
- Performance: initial cold fetch should parallelize pages to minimize time (target <5s for thousands of projects).
- Robustness: handle network errors gracefully; fallback to existing cache; log warnings.
- Idempotent upserts: re-running refresh should not create duplicates.
- Minimal dependencies (prefer Bun built-ins, maybe lightweight fetch helpers). Avoid large ORMs.
- Deterministic schema migrations (versioning table).

## 4. GitLab APIs Overview
### 4.1 REST API
- Endpoint: `GET /api/v4/groups/:id/projects` for group scoped projects; also `/projects?membership=true&simple=true&search=` etc.
- Pagination: key headers `X-Total`, `X-Total-Pages`, `X-Per-Page`, `X-Next-Page`.
- Pros: Easy to get counts quickly via headers.
- Cons: Serial pagination unless manually parallelized.

### 4.2 GraphQL API
- Endpoint: `POST /api/graphql`.
- Purpose in MVP: obtain total project counts per configured scope with a lightweight query, avoiding an initial REST page fetch per scope.
- Query pattern (subject to GitLab schema – some connections expose `count`):
  ```graphql
  query GroupProjectCount($fullPath: ID!) {
    group(fullPath: $fullPath) {
      projects {
        count
      }
    }
  }
  ```
- If `count` is not available, fallback to a small `first: 1` request and read `pageInfo` (less ideal). Assumption: `count` exists; will verify during implementation.
- Benefit: Single request gives precise total → enables precomputing total pages for REST (`totalPages = Math.ceil(count / per_page)`).
- We intentionally do NOT fetch all nodes via GraphQL to leverage REST's pagination.

### 4.3 Decision
For MVP: Use GraphQL exclusively to obtain project counts, then perform aggressive parallel REST pagination (`page=1..X`, `per_page=100`). This hybrid delivered ~1100 projects in ~9 seconds in a preliminary test, which is acceptable UX for a cold cache. Further GraphQL enrichment (extra fields, selective queries) is deferred to Phase 2.

## 5. Fetching Strategy (SWR)
States:
- Cold start (no DB file) → full fetch → store → open picker.
- Warm start (DB exists) → read DB → start picker immediately → trigger async refresh unless throttled by `GLS_REFRESH_MIN_INTERVAL_MINUTES`.
  - Throttle logic: read `last_full_refresh_at` from `meta`; if present and `now - last_full_refresh_at < interval` then skip refresh.
- Refresh logic:
  - Mark refresh start timestamp in a meta table.
  - Fetch pages concurrently.
  - Upsert each project; track changes (new or updated `last_activity_at`).
  - Notify picker process (via simple IPC: file change event, pipe message, or polling DB). MVP: user re-run needed; design for live later.

Edge conditions:
- Token missing → exit with helpful message.
- Network error mid-refresh → partial updates OK; keep old cache.
- API rate limit → backoff and continue; if fatal, abort refresh.

## 6. Concurrency Plan
Concurrency will leverage the `already` library for a clean, well-tested limiter.

Approach:
1. Use GraphQL to get total counts per scope.
2. Compute REST page range (`1..totalPages`).
3. Create a concurrent wrapper: `const fetchPage = concurrent(maxConcurrent, fetchProjectsPage);`
4. Dispatch all pages with mapping: `await Promise.all(pages.map(p => fetchPage(scope, p)));`

Alternatively (to share the same concurrency pool across different scopes and page functions), omit the function argument when creating the wrapper:
```ts
import { concurrent } from 'already';
const limit = concurrent(maxConcurrent);
// Later
await Promise.all(pages.map(p => limit(fetchProjectsPage, scope, p)));
```

Rationale for using `already`:
- Battle-tested promise helpers; avoids writing custom throttle/queue.
- Simple API for shared concurrency across heterogeneous calls (pages across multiple scopes).
- Extensible: could later use `retry` helper for resilient page fetches.

Retry Strategy (using `already/retry` for transient HTTP errors 429/5xx):
```ts
import { retry } from 'already';
const pageData = await retry(3, () => fetchProjectsPage(scope, p));
```

Edge considerations:
- Ensure `maxConcurrent` does not exceed GitLab rate limits (configurable via `GLS_MAX_CONCURRENCY`). Default remains 8.
- If certain scopes have very large page counts, concurrency limiter naturally balances without starving smaller scopes.
- Failed pages (non-retryable) are logged and skipped; remaining pages continue.

## 7. Database Schema (SQLite)
Tables:
- `projects`:
  - `id INTEGER PRIMARY KEY` (GitLab project ID)
  - `name TEXT NOT NULL`
  - `path TEXT NOT NULL`
  - `full_path TEXT NOT NULL`
  - `web_url TEXT NOT NULL`
  - `description TEXT`
  - `last_activity_at TEXT`
  - `namespace TEXT` (group path scope)
  - `updated_at TEXT NOT NULL` (timestamp of last data change/upsert)
  - `last_seen_at TEXT NOT NULL` (timestamp set every refresh cycle when project is encountered)

- `meta`:
  - `key TEXT PRIMARY KEY`
  - `value TEXT`
  - Keys: `last_full_refresh_at`, `last_refresh_started_at` for throttling & diagnostics.

Indexes:
- `CREATE INDEX IF NOT EXISTS idx_projects_full_path ON projects(full_path);`
- Potential FTS: For fuzzy search speed, later create `projects_fts` virtual table using FTS5 on `name, full_path, description`.

Upsert statement example:
```
INSERT INTO projects (id, name, path, full_path, web_url, description, last_activity_at, namespace, updated_at, last_seen_at)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
ON CONFLICT(id) DO UPDATE SET
  name=excluded.name,
  path=excluded.path,
  full_path=excluded.full_path,
  web_url=excluded.web_url,
  description=excluded.description,
  last_activity_at=excluded.last_activity_at,
  namespace=excluded.namespace,
  updated_at=CASE WHEN (
      projects.name!=excluded.name OR
      projects.path!=excluded.path OR
      projects.full_path!=excluded.full_path OR
      projects.web_url!=excluded.web_url OR
      COALESCE(projects.description,'')!=COALESCE(excluded.description,'') OR
      COALESCE(projects.last_activity_at,'')!=COALESCE(excluded.last_activity_at,'') OR
      COALESCE(projects.namespace,'')!=COALESCE(excluded.namespace,'')
    ) THEN datetime('now') ELSE projects.updated_at END,
  last_seen_at=datetime('now');
```

Pruning stale projects (ONLY after a full refresh cycle completes successfully; never before fetching pages, to avoid wiping cache after long inactivity):
```
-- Execute this AFTER all scopes/pages processed without fatal error
DELETE FROM projects
WHERE julianday('now') - julianday(last_seen_at) > ?; -- ? = stale_days
```
If the refresh is partial (some pages failed) skip pruning to prevent accidental removal based on incomplete visibility. Maintain a `meta` key like `last_full_refresh_at` to record successful cycles.

FTS sync approach (Phase 2): After upsert, also `INSERT INTO projects_fts(rowid, name, full_path, description) VALUES (?, ?, ?, ?) ON CONFLICT(rowid) DO UPDATE ...` (requires manual logic – FTS doesn't support standard `ON CONFLICT`).

## 8. Configuration
Environment variables (via `.env`):
- `GITLAB_TOKEN` (required)
- `GITLAB_BASE_URL` (default: `https://gitlab.com`)
- `GITLAB_PATHS` (comma-separated group full paths)
- `GLS_DB_PATH` (optional override of DB file location)
- `GLS_MAX_CONCURRENCY` (default 8)
 - `GLS_STALE_DAYS` (default 1) – number of days without seeing a project before removal.
 - `GLS_REFRESH_MIN_INTERVAL_MINUTES` (default 10) – minimum minutes between full refresh cycles.

Validation: Fail fast if token or paths missing.

## 9. CLI Interaction (Bun Shell + fzf)
Options:
- Use external `fzf` if installed (spawn via Bun Shell `$` template). Pipe project list lines: `full_path<TAB>name` and capture selection.
- If `fzf` unavailable, fallback to simple textual list with numeric selection.
- Later improvement: Implement embedded fuzzy matcher in JS to remove dependency.

Flow:
1. Load projects from DB: `SELECT id, full_path, name FROM projects ORDER BY full_path;`
2. Stream to `fzf` process.
3. Await selection; parse chosen line to extract project id.
4. Output `web_url` or open in browser (e.g., `open` command macOS).

Live updates: Could maintain a temporary FIFO (named pipe) feeding `fzf --reload` but complexity deferred.

## 10. Data Flow Overview
1. Parse env & config.
2. Initialize DB (create tables if missing).
3. Determine cold vs warm start.
4. If cold: fetch all → insert → proceed to picker.
5. If warm: spawn refresh (non-blocking) then picker immediately.
6. Picker outputs selection.
7. Program exit code 0; non-zero for errors.

## 11. Error Handling & Logging
- Use simple `console.error` with prefixed levels (INFO/WARN/ERROR).
- Distinguish between fatal configuration errors (exit 1) and transient fetch errors (continue with stale cache).

## 12. Edge Cases
- No projects returned for a path (warn user; continue).
- Duplicate projects across paths (same project ID) – upsert eliminates duplication; record last namespace (maybe store multiple? TBD).
- Very large number of projects (>10k) – ensure memory viability by streaming inserts per page rather than collecting all.
- Rate limiting: GitLab returns 429; implement retry with exponential backoff (cap attempts per page).
- Token permissions insufficient – API 403; remove that path from future refresh and notify.
- Partial group rename – `full_path` updates propagate on next refresh.
 - Pruning only after successful full refresh: skip prune if any page fetch failed to avoid false removal after long inactivity.
 - Frequent invocations within throttle interval: cached data returned; potential future `--force-refresh` flag.

## 13. Open Questions
- Do we need GraphQL for any metadata not in REST? (e.g., topics). Possibly future.
- Should we store additional fields (star count, archived flag) for filtering? Might add columns later.
- Multi-namespace mapping: store a junction table if project can belong to multiple configured scopes? Typically one group path; cross-group membership via sharing is rare; ignore for now.
- Live reload implementation details (fzf `--listen` integration?).

## 14. Security Considerations
- Never log token.
- DB path should be user-writable only; if using XDG cache, ensure directory permissions 700 if created.

## 15. Performance Notes
- Parallel REST requests with concurrency 8 should scale well; measure average latency and adjust.
- Consider HTTP keep-alive; Bun's fetch should reuse connections.
- Avoid building a giant array of all projects before inserts; process each page individually.

## 16. Implementation Phases
Phase 1 (MVP):
- REST only, cold/warm start, fzf integration if present, simple selection, output URL.

Phase 2:
- Live update reload, FTS for faster fuzzy search, GraphQL enrichment.

Phase 3:
- Additional filters (archived, topics), open directly in browser.

## 17. Next Steps
1. Implement DB initialization utility.
2. Implement fetch logic (REST, concurrency, retry).
3. Implement SWR orchestration.
4. Implement CLI picker.
5. Wire up bin entry + package.json script.
6. Add README usage notes.
7. Add small benchmarking script.

## 18. Minimal Acceptance Criteria for MVP
- Running `gls` after setting env variables lists projects in interactive picker when cache warm; on cold start, populates DB first.
- Selection returns a valid project URL.
- Subsequent run starts very quickly even for large project counts.

---
This document will evolve as implementation starts; unresolved items in Open Questions will be revisited.
