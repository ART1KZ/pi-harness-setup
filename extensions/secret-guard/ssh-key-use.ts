/**
 * SSH key *use* without key *read*.
 *
 * A private key under `.ssh` stays blocked as a file operand for every tool and every
 * reader command (`cat`, `grep`, `base64`, `cp`, `read`, ...). The single exemption is
 * the *identity argument* of an ssh-family command — `ssh -i KEY host`, `scp -i KEY ...`,
 * `sftp -i KEY`, `ssh-add KEY` — where the ssh binary reads the file itself and its bytes
 * never reach a tool result.
 *
 * The exemption is positional, not value based: matching argument spans are deleted from
 * the command text before path candidates are extracted. A second occurrence of the same
 * path (`ssh -i KEY host 'cat KEY'`, `-o "ProxyCommand=cat KEY"`, `ssh -i KEY host && cat KEY`)
 * therefore still shows up as a path and is still blocked.
 *
 * Not a sandbox: `bash -c 'cat ~/.ss""h/key'` defeats any text-level check. The mitigation
 * for that layer is output-side (see `redactPrivateKeyBlocks`), not input-side.
 *
 * Deliberately NOT exempted (stays blocked; use the literal `-i KEY` form instead):
 *   - nested forms: `rsync -e "ssh -i KEY"`, `git -c core.sshCommand="ssh -i KEY"`, `$(ssh -i KEY)`
 *   - loops/assignments: `for k in KEY; do ssh -i $k host; done` (KEY is not an argument of ssh)
 *   - command heads reached through `sudo -u user`: the head token is the user name, not `ssh`
 *   - rsync's own `-i` (that is `--itemize-changes`, and the following operand is a *source*
 *     path that rsync would copy elsewhere — rsync is not an ssh head here on purpose)
 */

export const SSH_KEY_USE_PLACEHOLDER = "__ssh_identity__";

/** Command heads whose `-i` / `--identity` argument is a private key path. */
const SSH_HEADS = new Set(["ssh", "scp", "sftp", "ssh-add"]);

/** Wrappers that can precede the real command head. */
const COMMAND_PREFIXES = new Set([
	"sudo",
	"command",
	"env",
	"nohup",
	"time",
	"exec",
	"builtin",
	"start",
	"do",
	"then",
]);

type Item = {
	kind: "word" | "sep";
	start: number;
	end: number;
	/** Word text without wrapping quotes; empty for separators. */
	inner: string;
	innerStart: number;
	innerEnd: number;
};

/**
 * Quote-aware scan. Separators (`;` `|` `&` newline) inside quotes are NOT separators —
 * otherwise `cat 'x; ssh -i KEY y'` would look like an ssh command and lose the block.
 */
function scanCommand(command: string): Item[] {
	const items: Item[] = [];
	const n = command.length;
	let i = 0;
	while (i < n) {
		const ch = command[i];
		if (ch === ";" || ch === "|" || ch === "&" || ch === "\n") {
			const start = i;
			while (i < n && (command[i] === ";" || command[i] === "|" || command[i] === "&" || command[i] === "\n")) i++;
			items.push({ kind: "sep", start, end: i, inner: "", innerStart: i, innerEnd: i });
			continue;
		}
		if (ch === " " || ch === "\t" || ch === "\r") {
			i++;
			continue;
		}
		const start = i;
		let quote = "";
		while (i < n) {
			const c = command[i];
			if (quote) {
				if (c === quote) quote = "";
				i++;
				continue;
			}
			if (c === '"' || c === "'" || c === "`") {
				quote = c;
				i++;
				continue;
			}
			if (c === " " || c === "\t" || c === "\r" || c === "\n" || c === ";" || c === "|" || c === "&") break;
			i++;
		}
		const raw = command.slice(start, i);
		const head = raw[0];
		const wrapped = raw.length > 1 && (head === '"' || head === "'" || head === "`") && raw[raw.length - 1] === head;
		const innerStart = wrapped ? start + 1 : start;
		const innerEnd = wrapped ? i - 1 : i;
		items.push({ kind: "word", start, end: i, inner: command.slice(innerStart, innerEnd), innerStart, innerEnd });
	}
	return items;
}

/** `(ssh`, `!ssh`, `$ssh`, `ssh)`, `ssh.exe`, `/usr/bin/ssh` -> `ssh`. */
export function baseName(word: string): string {
	return word
		.replace(/^[({!$]+/, "")
		.replace(/[)}]+$/, "")
		.replace(/\.exe$/i, "")
		.replace(/^.*[\\/]/, "")
		.toLowerCase();
}

const isAssignment = (word: string) => /^[A-Za-z_][A-Za-z0-9_]*=/.test(word);

