# @mvd/gls (gitlab search)

Interactive GitLab project search CLI with a local SQLite cache, stale-while-revalidate refreshing, and fuzzy selection via `fzf`.

## Installation

fzf must be installed and on your PATH (run `fzf --version`).

```bash
bun install @mvd/gls -g
```

## Usage
```bash
gls                      # open picker
gls --help               # show help
gls --log                # enable info logs
gls --debug              # enable debug logs (includes info if --log also set)
# Note: clone trigger key is fixed to `tab` in the picker
```

On first run (cold start) all projects are fetched before showing picker. Subsequent runs read cache immediately; refresh runs in the background unless throttled.

Selecting a project opens its web URL in the default browser.

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
| `GLS_POST_CLONE_ACTION` | no | - | Optional shell command to run from the cloned repository directory after clone (or if the repo already exists). Example: `code .` |

Create a `.env` file for convenience:
```env
GITLAB_TOKEN=xxxxxxxxxxxxxxxx
GITLAB_PATHS=my-group,another/subgroup
GLS_MAX_CONCURRENCY=8
```

