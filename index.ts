#!/usr/bin/env bun
/**
 * gls - GitLab project search CLI
 * Features:
 *  - Environment/config parsing
 *  - SQLite cache for project metadata
 *  - Project counts via GraphQL (membership via REST headers)
 *  - Parallel REST project retrieval with configurable concurrency
 *  - Stale-while-refresh caching (throttled refresh + stale pruning)
 *  - Interactive selection via fzf with optional clone action
 */

import { Database } from "bun:sqlite";
import { concurrent, retry } from "already";
import path from "path";
import { existsSync } from "fs";

// Expand a leading tilde to the user's HOME directory. Only used for DB path.
function untildify(p: string): string {
	if (!p) return p;
	// Only expand leading ~/ pattern. Leave other ~user forms untouched.
	if (p.startsWith("~/")) {
		const home = Bun.env.HOME || "";
		// Use path.join to ensure proper separators on all platforms
		return path.join(home, p.slice(2));
	}
	return p;
}

// ----------------------- Types -----------------------
interface Config {
	token: string;
	baseUrl: string;
	paths: string[]; // group full paths; empty => membership mode
	dbPath: string;
	maxConcurrency: number;
	staleDays: number;
	minRefreshMinutes: number;
	debug: boolean;
	logInfo: boolean;
	perPage: number;
	cloneDir?: string;
	contexts?: string[]; // context prefixes for filtering
	allFlag: boolean; // disable context filtering for this run
	clearContextFlag: boolean; // clear stored contexts
}

interface ProjectRow {
	id: number;
	name: string;
	path: string;
	full_path: string;
	web_url: string;
	description?: string | null;
	last_activity_at?: string | null;
	namespace?: string | null;
}

// ----------------------- Config Parsing -----------------------
function parseConfig(): Config {
	const env = Bun.env;
	const token = env.GITLAB_TOKEN || "";
	const baseUrl = (env.GITLAB_BASE_URL || "https://gitlab.com").replace(
		/\/$/,
		"",
	);
	const paths = (env.GITLAB_PATHS || "")
		.split(",")
		.map((s: string) => s.trim())
		.filter(Boolean);
	const dbPath = env.GLS_DB_PATH || "~/gls.db";
	const maxConcurrency = parseInt(env.GLS_MAX_CONCURRENCY || "8", 10) || 8;
	const staleDays = parseInt(env.GLS_STALE_DAYS || "1", 10) || 1;
	const minRefreshMinutes =
		parseInt(env.GLS_REFRESH_MIN_INTERVAL_MINUTES || "10", 10) || 10;
	const debug = process.argv.includes("--debug");
	const logInfo =
		process.argv.includes("--log") ||
		["1", "true", "yes", "on"].includes((env.GLS_LOG || "").toLowerCase());
	const perPage = 100; // GitLab max typical page size
	const cloneDir = env.GITLAB_CLONE_DIRECTORY || undefined;
	const allFlag = process.argv.includes("--all");
	const clearContextFlag = process.argv.includes("--clearcontext");

	// Parse --context parameter (supports both --context=value and --context value)
	let contexts: string[] | undefined;
	const contextArgIndex = process.argv.findIndex(
		(arg: string) => arg === "--context" || arg.startsWith("--context="),
	);

	if (contextArgIndex !== -1) {
		let contextValue: string;
		const contextArg = process.argv[contextArgIndex];

		if (contextArg.startsWith("--context=")) {
			// Handle --context=value format
			contextValue = contextArg.substring("--context=".length);
		} else {
			// Handle --context value format
			if (contextArgIndex + 1 < process.argv.length) {
				contextValue = process.argv[contextArgIndex + 1];
			} else {
				fatal("--context parameter requires a value");
			}
		}

		contexts = contextValue
			.split(",")
			.map((s: string) => s.trim())
			.filter(Boolean);
	}

	if (!token)
		fatal("Missing GITLAB_TOKEN env value. Set it in .env or environment.");
	// paths optional: empty triggers membership mode

	return {
		token,
		baseUrl,
		paths,
		dbPath,
		maxConcurrency,
		staleDays,
		minRefreshMinutes,
		debug,
		logInfo,
		perPage,
		cloneDir,
		contexts,
		allFlag,
		clearContextFlag,
	};
}

