/**
 * secret-guard — use secrets without letting their values reach the model.
 *
 * Threat model: the only path to a provider is "tool output -> context -> session
 * file". So the invariant enforced here is *"no secret value ever appears in tool
 * output"*, not "the agent cannot read files".
 *
 * Enforcement points:
 *   1. Values live in a DPAPI-encrypted vault on disk and in this process's memory.
 *   2. Values are injected per-spawn into the bash child environment (spawnHook), so
 *      they are usable as $NAME but never appear in command text — and, critically,
 *      never in this process's `process.env`, which child agents inherit while
 *      running with `--no-extensions` (no guard loaded there).
 *   3. Every tool result is scrubbed (exact / base64 / url-encoded / hex forms).
 *   4. Reads and shell access to secret-bearing paths are blocked up front — with two narrow
 *      exceptions where the path may be *named* while its bytes stay unreadable: metadata-only
 *      shell heads (see `metadataCommands`) and public material (`*.pub`, host fingerprints).
 *      `write`/`edit` are judged by their target path, not by the text of the payload.
 *   5. SSH private keys get the other shaped exception: the *identity argument* of
 *      ssh/scp/sftp/ssh-add is exempted positionally, so a key can be used to connect while
 *      `cat <key>`, `cp <key>`, `base64 <key>` and every second occurrence of the same path
 *      stay blocked (see ./ssh-key-use.ts). Output backstop: PEM blocks are scrubbed even
 *      when the vault is empty.
 *
 * Setup:  powershell -NoProfile -File ~/.pi/agent/secrets/setup.ps1 -Add MY_API_KEY
 * Status: /secrets
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import {
	createBashTool,
	createLocalBashOperations,
	getAgentDir,
	type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { baseName, isShellToolName, maskSshIdentityArgs, redactPrivateKeyBlocks } from "./ssh-key-use.ts";

const AGENT_DIR = getAgentDir().replace(/\\/g, "/");
const SECRETS_DIR = join(AGENT_DIR, "secrets").replace(/\\/g, "/");
const ENTRIES_DIR = join(SECRETS_DIR, "entries").replace(/\\/g, "/");
const CONFIG_PATH = join(SECRETS_DIR, "config.json");
const SECRET_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]{1,63}$/;

type Config = {
	minSecretLength: number;
	injectIntoBash: boolean;
	injectIntoUserBash: boolean;
	protectUserBash: boolean;
	exposeToChildProcesses: boolean;
	allowPathPatterns: string[];
	blockedPathPatterns: string[];
	writeBlockedPathPatterns: string[];
	/** Let ssh/scp/sftp/ssh-add read a key file as their identity argument. */
	allowSshKeyUse: boolean;
	/** Scrub PEM private-key blocks from tool output even when the vault is empty. */
	redactPrivateKeys: boolean;
	/**
	 * Shell heads allowed to *name* a blocked path, because all they can expose is metadata:
	 * permissions, ownership, timestamps, names, sizes, fingerprints. None of them prints file
	 * contents and none can run a nested command. Every entry is a hole in the path check by
	 * construction, so keep the list short.
	 */
	metadataCommands: string[];
	/**
	 * Basenames allowed inside *any* blocked directory: public key material is not a secret, and
	 * a host-fingerprint file names hosts rather than credentials. Deliberately a basename rule
	 * instead of a path glob — a glob matching a file called `config` would also open `.kube/config`.
	 */
	allowedBasenames: string[];
};

/**
 * Read block list: credentials with no legitimate "look at the variable names" use
 * case. Certificates, `.env` and friends are deliberately NOT here — they are normal
 * work, and the redaction dictionary covers their values once they are in the vault.
 */
