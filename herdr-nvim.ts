/**
 * Open a file at a line in a reusable neovim tab inside herdr.
 *
 * One nvim per pi process, started in its own herdr tab with
 * `--listen <socket>`. Later requests go to that nvim over the socket
 * (`:drop` reuses the buffer when the file is already open, otherwise opens
 * it in a new one) and focus its tab. If nvim quit, the tab's shell is
 * reused; if the tab is gone, a new one is created.
 */
import { execFile } from "node:child_process";
import { existsSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";

const TIMEOUT_MS = 5000;
const SOCKET = path.join(tmpdir(), `pi-split-view-nvim-${process.pid}.sock`);

let tab: { tabId: string; paneId: string } | undefined;
/** Serialises requests so a fast second double-click can't race tab creation. */
let queue: Promise<void> = Promise.resolve();

export const inHerdr = () => process.env.HERDR_ENV === "1";

function run(cmd: string, args: string[]): Promise<string> {
	return new Promise((resolve, reject) => {
		execFile(cmd, args, { timeout: TIMEOUT_MS }, (err, stdout, stderr) => {
			if (err) reject(new Error((stderr || err.message).trim()));
			else resolve(stdout);
		});
	});
}

const herdr = (...args: string[]) =>
	run(process.env.HERDR_BIN_PATH || "herdr", args);

/** POSIX single-quoting; `'\''` also works in fish. */
const shQuote = (s: string) => `'${s.replace(/'/g, "'\\''")}'`;
/** Vim single-quoted string literal. */
const vimQuote = (s: string) => `'${s.replace(/'/g, "''")}'`;

/** Ask the running nvim to show file:line. Rejects when no nvim is listening. */
function remoteOpen(file: string, line: number): Promise<string> {
	const cmds = [
		`'drop ' .. fnameescape(${vimQuote(file)})`,
		`'${line}'`,
		`'normal! zz'`,
	];
	return run("nvim", [
		"--server",
		SOCKET,
		"--remote-expr",
		`execute([${cmds.join(", ")}])`,
	]);
}

async function tabAlive(tabId: string): Promise<boolean> {
	try {
		await herdr("tab", "get", tabId);
		return true;
	} catch {
		return false;
	}
}

function launchCommand(file: string, line: number): string {
	return `nvim --listen ${shQuote(SOCKET)} +${line} -- ${shQuote(file)}`;
}

/** A stale socket file (nvim crashed) makes `--listen` fail. */
function clearStaleSocket(): void {
	try {
		if (existsSync(SOCKET)) unlinkSync(SOCKET);
	} catch {
		/* ignore */
	}
}

async function open(file: string, line: number, cwd: string): Promise<void> {
	if (tab && !(await tabAlive(tab.tabId))) tab = undefined;
	if (tab) {
		try {
			await remoteOpen(file, line);
		} catch {
			// The tab is alive but nvim is not: start it again in that shell.
			clearStaleSocket();
			await herdr("pane", "run", tab.paneId, launchCommand(file, line));
		}
		await herdr("tab", "focus", tab.tabId);
		return;
	}
	clearStaleSocket();
	const args = ["tab", "create", "--cwd", cwd, "--label", "nvim", "--focus"];
	const ws = process.env.HERDR_WORKSPACE_ID;
	if (ws) args.push("--workspace", ws);
	const res = JSON.parse(await herdr(...args))?.result;
	const tabId = res?.tab?.tab_id;
	const paneId = res?.root_pane?.pane_id;
	if (typeof tabId !== "string" || typeof paneId !== "string")
		throw new Error("herdr tab create returned no tab/pane id");
	tab = { tabId, paneId };
	await herdr("pane", "run", paneId, launchCommand(file, line));
}

/** Queue an open request; errors are reported through `onError`. */
export function openInHerdrNvim(
	file: string,
	line: number,
	cwd: string,
	onError: (message: string) => void,
): void {
	queue = queue
		.then(() => open(file, line, cwd))
		.catch((e) => onError(e instanceof Error ? e.message : String(e)));
}