// ----------------------- Logging -----------------------
function log(level: "INFO" | "WARN" | "ERROR" | "DEBUG", msg: string) {
	if (level === "DEBUG" && !config.debug) return;
	if (level === "INFO" && !config.logInfo) return;
	console.error(`[${level}] ${msg}`);
}
function fatal(msg: string): never {
	console.error(`[ERROR] ${msg}`);
	process.exit(1);
}

// ----------------------- DB Setup -----------------------
let config: Config; // assigned in main
let db: Database;

function initDb(dbPath: string) {
	const expanded = untildify(dbPath);
	db = new Database(expanded);
	db.run(`CREATE TABLE IF NOT EXISTS projects (
		id INTEGER PRIMARY KEY,
		name TEXT NOT NULL,
		path TEXT NOT NULL,
		full_path TEXT NOT NULL,
		web_url TEXT NOT NULL,
		description TEXT,
		last_activity_at TEXT,
		namespace TEXT,
		updated_at TEXT NOT NULL,
		last_seen_at TEXT NOT NULL
	);`);
	db.run(`CREATE TABLE IF NOT EXISTS meta (
		key TEXT PRIMARY KEY,
		value TEXT
	);`);
	db.run(`CREATE TABLE IF NOT EXISTS contexts (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		prefix TEXT NOT NULL UNIQUE,
		created_at TEXT NOT NULL DEFAULT (datetime('now'))
	);`);
	db.run(
		`CREATE INDEX IF NOT EXISTS idx_projects_full_path ON projects(full_path);`,
	);
	db.run(`CREATE INDEX IF NOT EXISTS idx_contexts_prefix ON contexts(prefix);`);
}

function getMeta(key: string): string | undefined {
	const row = db.query("SELECT value FROM meta WHERE key = ?").get(key) as
		| { value: string }
		| undefined;
	return row?.value;
}
function setMeta(key: string, value: string) {
	db.query(
		"INSERT INTO meta (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
	).run(key, value);
}

const upsertStmtSql = `INSERT INTO projects (id,name,path,full_path,web_url,description,last_activity_at,namespace,updated_at,last_seen_at)
VALUES (?,?,?,?,?,?,?,?,datetime('now'),datetime('now'))
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
	last_seen_at=datetime('now');`;
let upsertStmt: ReturnType<Database["query"]>;

function prepareStatements() {
	upsertStmt = db.query(upsertStmtSql);
}

function clearDataStore() {
	log("INFO", "Clearing data store...");
	db.run("DELETE FROM projects");
	db.run("DELETE FROM meta");
	db.run("DELETE FROM contexts");
	log("INFO", "Data store cleared successfully.");
}

// ----------------------- Context Management -----------------------
function addContexts(contexts: string[]) {
	if (!contexts || contexts.length === 0) return;

	const insertStmt = db.query(
		"INSERT OR IGNORE INTO contexts (prefix) VALUES (?)",
	);
	db.run("BEGIN");
	try {
		for (const context of contexts) {
			insertStmt.run(context);
		}
		db.run("COMMIT");
		log("INFO", `Added ${contexts.length} context(s): ${contexts.join(", ")}`);
	} catch (e) {
		db.run("ROLLBACK");
		throw e;
	}
}

function getStoredContexts(): string[] {
	const stmt = db.query("SELECT prefix FROM contexts ORDER BY prefix");
	const rows = stmt.all() as { prefix: string }[];
	return rows.map((row) => row.prefix);
}

function clearStoredContexts() {
	db.run("DELETE FROM contexts");
	log("INFO", "Cleared all stored context filters.");
}

function filterProjectsByContexts(contexts: string[]): PickResult[] {
	if (!contexts || contexts.length === 0) {
		return loadAllProjects();
	}

	// Build WHERE clause for matching any of the context prefixes
	const placeholders = contexts.map(() => "full_path LIKE ?").join(" OR ");
	const sql = `SELECT id, full_path, name, web_url FROM projects WHERE ${placeholders} ORDER BY full_path`;
	const params = contexts.map((context) => `${context}%`);

	log("DEBUG", `Filtering projects with contexts: ${contexts.join(", ")}`);
	log("DEBUG", `SQL query: ${sql}`);
	log("DEBUG", `Parameters: ${params.join(", ")}`);

	const stmt = db.query(sql);
	const rows = stmt.all(...params) as {
		id: number;
		full_path: string;
		name: string;
		web_url: string;
	}[];

	log("DEBUG", `Found ${rows.length} projects matching contexts`);
	if (rows.length > 0 && config.debug) {
		log(
			"DEBUG",
			`First few matches: ${rows
				.slice(0, 3)
				.map((r) => r.full_path)
				.join(", ")}`,
		);
	}

	return rows.map((r) => ({
		id: r.id,
		full_path: r.full_path,
		name: r.name,
		web_url: r.web_url,
		action: "open" as const,
	}));
}