function maskSegment(words: Item[], spans: Array<[number, number]>): void {
	let head = 0;
	while (head < words.length && (isAssignment(words[head].inner) || COMMAND_PREFIXES.has(baseName(words[head].inner)))) head++;
	if (head >= words.length || !SSH_HEADS.has(baseName(words[head].inner))) return;

	const mask = (start: number, end: number) => {
		if (end > start) spans.push([start, end]);
	};
	// ssh-add takes key files as bare operands (`ssh-add <key>`); it never prints them.
	const isSshAdd = baseName(words[head].inner) === "ssh-add";

	for (let k = head + 1; k < words.length; k++) {
		const word = words[k];
		const inner = word.inner;
		if (!inner) continue;

		if (isSshAdd && !inner.startsWith("-")) {
			mask(word.innerStart, word.innerEnd);
			continue;
		}

		// `-i KEY` / `--identity KEY`
		if (inner === "-i" || inner === "--identity") {
			const next = words[k + 1];
			if (next && next.inner && !next.inner.startsWith("-")) {
				mask(next.innerStart, next.innerEnd);
				k++;
			}
			continue;
		}

		// `-iKEY`, `-i=KEY`, `--identity=KEY`
		const glued = /^(?:-i|--identity)=?(.+)$/.exec(inner);
		if (glued?.[1]) {
			mask(word.innerStart + inner.length - glued[1].length, word.innerEnd);
			continue;
		}

		// `-oIdentityFile=KEY`, `-o=IdentityFile=KEY`
		const option = /^-o=?IdentityFile=(.*)$/i.exec(inner);
		if (option?.[1]) {
			mask(word.innerStart + inner.length - option[1].length, word.innerEnd);
			continue;
		}

		// `-o IdentityFile=KEY`
		if (inner === "-o" || inner === "-o=") {
			const next = words[k + 1];
			const value = next ? /^IdentityFile=(.+)$/i.exec(next.inner) : null;
			if (next && value?.[1]) {
				mask(next.innerStart + next.inner.length - value[1].length, next.innerEnd);
				k++;
			}
		}
	}
}

/**
 * Replace ssh identity argument spans with a neutral placeholder so the path is not
 * reported as a file access. Everything else in the command is left byte-identical.
 */
export function maskSshIdentityArgs(command: string, enabled = true): string {
	if (!enabled || !command) return command;
	// Cheap prefilter: most command lines never mention an ssh-family tool at all. A permissive
	// filter is safe — masking is gated on the segment head anyway.
	if (!/(?:ssh|scp|sftp|-i|identity)/i.test(command)) return command;

	const spans: Array<[number, number]> = [];
	let segment: Item[] = [];
	const flush = () => {
		if (segment.length > 0) maskSegment(segment, spans);
		segment = [];
	};
	for (const item of scanCommand(command)) {
		if (item.kind === "sep") flush();
		else segment.push(item);
	}
	flush();
	if (spans.length === 0) return command;

	// Splice back-to-front so earlier offsets stay valid.
	const out = command.split("");
	for (const [start, end] of [...spans].sort((a, b) => b[0] - a[0] || b[1] - a[1])) {
		out.splice(start, end - start, SSH_KEY_USE_PLACEHOLDER);
	}
	return out.join("");
}

/** Tools whose input is a shell command line — the only place the `-i` exemption applies. */
const SHELL_TOOLS = new Set(["bash", "shell", "sh", "zsh", "exec", "terminal", "command", "run"]);

export function isShellToolName(name: string): boolean {
	const n = (name ?? "").toLowerCase();
	return SHELL_TOOLS.has(n) || /(?:^|_)bash$/.test(n) || /(?:^|_)shell$/.test(n);
}

/**
 * Output-side backstop for private keys: even if key bytes reach a tool result through a
 * path this guard did not recognise, the PEM block never enters the model context.
 * Covers PKCS#1/PKCS#8/OpenSSH (`-----BEGIN ... PRIVATE KEY-----`) and SSH2 (`---- BEGIN ...`).
 */
const PEM_BLOCK_RES: RegExp[] = [
	/-----BEGIN(?: [A-Z0-9]+)* PRIVATE KEY-----[\s\S]*?-----END(?: [A-Z0-9]+)* PRIVATE KEY-----/g,
	/----[- ]BEGIN(?: [A-Z0-9]+)* PRIVATE KEY[- ]-{0,4}[\s\S]*?----[- ]END(?: [A-Z0-9]+)* PRIVATE KEY[- ]-{0,4}/g,
];

export function redactPrivateKeyBlocks(text: string, label = "[REDACTED:PRIVATE-KEY]"): string {
	if (!text || !text.includes("PRIVATE KEY")) return text;
	let out = text;
	for (const re of PEM_BLOCK_RES) out = out.replace(re, label);
	return out;
}