const DEFAULT_CONFIG: Config = {
	minSecretLength: 8,
	injectIntoBash: true,
	injectIntoUserBash: true,
	protectUserBash: true,
	exposeToChildProcesses: false,
	allowPathPatterns: [],
	// Key material stays unreadable, but it must remain *usable*: the identity argument of an
	// ssh-family command is exempted from the path block (positionally, see ssh-key-use.ts).
	// Set false to go back to "the path may not appear anywhere at all".
	allowSshKeyUse: true,
	// Dictionary-independent backstop: PEM blocks are scrubbed from every tool result, so a
	// leak that slipped past the path check still does not reach the context.
	redactPrivateKeys: true,
	// ls/stat/icacls-style heads: the path is named, the bytes are not. `ssh-keygen` is here because
	// it reads a key only to derive a fingerprint or a *public* key.
	metadataCommands: ["icacls", "cacls", "takeown", "attrib", "stat", "chmod", "chown", "ls", "dir", "vdir", "ssh-keygen"],
	allowedBasenames: ["known_hosts", "known_hosts.old"],
	blockedPathPatterns: [
		"**/.pi/agent/secrets/**",
		"**/.pi/agent/auth.json",
		"**/.ssh/**",
		"**/id_rsa*",
		"**/id_ed25519*",
		"**/id_ecdsa*",
		"**/.aws/credentials",
		"**/.gnupg/**",
		"**/.netrc",
		"**/.pgpass",
		"**/.docker/config.json",
		"**/.kube/config",
	],
	// Writes are blocked only where destroying the file would be unrecoverable:
	// the vault itself, pi's provider credentials, and private key material.
	writeBlockedPathPatterns: [
		"**/.pi/agent/secrets/**",
		"**/.pi/agent/auth.json",
		"**/.ssh/**",
		"**/id_rsa*",
		"**/id_ed25519*",
		"**/id_ecdsa*",
		"**/.gnupg/**",
	],
};

function loadConfig(): Config {
	try {
		if (!existsSync(CONFIG_PATH)) return DEFAULT_CONFIG;
		const parsed = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
		return { ...DEFAULT_CONFIG, ...parsed };
	} catch {
		return DEFAULT_CONFIG;
	}
}

// ---------------------------------------------------------------- glob matching

function globToRegExp(glob: string): RegExp {
	const g = glob.replace(/\\/g, "/");
	let out = "^";
	for (let i = 0; i < g.length; i++) {
		const ch = g[i];
		if (ch === "*") {
			if (g[i + 1] === "*") {
				i++;
				if (g[i + 1] === "/") {
					i++;
					out += "(?:.*/)?";
				} else {
					out += ".*";
				}
			} else {
				out += "[^/]*";
			}
		} else if (ch === "?") {
			out += "[^/]";
		} else {
			out += ch.replace(/[.+^${}()|[\]\\]/g, "\\$&");
		}
	}
	return new RegExp(`${out}$`);
}

// ---------------------------------------------------------------- secret state

type Redactor = { name: string; forms: string[] };

let secrets = new Map<string, string>();
let redactors: Redactor[] = [];
let config = DEFAULT_CONFIG;
let vaultStatus = "not loaded";

function buildRedactors(map: Map<string, string>) {
	const list: Redactor[] = [];
	for (const [name, value] of map) {
		if (!value || value.length < config.minSecretLength) continue;
		const forms = new Set<string>([value]);
		try {
			forms.add(Buffer.from(value, "utf8").toString("base64"));
		} catch {}
		try {
			forms.add(encodeURIComponent(value));
		} catch {}
		try {
			forms.add(Buffer.from(value, "utf8").toString("hex"));
		} catch {}
		// CRLF variants: shell output on Windows can normalize line endings, and an
		// unredacted multi-line value is exactly the case that would slip through.
		for (const form of [...forms]) {
			if (form.includes("\n")) {
				forms.add(form.replace(/\n/g, "\r\n"));
				forms.add(form.replace(/\r\n/g, "\n"));
			}
		}
		// Multi-line values (PEM, service-account JSON): `head -1` / `sed -n 2p` would
		// otherwise print a sensitive line that never matches the whole-value form.
		if (value.includes("\n")) {
			for (const line of value.split(/\r?\n/)) {
				const trimmed = line.trim();
				if (trimmed.length >= config.minSecretLength) forms.add(trimmed);
			}
		}
		list.push({ name, forms: [...forms].sort((a, b) => b.length - a.length) });
	}
	redactors = list;
}

function redact(text: string): string {
	if (!text) return text;
	let out = config.redactPrivateKeys ? redactPrivateKeyBlocks(text) : text;
	if (redactors.length === 0) return out;
	for (const { name, forms } of redactors) {
		for (const form of forms) {
			if (form.length >= 6 && out.includes(form)) out = out.split(form).join(`[REDACTED:${name}]`);
		}
	}
	return out;
}