// ----------------------- Progress Bar -----------------------
class ProgressBar {
	private total: number;
	private current: number = 0;
	private width: number = 40;
	private lastOutput: string = "";

	constructor(total: number) {
		this.total = total;
	}

	update(current: number) {
		this.current = current;
		this.render();
	}

	increment() {
		this.current++;
		this.render();
	}

	private render() {
		if (!config.logInfo) return; // Only show progress when logging is enabled

		const percentage = Math.round((this.current / this.total) * 100);
		const filled = Math.round((this.current / this.total) * this.width);
		const empty = this.width - filled;

		const bar = "█".repeat(filled) + "░".repeat(empty);
		const output = `\r[${bar}] ${percentage}% (${this.current}/${this.total})`;

		// Clear previous line and write new progress
		if (this.lastOutput) {
			process.stderr.write("\r" + " ".repeat(this.lastOutput.length) + "\r");
		}
		process.stderr.write(output);
		this.lastOutput = output;
	}

	finish() {
		if (!config.logInfo) return;
		process.stderr.write("\n");
	}
}

// ----------------------- Network Helpers -----------------------
async function gitlabFetch(
	path: string,
	init?: RequestInit,
): Promise<Response> {
	const url = `${config.baseUrl}${path}`;
	const headers: Record<string, string> = {
		"Private-Token": config.token,
		Accept: "application/json",
	};
	if (init?.headers)
		Object.assign(headers, init.headers as Record<string, string>);
	const res = await fetch(url, { ...init, headers });
	return res;
}

// GraphQL count fetch only (no REST fallback)
async function getProjectCount(scope: string): Promise<number> {
	const gql = `query GroupProjectCount($fullPath: ID!) { group(fullPath: $fullPath) { projects { count } } }`;
	const res = await fetch(`${config.baseUrl}/api/graphql`, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			"Private-Token": config.token,
		},
		body: JSON.stringify({ query: gql, variables: { fullPath: scope } }),
	});
	if (!res.ok)
		fatal(`GraphQL count fetch failed (status ${res.status}) for ${scope}`);
	const json: unknown = await res.json();
	type GqlCountResp = { data?: { group?: { projects?: { count?: number } } } };
	if (typeof json !== "object" || json === null)
		fatal(`GraphQL malformed response for ${scope}`);
	const obj = json as GqlCountResp;
	const count = obj.data?.group?.projects?.count;
	if (typeof count !== "number") fatal(`GraphQL count missing for ${scope}`);
	return count;
}

// Membership (user-access) projects count via REST headers fallback only
async function getMembershipProjectCount(): Promise<number> {
	const rest = await gitlabFetch(
		`/api/v4/projects?membership=true&per_page=1&page=1&simple=true&archived=false`,
	);
	if (!rest.ok)
		throw new Error(`REST membership first page failed: ${rest.status}`);
	const totalHeader = rest.headers.get("X-Total");
	return totalHeader ? parseInt(totalHeader, 10) : 0;
}

async function fetchMembershipProjectsPage(
	page: number,
	perPage: number,
): Promise<ProjectRow[]> {
	const url = `/api/v4/projects?membership=true&per_page=${perPage}&page=${page}&simple=true&archived=false`;
	const res = await gitlabFetch(url);
	if (!res.ok)
		throw new Error(
			`Membership page fetch failed page=${page} status=${res.status}`,
		);
	const arr: unknown = await res.json();
	if (!Array.isArray(arr)) return [];
	interface MembershipProjectShape {
		id: number;
		name: string;
		path: string;
		path_with_namespace: string;
		web_url: string;
		description?: string | null;
		last_activity_at?: string | null;
	}
	return (arr as MembershipProjectShape[]).map((p) => ({
		id: p.id,
		name: p.name,
		path: p.path,
		full_path: p.path_with_namespace,
		web_url: p.web_url,
		description: p.description ?? null,
		last_activity_at: p.last_activity_at ?? null,
		namespace: null,
	}));
}

