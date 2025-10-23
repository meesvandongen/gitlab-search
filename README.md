# gitlab-search (gls)

Interactive GitLab project search CLI with a local SQLite cache, stale-while-revalidate refreshing, and fuzzy selection via `fzf` (if installed).

## Features
* GraphQL-only project count (no REST fallback for counts).
* REST pagination for project listing.
* Stale-While-Revalidate (SWR): instant results from cache, background refresh (throttled).
* Concurrency limiting with `already`.
* Stale pruning after successful full refresh (default: unseen >1 day removed).
* Throttling: skip refresh if last full refresh finished <10 minutes ago.
* Mandatory fuzzy picker using `fzf` (no numeric prompt fallback).

## Installation
This project uses Bun.

```bash
bun install
```

Run directly:
```bash
bun run index.ts
```

Or via script shortcut:
```bash
bun run gls
```

You can also link globally (optional):
```bash
bun link
gls --help
```

## Environment Variables
| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `GITLAB_TOKEN` | yes | - | Personal Access Token |
| `GITLAB_BASE_URL` | no | https://gitlab.com | GitLab instance base URL |
| `GITLAB_PATHS` | no | (membership mode) | Comma-separated group full paths; if omitted, fetch user membership projects |
| `GLS_DB_PATH` | no | gls.db | Path to SQLite cache file |
| `GLS_MAX_CONCURRENCY` | no | 8 | Max concurrent page fetches |
| `GLS_STALE_DAYS` | no | 1 | Days unseen before pruning stale projects |
| `GLS_REFRESH_MIN_INTERVAL_MINUTES` | no | 10 | Minimum minutes between full refresh cycles |
| `GLS_LOG` | no | 0 | Enable info-level logging (set to 1/true) |
| `GLS_DEBUG` | no | 0 | Enable debug logging (set to 1/true or use --debug) |
| `GITLAB_CLONE_DIRECTORY` | no | - | Directory where project will be cloned when clone key pressed in fzf |
| `GITLAB_CLONE_DIRECTORY` | no | - | Directory where project will be cloned when clone key pressed in fzf |
| `GLS_POST_CLONE_ACTION` | no | - | Optional shell command to run from the cloned repository directory after clone (or if the repo already exists). Example: `code .` |

Create a `.env` file for convenience:
```env
GITLAB_TOKEN=xxxxxxxxxxxxxxxx
GITLAB_PATHS=my-group,another/subgroup
GLS_MAX_CONCURRENCY=8
```

## Usage
```bash
gls                      # open picker (fzf required)
gls --help               # show help
gls --log                # enable info logs
gls --debug              # enable debug logs (includes info if --log also set)
# Note: clone trigger key is fixed to `ctrl-c` in the picker
```

On first run (cold start) all projects are fetched before showing picker. Subsequent runs read cache immediately; refresh runs in the background unless throttled.

Selecting a project opens its web URL in the default browser (macOS `open`, Linux `xdg-open`, else prints URL).

### Membership Mode
### Clone Via fzf Key (SSH) and post-clone action
When using `fzf`, pressing the clone key (fixed to `ctrl-c`) will clone the selected project via SSH instead of opening it in a browser. After a successful clone — or if the repository already exists locally — an optional post-clone action can be executed from the repository directory.

Configuration:
1. Set `GITLAB_CLONE_DIRECTORY` to a writable directory path (e.g. `/Users/you/projects`).
2. Optionally set `GLS_POST_CLONE_ACTION` to a shell command to run after cloning (or when the repo already exists). Example: `GLS_POST_CLONE_ACTION='code .'`.

Implementation details:
* Uses `fzf --expect=ctrl-c` to capture the clone key; if captured, action becomes `clone`.
* Clones using an SSH URL: `git@host:full_path.git` (or `ssh://host/full_path.git` if host includes a port).
* If the target directory already contains the repository (determined by project name subdirectory), the clone step is skipped and the post-clone action (if configured) is still run.
* The post-clone action is executed using the system shell (`sh -lc`) from the repository directory so you can run commands like `code .`, `make setup`, or other initialization steps.
* Output from `git` and the post-clone action is streamed to the console. Exit codes are logged.

Edge cases:
* `GITLAB_CLONE_DIRECTORY` must be set; clone action errors if missing.
* Non-zero git exit code is reported as an ERROR log; non-zero post-clone action exit codes are reported as WARN.

If `GITLAB_PATHS` is not provided, the CLI fetches your membership projects via `/api/v4/projects?membership=true`. Group-scoped fetching (with subgroup traversal) is only used when paths are specified.

Note: `fzf` is required; the numeric prompt fallback has been removed.

## Cache & Refresh Behavior
* `last_seen_at` updated each time a project is encountered in a refresh.
* After a successful full refresh: prune projects where `now - last_seen_at > GLS_STALE_DAYS`.
* Throttling prevents refresh spam; if you need an immediate refresh within the interval a future `--force-refresh` flag can be added.

## Concurrency
Uses `already`'s `concurrent()` to share a pool across all page fetch promises, plus `retry()` for transient failures (HTTP 429/5xx).

## Potential Enhancements
* Full-text search (SQLite FTS5) for local fuzzy matching without `fzf`.
* GraphQL enrichment (topics, star counts, archived flag) for filtering.
* Live incremental updates inside `fzf` using a FIFO + `--reload`.
* `--force-refresh` flag & `--no-open` to just print URLs.

## Troubleshooting
* Missing token: ensure `GITLAB_TOKEN` exported or in `.env`.
* Missing `fzf`: install `fzf` (no prompt fallback).
* Missing clone directory: set `GITLAB_CLONE_DIRECTORY` before using clone key.
* Post-clone action: set `GLS_POST_CLONE_ACTION` to run a command (e.g. `code .`) from the cloned repo directory after cloning or when the repo already exists.
* GraphQL count failure aborts execution (no REST fallback).
* Empty picker: verify `GITLAB_PATHS` group paths or membership access.

## License
MIT (see upstream dependencies for their licenses).