/** Streaming redactor: holds back enough tail to never emit a split secret. */
function createStreamRedactor(emit: (chunk: string) => void) {
	const hold =
		Math.max(config.redactPrivateKeys ? 4096 : 0, ...redactors.flatMap((r) => r.forms.map((f) => f.length))) + 8;
	let buffered = "";
	return {
		push(chunk: string) {
			buffered += chunk;
			if (hold === 0) {
				emit(redact(buffered));
				buffered = "";
				return;
			}
			if (buffered.length <= hold) return;
			let cut = buffered.length - hold;
			// If the emitted region could end mid-secret, rewind to before its start.
			for (const { forms } of redactors) {
				for (const form of forms) {
					for (let k = Math.min(form.length - 1, cut); k >= 1; k--) {
						if (buffered.slice(cut - k, cut) === form.slice(0, k)) {
							cut -= k;
							break;
						}
					}
				}
			}
			if (cut <= 0) return;
			const head = buffered.slice(0, cut);
			buffered = buffered.slice(cut);
			emit(redact(head));
		},
		flush() {
			const rest = buffered;
			buffered = "";
			if (rest) emit(redact(rest));
		},
	};
}

// ---------------------------------------------------------------- path blocking

const blockRes: Array<{ glob: string; re: RegExp }> = [];
const writeBlockRes: Array<{ glob: string; re: RegExp }> = [];
const allowRes: RegExp[] = [];
let metadataHeads = new Set<string>();

function rebuildMatchers() {
	blockRes.length = 0;
	writeBlockRes.length = 0;
	allowRes.length = 0;
	for (const glob of config.blockedPathPatterns) blockRes.push({ glob, re: globToRegExp(glob) });
	for (const glob of config.writeBlockedPathPatterns) writeBlockRes.push({ glob, re: globToRegExp(glob) });
	for (const glob of config.allowPathPatterns) allowRes.push(globToRegExp(glob));
	metadataHeads = new Set(config.metadataCommands.map((cmd) => baseName(cmd)));
}

/**
 * Non-secret material: public keys (`.pub`) and host fingerprints. Probed for every blocked
 * directory rather than written as a path glob, because neither file type is a credential
 * anywhere — and because `config` would not be safe to allow by name (see `allowedBasenames`).
 */
function isPublicMaterial(p: string): boolean {
	const base = p.slice(p.lastIndexOf("/") + 1);
	return base.endsWith(".pub") || config.allowedBasenames.includes(base);
}

function blockedBy(absPath: string, forWrite = false): string | null {
	const p = absPath.replace(/\\/g, "/");
	if (allowRes.some((re) => re.test(p))) return null;
	if (isPublicMaterial(p)) return null;
	for (const { glob, re } of forWrite ? writeBlockRes : blockRes) if (re.test(p)) return glob;
	return null;
}