async function fetchProjectsPage(
	scope: string,
	page: number,
	perPage: number,
): Promise<ProjectRow[]> {
	const url = `/api/v4/groups/${encodeURIComponent(scope)}/projects?per_page=${perPage}&page=${page}&with_shared=false&include_subgroups=true&simple=true&archived=false`;
	const res = await gitlabFetch(url);
	if (!res.ok)
		throw new Error(
			`Page fetch failed scope=${scope} page=${page} status=${res.status}`,
		);
	const arr: unknown = await res.json();
	if (!Array.isArray(arr)) return [];
	interface GitLabProjectApiShape {
		id: number;
		name: string;
		path: string;
		path_with_namespace: string;
		web_url: string;
		description?: string | null;
		last_activity_at?: string | null;
	}
	return (arr as GitLabProjectApiShape[]).map((p) => ({
		id: p.id,
		name: p.name,
		path: p.path,
		full_path: p.path_with_namespace,
		web_url: p.web_url,
		description: p.description ?? null,
		last_activity_at: p.last_activity_at ?? null,
		namespace: scope,
	}));
}

// ----------------------- Fetch All for Scope -----------------------
async function fetchAllProjectsForScope(scope: string): Promise<void> {
	log("INFO", `Refreshing scope ${scope}`);
	const total = await getProjectCount(scope);
	log("INFO", `Scope ${scope} total projects reported: ${total}`);
	if (total === 0) return; // nothing to do
	const totalPages = Math.ceil(total / config.perPage);
	const progressBar = new ProgressBar(totalPages);
	const limiter = concurrent(config.maxConcurrency);
	const pages: number[] = Array.from({ length: totalPages }, (_, i) => i + 1);
	let completedPages = 0;

	await Promise.all(
		pages.map((p) =>
			limiter(async () => {
				await retry(3, () => fetchAndStorePage(scope, p));
				completedPages++;
				progressBar.update(completedPages);
			}),
		),
	);
	progressBar.finish();
}

async function fetchAllMembershipProjects(): Promise<void> {
	log("INFO", "Refreshing membership projects");
	const total = await getMembershipProjectCount();
	log("INFO", `Membership total projects reported: ${total}`);
	if (total === 0) return;
	const totalPages = Math.ceil(total / config.perPage);
	const progressBar = new ProgressBar(totalPages);
	const limiter = concurrent(config.maxConcurrency);
	const pages: number[] = Array.from({ length: totalPages }, (_, i) => i + 1);
	let completedPages = 0;

	await Promise.all(
		pages.map((p) =>
			limiter(async () => {
				await retry(3, () => fetchMembershipAndStorePage(p));
				completedPages++;
				progressBar.update(completedPages);
			}),
		),
	);
	progressBar.finish();
}

async function fetchMembershipAndStorePage(page: number) {
	const rows = await fetchMembershipProjectsPage(page, config.perPage);
	db.run("BEGIN");
	try {
		for (const r of rows) {
			upsertStmt.run(
				r.id,
				r.name,
				r.path,
				r.full_path,
				r.web_url,
				r.description ?? null,
				r.last_activity_at ?? null,
				r.namespace ?? null,
			);
		}
		db.run("COMMIT");
	} catch (e) {
		db.run("ROLLBACK");
		throw e;
	}
	log("DEBUG", `Stored ${rows.length} membership projects page=${page}`);
}

async function fetchAndStorePage(scope: string, page: number) {
	const rows = await fetchProjectsPage(scope, page, config.perPage);
	db.run("BEGIN");
	try {
		for (const r of rows) {
			upsertStmt.run(
				r.id,
				r.name,
				r.path,
				r.full_path,
				r.web_url,
				r.description ?? null,
				r.last_activity_at ?? null,
				r.namespace ?? null,
			);
		}
		db.run("COMMIT");
	} catch (e) {
		db.run("ROLLBACK");
		throw e;
	}
	log("DEBUG", `Stored ${rows.length} projects scope=${scope} page=${page}`);
}

