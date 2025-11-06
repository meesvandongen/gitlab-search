# @mvd/gls (gitlab search)

Interactive GitLab project search CLI with a local SQLite cache, stale-while-revalidate refreshing, context-based filtering, and fuzzy selection via `fzf`.

## Features

✨ **Context-Based Filtering**: Filter projects by organizational prefixes (e.g., team, product, or company namespaces)  
🔍 **Pre-filtered Search**: Pass search queries as command arguments for instant filtering  
📊 **Progress Visualization**: Real-time progress bars during data fetching operations  
💾 **Persistent Preferences**: Context filters are stored and automatically reused  
🚀 **Smart Caching**: Stale-while-revalidate strategy with configurable refresh intervals  
🔧 **Flexible Configuration**: Environment variables and command-line options

## Installation

fzf must be installed and on your PATH (run `fzf --version`).

```bash
bun install @mvd/gls -g
```

## Usage

### Basic Commands
```bash
gls                          # Interactive project selection
gls identity                 # Pre-filter for "identity" projects  
gls "my project"             # Search with quoted phrases
gls --help                   # Show comprehensive help
gls --reset                  # Clear cache and rebuild (with progress bar)
```

### Context Filtering
```bash
# Set persistent context filters
gls --context "acme/backend,acme/frontend"

# Subsequent runs automatically use stored contexts
gls api                      # Search within stored contexts

# Temporarily search all projects (ignore stored contexts)
gls --all search-term        

# Clear stored contexts permanently
gls --clearcontext
```

### Logging Options  
```bash
gls --log                    # Enable info-level logging
gls --debug                  # Enable debug logging
# Note: Logging is automatically enabled for --reset and initial data fetch
```

## Behavior

- **First Run**: All projects are fetched with progress bar before showing picker
- **Subsequent Runs**: Cache is used immediately; background refresh when not throttled  
- **Context Persistence**: Context filters are stored in SQLite and automatically applied
- **Project Selection**: Opens web URL in default browser (clone with `tab` key)
- **Smart Logging**: Automatically enables logging for long-running operations

## Command-Line Options

| Option | Description |
|--------|-------------|
| `--help` | Show comprehensive help and usage examples |
| `--debug` | Enable debug logging (includes info logs) |
| `--log` | Enable info-level logging |
| `--reset` | Clear data store and rebuild cache (with progress bar) |
| `--context <prefixes>` | Set context filters (comma-separated prefixes, stored permanently) |
| `--clearcontext` | Clear all stored context filters from database |
| `--all` | Disable context filtering for this run (search everything) |

## Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `GITLAB_TOKEN` | **yes** | - | Personal Access Token |
| `GITLAB_BASE_URL` | no | https://gitlab.com | GitLab instance base URL |
| `GITLAB_PATHS` | no | (membership mode) | Comma-separated group full paths; if omitted, fetch user membership projects |
| `GLS_DB_PATH` | no | ~/gls.db | Path to SQLite cache file (supports `~` expansion) |
| `GLS_MAX_CONCURRENCY` | no | 8 | Max concurrent page fetches |
| `GLS_STALE_DAYS` | no | 1 | Days unseen before pruning stale projects |
| `GLS_REFRESH_MIN_INTERVAL_MINUTES` | no | 10 | Minimum minutes between full refresh cycles |
| `GLS_LOG` | no | 0 | Enable info-level logging (set to 1/true) |
| `GLS_DEBUG` | no | 0 | Enable debug logging (set to 1/true or use --debug) |
| `GITLAB_CLONE_DIRECTORY` | no | - | Directory where projects are cloned when clone key (`tab`) is pressed |
| `GLS_POST_CLONE_ACTION` | no | - | Shell command to run after clone/when repo exists (e.g., `code .`) |

### Configuration Example

Create a `.env` file for convenience:
```env
GITLAB_TOKEN=xxxxxxxxxxxxxxxx
GITLAB_PATHS=my-group,another/subgroup
GITLAB_CLONE_DIRECTORY=~/code
GLS_POST_CLONE_ACTION=code .
GLS_MAX_CONCURRENCY=8
```

## Advanced Usage

### Context Filtering Workflow
```bash
# 1. Set up your organizational contexts
gls --context "MYORGPATH/groupname,MYORGPATH/othergroup"

# 2. Regular searches now use these contexts automatically  
gls api                      # Only searches within MYORGPATH/groupname, MYORGPATH/othergroup projects
gls backend service          # Pre-filtered search within contexts

# 3. Override when needed
gls --all global-search      # Search all projects, ignoring stored contexts

# 4. Clean up contexts when changing focus
gls --clearcontext           # Remove all stored context filters
```

### Performance Tips
- Use `--context` to reduce search scope for faster results
- Set appropriate `GLS_MAX_CONCURRENCY` based on your network/GitLab instance
- Use `GLS_REFRESH_MIN_INTERVAL_MINUTES` to balance freshness vs. performance
- Enable logging (`--log`) to monitor refresh and filtering operations

