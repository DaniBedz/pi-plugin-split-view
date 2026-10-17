/**
 * Time chips: rounded pills (same look as pi-plugin-statusbar's) showing when
 * an entry was posted and how long that step took.
 */

const PILL = "43;43;43";
const LEFT_CAP = "\uE0B6";
const RIGHT_CAP = "\uE0B4";

/** One pill. Only resets fg/bg (39/49), never a full SGR reset, so it can
 * sit inside a line that is styled around it. */
export function chip(text: string): string {
	return (
		`\x1b[38;2;${PILL}m${LEFT_CAP}\x1b[48;2;${PILL}m\x1b[39m ${text} ` +
		`\x1b[49m\x1b[38;2;${PILL}m${RIGHT_CAP}\x1b[39m`
	);
}

const p2 = (n: number) => String(n).padStart(2, "0");

/** Wall-clock time: `12:34:05` today, `Oct 16 12:34` on earlier days. */
export function formatClock(at: number, now = Date.now()): string {
	const d = new Date(at);
	if (d.toDateString() === new Date(now).toDateString())
		return `${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`;
	const day = d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
	return `${day} ${p2(d.getHours())}:${p2(d.getMinutes())}`;
}

/** Duration: `8s`, `1m23s`, `1h02m`. */
export function formatElapsed(ms: number): string {
	const s = Math.max(0, Math.floor(ms / 1000));
	if (s < 60) return `${s}s`;
	const m = Math.floor(s / 60);
	if (m < 60) return `${m}m${p2(s % 60)}s`;
	return `${Math.floor(m / 60)}h${p2(m % 60)}m`;
}

/**
 * Posted-at chip, plus a duration chip when the step's end is known (`end`)
 * or it is still running (`live`, counting up to now).
 */
export function timeChips(
	mute: (s: string) => string,
	at: number,
	end: number | undefined,
	live = false,
): string {
	const now = Date.now();
	let out = chip(mute(formatClock(at, now)));
	const stop = end ?? (live ? now : undefined);
	if (stop !== undefined && stop >= at)
		out += " " + chip(mute(formatElapsed(stop - at)));
	return out;
}

const ANSI = /\x1b\[[0-9;:]*[A-Za-z]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;
const BG_SGR = /\x1b\[(?:[0-9;:]*;)?(?:4[0-8]|10[0-7])[;:m]/;

/** A row with no text and no background colour, safe to draw a chip into. */
export function isPlainBlank(line: string | undefined): boolean {
	if (line === undefined) return false;
	return line.replace(ANSI, "").trim() === "" && !BG_SGR.test(line);
}