// ----------------------- SWR & Pruning -----------------------
function shouldThrottle(): boolean {
	const lastFull = getMeta("last_full_refresh_at");
	if (!lastFull) return false;
	const diffMinutes = (Date.now() - Date.parse(lastFull)) / 60000;
	return diffMinutes < config.minRefreshMinutes;
}

function pruneStaleProjects(): void {
	const sql = `DELETE FROM projects WHERE julianday('now') - julianday(last_seen_at) > ?;`;
	const days = config.staleDays;
	const beforeCount = db.query("SELECT COUNT(*) as c FROM projects").get() as {
		c: number;
	};
	db.query(sql).run(days);
	const afterCount = db.query("SELECT COUNT(*) as c FROM projects").get() as {
		c: number;
	};
	const pruned = beforeCount.c - afterCount.c;
	if (pruned > 0)
		log("INFO", `Pruned ${pruned} stale projects (> ${days} day(s) unseen).`);
}

async function performRefresh(): Promise<boolean> {
	setMeta("last_refresh_started_at", new Date().toISOString());
	try {
		if (config.paths.length === 0) {
			await fetchAllMembershipProjects();
		} else {
			for (const scope of config.paths) {
				await fetchAllProjectsForScope(scope);
			}
		}
		setMeta("last_full_refresh_at", new Date().toISOString());
		pruneStaleProjects();
		return true;
	} catch (e) {
		const msg = e instanceof Error ? e.message : String(e);
		log("ERROR", `Refresh failed: ${msg}`);
		return false;
	}
}

// ----------------------- Picker -----------------------
interface PickResult {
	id: number;
	web_url: string;
	full_path: string;
	name: string;
	action: "open" | "clone";
}
function loadAllProjects(): PickResult[] {
	const stmt = db.query(
		"SELECT id, full_path, name, web_url FROM projects ORDER BY full_path",
	);
	const rows: PickResult[] = [];
	for (const row of stmt.iterate()) {
		const r = row as {
			id: number;
			full_path: string;
			name: string;
			web_url: string;
		};
		rows.push({
			id: r.id,
			full_path: r.full_path,
			name: r.name,
			web_url: r.web_url,
			action: "open",
		});
	}
	return rows;
}

async function pickProject(
	initialQuery?: string,
	contexts?: string[],
): Promise<PickResult | undefined> {
	const rows = contexts
		? filterProjectsByContexts(contexts)
		: loadAllProjects();
	if (rows.length === 0) {
		if (contexts && contexts.length > 0) {
			log(
				"WARN",
				`No projects found matching context prefixes: ${contexts.join(", ")}`,
			);
		} else {
			log("WARN", "No projects available in cache.");
		}
		return undefined;
	}
	// Use fzf for interactive selection
	const fzfExists = (await Bun.which("fzf")) !== null;
	if (!fzfExists) fatal("fzf is required. Please install it and retry.");
	{
		const input = rows.map((r) => `${r.full_path}\t${r.name}`).join("\n");
		const expectArg = `--expect=tab`;
		const fzfArgs = ["fzf", expectArg, "--with-nth=1,2", "--delimiter=\t"];

		// Add initial query if provided
		if (initialQuery) {
			fzfArgs.push("--query", initialQuery);
		}

		const proc = Bun.spawn(fzfArgs, {
			stdin: "pipe",
			stdout: "pipe",
			stderr: "inherit",
		});
		if (proc.stdin) {
			proc.stdin.write(input);
			proc.stdin.end();
		}
		const out = await new Response(proc.stdout).text();
		const lines = out.trim().split(/\n+/).filter(Boolean);
		let triggeredKey: string | undefined;
		let selectionLine: string | undefined;
		if (lines.length === 1) {
			selectionLine = lines[0];
		} else if (lines.length >= 2) {
			triggeredKey = lines[0];
			selectionLine = lines[1];
		}
		if (!selectionLine) return undefined;
		const [full_path] = selectionLine.split("\t");
		const proj = rows.find((r) => r.full_path === full_path);
		if (!proj) return undefined;
		return { ...proj, action: triggeredKey ? "clone" : "open" };
	}
}