function tokens(text: string): string[] {
	return text
		.split(/[\s;|&()<>"'`=]+/)
		.map((t) => t.replace(/^[:,]+|[:,]+$/g, ""))
		.filter(Boolean);
}

/** Commands whose arguments are file operands — a bare `.env` after these IS a file access. */
const READERS = new Set([
	"cat", "bat", "head", "tail", "less", "more", "strings", "xxd", "od", "base64", "nl", "tac", "rev",
	"grep", "rg", "egrep", "fgrep", "ag", "ack", "awk", "gawk", "sed", "sort", "uniq", "cut", "tr", "jq", "yq",
	"cp", "copy", "mv", "move", "install", "scp", "rsync", "dd", "tar", "zip", "unzip", "7z",
	"node", "deno", "bun", "python", "python3", "py", "ruby", "perl", "php",
	"powershell", "powershell.exe", "pwsh", "cmd", "cmd.exe", "type", "get-content", "copy-item", "move-item",
	"select-string", "import-csv", "sh", "bash", "zsh", "source", ".",
]);

const looksLikePath = (s: string) => s.startsWith("~") || /^(\/|\\)|^\.\.?[\\/]/.test(s) || /[\\/]/.test(s);

/**
 * Whether a metadata-only head may name a blocked path. The exemption covers the whole command
 * line, so it is cancelled by anything that could hand the path to a reader or damage the file:
 * a pipe, a redirect, a background or single `&`, a backtick, a substitution, a brace group.
 * `;` and `&&` are separate segments that are judged on their own, so they stay allowed.
 */
function metadataExemptionHolds(command: string): boolean {
	if (/[`|&<>]/.test(command.replace(/&&/g, ""))) return false;
	if (/\$[({]/.test(command)) return false;
	return !command.includes("{");
}

function commandCandidates(command: string, cwd: string, push: (raw: string) => void) {
	const metadataOk = metadataExemptionHolds(command);
	for (const segment of command.split(/[;|]|&&|\n/)) {
		const words = tokens(segment).filter((w) => !w.startsWith("-") && w !== "sudo" && w !== "command");
		if (words.length === 0) continue;
		const head = words[0].toLowerCase();
		const reader = READERS.has(head);
		// Metadata-only heads (icacls, ls, stat, chmod, ssh-keygen, ...) may name the path itself:
		// permissions, ownership, names, sizes. They cannot print bytes, and the guard above keeps
		// them from being used as a carrier for something that can.
		const metadata = metadataOk && !reader && metadataHeads.has(baseName(head));
		for (const word of words.slice(1)) {
			// With a reader command, a bare sensitive basename (.env, id_rsa) is a real file
			// operand. Otherwise only path-shaped tokens count, so commit messages that merely
			// mention `.env` are not blocked.
			if (reader || looksLikePath(word)) {
				if (!metadata) push(word);
			}
		}
	}
}

/**
 * `pathsOnly` is set for the file-writing tools: their target path is what the block list is
 * about, while `content` / `oldText` / `newText` are payload. Scanning payload text blocked
 * ordinary work — documenting a path, writing a script that mentions one — without protecting
 * anything the target-path check does not already protect.
 */
function pathCandidates(input: unknown, cwd: string, maskKeyArgs = false, pathsOnly = false): string[] {
	const found = new Set<string>();
	const push = (raw: string) => {
		let s = raw.trim().replace(/^["'`]|["'`]$/g, "");
		if (!s || s.startsWith("$") || s.startsWith("-") || s.includes("://")) return;
		s = s.replace(/^file:\/\//, "");
		try {
			const expanded = s.startsWith("~") ? join(homedir(), s.slice(1)) : s;
			found.add((isAbsolute(expanded) ? expanded : resolve(cwd, expanded)).replace(/\\/g, "/"));
		} catch {}
	};
	const walk = (value: unknown, key: string | undefined) => {
		if (typeof value === "string") {
			if (key === "path" || key === "file_path" || key === "filePath" || key === "filename") push(value);
			else if (key === "command" || key === "cmd") commandCandidates(maskSshIdentityArgs(value, maskKeyArgs), cwd, push);
			else if (pathsOnly) return;
			else if (looksLikePath(value)) for (const t of tokens(value)) if (looksLikePath(t)) push(t);
		} else if (Array.isArray(value)) {
			for (const v of value) walk(v, key);
		} else if (value && typeof value === "object") {
			for (const [k, v] of Object.entries(value as Record<string, unknown>)) walk(v, k);
		}
	};
	walk(input, undefined);
	return [...found];
}

// ---------------------------------------------------------------- vault loading

function psEncoded(script: string): string {
	return Buffer.from(script, "utf16le").toString("base64");
}

async function loadVault(pi: ExtensionAPI): Promise<string> {
	const names: string[] = [];
	try {
		if (existsSync(ENTRIES_DIR)) {
			for (const file of readdirSync(ENTRIES_DIR)) {
				if (!file.endsWith(".dpapi")) continue;
				const name = file.slice(0, -6);
				if (SECRET_NAME_RE.test(name)) names.push(name);
			}
		}
	} catch (error) {
		return `entries dir unreadable: ${String(error)}`;
	}
	if (names.length === 0) {
		secrets = new Map();
		buildRedactors(secrets);
		return "no secrets stored";
	}

	// One PowerShell call decrypts every entry. Transport is `NAME<TAB>base64(value)`
	// so multi-line values survive and no JSON quoting quirks apply.
	const list = names.map((n) => `'${n}'`).join(",");
	const script = [
		"$ErrorActionPreference='Stop'",
		"Add-Type -AssemblyName System.Security | Out-Null",
		`$dir = '${ENTRIES_DIR.replace(/'/g, "''")}'`,
		`foreach ($n in @(${list})) {`,
		"  $p = Join-Path $dir ($n + '.dpapi')",
		"  if (-not (Test-Path -LiteralPath $p)) { continue }",
		"  $b = [Convert]::FromBase64String((Get-Content -Raw -LiteralPath $p).Trim())",
		"  $u = [System.Security.Cryptography.ProtectedData]::Unprotect($b, $null, 'CurrentUser')",
		"  $s = [Text.Encoding]::UTF8.GetString($u)",
		"  Write-Output ($n + [char]9 + [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($s)))",
		"}",
	].join("\n");

	const result = await pi.exec("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", psEncoded(script)], {
		timeout: 20000,
	});
	const stdout = result.stdout ?? "";
	const map = new Map<string, string>();
	for (const line of stdout.split(/\r?\n/)) {
		const idx = line.indexOf("\t");
		if (idx <= 0) continue;
		const name = line.slice(0, idx).trim();
		const b64 = line.slice(idx + 1).trim();
		if (!SECRET_NAME_RE.test(name) || !b64) continue;
		try {
			const value = Buffer.from(b64, "base64").toString("utf8");
			if (value.length >= config.minSecretLength) map.set(name, value);
		} catch {}
	}
	if (map.size === 0 && result.code !== 0) {
		return `dpapi decrypt failed (code ${result.code}): ${(result.stderr ?? "").trim().slice(0, 160)}`;
	}
	secrets = map;
	buildRedactors(secrets);
	const missing = names.length - map.size;
	return missing > 0 ? `${map.size}/${names.length} secret(s) held in memory (${missing} unavailable)` : `${map.size} secret(s) held in memory`;
}

// ---------------------------------------------------------------- extension

export default function (pi: ExtensionAPI) {
	config = loadConfig();
	rebuildMatchers();

	pi.on("session_start", async (_event, ctx) => {
		config = loadConfig();
		rebuildMatchers();
		vaultStatus = await loadVault(pi);
		// Invariant: values must not sit in process.env, because child agents
		// (pi-subagents / bg_delegate) inherit env but run with --no-extensions.
		for (const name of secrets.keys()) {
			if (process.env[name] !== undefined && process.env[name] === secrets.get(name)) {
				vaultStatus += ` | WARNING: ${name} also present in process env`;
			}
		}
		if (config.exposeToChildProcesses) {
			// Deliberate downgrade: child agents inherit process.env but run with
			// --no-extensions, so they get the value WITHOUT redaction.
			for (const [name, value] of secrets) process.env[name] = value;
			vaultStatus += " | EXPOSED to child processes (no redaction there)";
		}
		if (ctx.hasUI && secrets.size > 0) {
			ctx.ui.notify(`secret-guard: ${secrets.size} secret(s) armed`, "info");
		}
	});

	// 4. block access to secret-bearing paths (read/write/edit/shell/anything)
	pi.on("tool_call", async (event, ctx) => {
		const cwd = (ctx as { cwd?: string } | undefined)?.cwd ?? process.cwd();
		const forWrite = event.toolName === "write" || event.toolName === "edit";
		// The ssh `-i <key>` exemption applies to shell command lines only — never to the
		// read/write/edit tools, where the same path is still a file access.
		const maskKeyArgs = config.allowSshKeyUse && isShellToolName(event.toolName);
		for (const candidate of pathCandidates(event.input, cwd, maskKeyArgs, forWrite)) {
			const glob = blockedBy(candidate, forWrite);
			if (glob) {
				if (ctx.hasUI) ctx.ui.notify(`secret-guard blocked ${event.toolName}: ${candidate}`, "warning");
				return {
					block: true,
					reason:
						`secret-guard: "${candidate}" matches blocked pattern ${glob}. ` +
						"Secret values are never read into context — use the env var instead (e.g. `curl -H \"x-api-key: $NAME\" ...`). " +
						"See /secrets.",
				};
			}
		}
		return undefined;
	});

	// 2. inject values into the bash child environment only
	const spawnHook = (context: { command: string; cwd: string; env: NodeJS.ProcessEnv }) => {
		if (!config.injectIntoBash || secrets.size === 0) return context;
		const env = { ...context.env };
		for (const [name, value] of secrets) env[name] = value;
		return { ...context, env };
	};

	const toolCache = new Map<string, ReturnType<typeof createBashTool>>();
	const bashFor = (cwd: string) => {
		const key = cwd.replace(/\\/g, "/");
		let tool = toolCache.get(key);
		if (!tool) {
			tool = createBashTool(cwd, { spawnHook });
			toolCache.set(key, tool);
		}
		return tool;
	};

	pi.registerTool({
		...bashFor(process.cwd()),
		execute: (id, params, signal, onUpdate, ctx) =>
			bashFor((ctx as { cwd?: string } | undefined)?.cwd ?? process.cwd()).execute(id, params, signal, onUpdate, ctx),
	});

	// 3. scrub every tool result before it reaches the model or the session file
	pi.on("tool_result", async (event) => {
		if (redactors.length === 0 && !config.redactPrivateKeys) return undefined;
		const patch: Record<string, unknown> = {};
		if (Array.isArray(event.content)) {
			let changed = false;
			const content = event.content.map((part) => {
				const p = part as { type?: string; text?: string };
				if (p?.type === "text" && typeof p.text === "string") {
					const next = redact(p.text);
					if (next !== p.text) {
						changed = true;
						return { ...p, text: next };
					}
				}
				return part;
			});
			if (changed) patch.content = content;
		}
		if (event.details !== undefined) {
			const json = JSON.stringify(event.details);
			if (json && redact(json) !== json) {
				try {
					patch.details = JSON.parse(redact(json));
				} catch {}
			}
		}
		return Object.keys(patch).length > 0 ? (patch as never) : undefined;
	});

	// user `!` commands: same env injection, plus streaming output redaction
	if (config.protectUserBash) {
		pi.on("user_bash", () => {
			const local = createLocalBashOperations();
			return {
				operations: {
					async exec(command, cwd, options) {
						const stream = createStreamRedactor((chunk) => options.onData(Buffer.from(chunk)));
						const env =
							config.injectIntoUserBash && secrets.size > 0
								? { ...(options.env ?? process.env), ...Object.fromEntries(secrets) }
								: options.env;
						try {
							return await local.exec(command, cwd, { ...options, env, onData: (data: Buffer) => stream.push(data.toString("utf8")) });
						} finally {
							stream.flush();
						}
					},
				},
			};
		});
	}

	pi.registerCommand("secrets", {
		description: "secret-guard status: held secrets, vault state, enforcement check",
		handler: async (args, ctx) => {
			const sub = (args ?? "").trim().toLowerCase();
			if (sub === "reload") {
				vaultStatus = await loadVault(pi);
				ctx.ui.notify(`secret-guard reloaded: ${vaultStatus}`, "info");
				return;
			}
			const names = [...secrets.keys()].sort();
			const inEnv = names.filter((n) => process.env[n] === secrets.get(n));
			const lines = [
				`entries: ${ENTRIES_DIR}`,
				`status: ${vaultStatus}`,
				`secrets: ${names.length ? names.map((n) => `${n}(${secrets.get(n)?.length})`).join(", ") : "(none)"}`,
				`leaked into process env: ${inEnv.length ? inEnv.join(", ") : "no"}`,
				`bash injection: ${config.injectIntoBash ? "on" : "off"} · redaction forms: ${redactors.reduce((a, r) => a + r.forms.length, 0)}`,
				`ssh key use: ${config.allowSshKeyUse ? "identity args only (reads still blocked)" : "blocked"} · private-key redaction: ${config.redactPrivateKeys ? "on" : "off"}`,
				`blocked (read): ${config.blockedPathPatterns.length} · blocked (write): ${config.writeBlockedPathPatterns.length}`,
				`metadata-only heads: ${config.metadataCommands.join(", ")} · always allowed: *.pub, ${config.allowedBasenames.join(", ")}`,
			];
			ctx.ui.notify(lines.join("\n"), "info");
		},
	});
}