function openUrl(url: string) {
	if (process.platform === "darwin") {
		Bun.spawn(["open", url]);
	} else if (process.platform === "linux") {
		Bun.spawn(["xdg-open", url]);
	} else if (process.platform === "win32") {
		// Prefer explorer on Windows to open the URL with the default handler.
		// explorer.exe handles URLs reliably and avoids quirks with cmd start quoting.
		Bun.spawn(["explorer.exe", url]);
	} else {
		console.log(url); // fallback
	}
}

async function cloneProject(proj: PickResult) {
	if (!config.cloneDir)
		fatal(
			"Clone directory not configured. Set GITLAB_CLONE_DIRECTORY to use clone action.",
		);
	// Derive SSH clone URL: git@host:full_path.git
	// web_url example: https://gitlab.com/group/subgroup/project
	// Extract host from baseUrl (config.baseUrl) and use proj.full_path
	try {
		const host = new URL(config.baseUrl).host; // includes domain (and port if present)
		const cloneUrl = host.includes(":")
			? `ssh://${host}/${proj.full_path}.git` // if port present use ssh:// form
			: `git@${host}:${proj.full_path}.git`;
		const targetDir = config.cloneDir.replace(/~\//, `${Bun.env.HOME || ""}/`);
		const projectName = proj.full_path.split("/").pop() || proj.name;
		const projDir = path.join(targetDir, projectName);

		// If the repo already exists, skip cloning but still run any post-clone action
		if (existsSync(projDir)) {
			log("INFO", `Repository already exists at ${projDir}; skipping clone.`);
			await runPostCloneAction(projDir);
			return;
		}

		const cmd = ["git", "clone", cloneUrl];
		log("INFO", `Cloning (SSH) ${proj.full_path} -> ${targetDir}`);
		const proc = Bun.spawn(cmd, {
			cwd: targetDir,
			stdout: "inherit",
			stderr: "inherit",
		});
		const code = await proc.exited;
		if (code === 0) {
			log("INFO", "Clone completed successfully.");
			await runPostCloneAction(projDir);
		} else {
			log("ERROR", `Clone failed with exit code ${code}`);
		}
	} catch (e) {
		log(
			"ERROR",
			`Failed to construct SSH clone URL: ${e instanceof Error ? e.message : String(e)}`,
		);
	}
}

async function runPostCloneAction(projDir: string) {
	const action = (Bun.env.GLS_POST_CLONE_ACTION || "").trim();
	if (!action) return;
	log("INFO", `Running post-clone action in ${projDir}: ${action}`);
	try {
		// Run action via shell so users can provide compound commands like `code .`
		const proc = Bun.spawn(["zsh", "-lc", action], {
			cwd: projDir,
			stdout: "inherit",
			stderr: "inherit",
		});
		const code = await proc.exited;
		if (code === 0) log("INFO", "Post-clone action completed successfully.");
		else log("WARN", `Post-clone action exited with code ${code}`);
	} catch (e) {
		log(
			"ERROR",
			`Post-clone action failed: ${e instanceof Error ? e.message : String(e)}`,
		);
	}
}

// ----------------------- Help -----------------------
function showHelp() {
	console.log(`GitLab Search CLI (gls)
Usage: gls [options] [query]

Arguments:
	query             Initial search query for fzf (optional)

Options:
	--help            Show this help test
	--debug           Enable debug logging
	--log             Enable info-level logging
	--reset           Clear data store and rebuild cache
	--context <prefixes>  Comma-separated list of full path prefixes to filter projects
	                    (contexts are stored and automatically reused in future runs)
	--clearcontext    Clear all stored context filters from database
	--all             Disable context filtering for this run (search everything)

Examples:
	gls               Interactive project selection (uses stored contexts if any)
	gls identity      Search for projects matching "identity" (uses stored contexts if any)
	gls "my project"  Search for projects matching "my project" (uses stored contexts if any)
	gls --context "acme/backend,acme/frontend"  Set context filters (stored for future use)
	gls --all         Search all projects, ignoring stored context filters
	gls --clearcontext Clear stored context filters permanently

Requirements:
	fzf must be installed.

Environment Variables:
	GITLAB_TOKEN                     Personal Access Token (required)
	GITLAB_BASE_URL                  Base URL (default https://gitlab.com)
	GITLAB_PATHS                     Comma-separated group full paths; empty => membership mode
	GLS_DB_PATH                      Path to SQLite DB (default gls.db)
	GLS_MAX_CONCURRENCY              Max concurrent page fetches (default 8)
	GLS_STALE_DAYS                   Days unseen before prune (default 1)
	GLS_REFRESH_MIN_INTERVAL_MINUTES Minimum minutes between refresh (default 10)
	GLS_LOG                          Enable info logging (1/true or use --log)
	GLS_DEBUG                        Enable debug logging (1/true or use --debug)
	GITLAB_CLONE_DIRECTORY           Directory used for clone action (required for clone)
	GLS_POST_CLONE_ACTION            Optional shell command to run from the cloned repository directory after clone or when the repo already exists (example: "code .")

	Notes:
	The clone trigger key in the picker is fixed to 'tab'.
`);
}

// ----------------------- Main -----------------------
async function main() {
	if (process.argv.includes("--help")) {
		showHelp();
		return;
	}

	config = parseConfig();
	initDb(config.dbPath);
	prepareStatements();

	const isReset = process.argv.includes("--reset");

	if (isReset) {
		// Force logging to be enabled for reset operations
		config.logInfo = true;
		clearDataStore();
		log("INFO", "Rebuilding data store...");
		const ok = await performRefresh();
		if (!ok) fatal("Data store rebuild failed.");
		log("INFO", "Data store rebuild completed.");
		return;
	}

	// Handle --clearcontext flag
	if (config.clearContextFlag) {
		clearStoredContexts();
		return;
	}

	// Extract positional arguments (non-flag arguments and skip --context value)
	let filteredArgs = process.argv.slice(2);

	// Remove --context and its value from the args for positional parsing
	const contextArgIndex = filteredArgs.findIndex(
		(arg: string) => arg === "--context" || arg.startsWith("--context="),
	);
	if (contextArgIndex !== -1) {
		if (filteredArgs[contextArgIndex].startsWith("--context=")) {
			// Remove just the --context=value argument
			filteredArgs.splice(contextArgIndex, 1);
		} else {
			// Remove --context and its separate value argument
			filteredArgs.splice(contextArgIndex, 2);
		}
	}

	// Filter out all flags to get positional arguments
	const positionalArgs = filteredArgs
		.filter(
			(arg: string) => !arg.startsWith("--") || arg.startsWith("--context="),
		)
		.filter((arg: string) => !arg.startsWith("--context="));
	const initialQuery =
		positionalArgs.length > 0 ? positionalArgs.join(" ") : undefined;

	// Add contexts to database if provided
	if (config.contexts) {
		addContexts(config.contexts);
	}

	// Get stored contexts from database and use them for filtering
	const storedContexts = getStoredContexts();
	let activeContexts: string[] | undefined;

	if (config.allFlag) {
		// --all flag disables all context filtering for this run
		activeContexts = undefined;
		log("INFO", "Context filtering disabled for this run (--all flag)");
	} else {
		// Use provided contexts or stored contexts
		activeContexts =
			config.contexts ||
			(storedContexts.length > 0 ? storedContexts : undefined);

		if (activeContexts && activeContexts.length > 0) {
			log("INFO", `Using context filters: ${activeContexts.join(", ")}`);
		}
	}

	const hasProjects =
		(db.query("SELECT COUNT(*) as c FROM projects").get() as { c: number }).c >
		0;
	const cold = !hasProjects;
	if (cold) {
		// Force logging to be enabled for initial data fetch
		config.logInfo = true;
		log("INFO", "Initial data fetch in progress...");
		const ok = await performRefresh();
		if (!ok) fatal("Initial fetch failed.");
	} else {
		if (shouldThrottle()) {
			log("INFO", "Refresh interval not elapsed; using cached data.");
		} else {
			log("INFO", "Starting background refresh.");
			// Fire and forget
			performRefresh().then((ok) => {
				if (!ok) log("WARN", "Background refresh failed.");
			});
		}
	}

	const picked = await pickProject(initialQuery, activeContexts);
	if (!picked) {
		log("INFO", "No project selected.");
		return;
	}
	log("INFO", `Selected: ${picked.full_path} (action=${picked.action})`);
	if (picked.action === "clone") await cloneProject(picked);
	else openUrl(picked.web_url);
}

main().catch((e) => fatal(e.message));
