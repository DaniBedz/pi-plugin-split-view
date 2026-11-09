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

/** Keep the last `max` chars of `s` (as `… tail`), never cutting inside an
 * escape sequence: a cut mid-sequence prints its tail (`;43;43m`) as text. */
export function capTail(s: string, max: number): string {
	if (s.length <= max) return s;
	let cut = s.length - Math.max(1, max - 2);
	for (const m of s.matchAll(ANSI)) {
		if (m.index >= cut) break;
		if (m.index + m[0].length > cut) {
			cut = m.index + m[0].length;
			break;
		}
	}
	return "… " + s.slice(cut);
}
const ANSI_AT = new RegExp(ANSI.source, "y");
const SGR = /\x1b\[[0-9;:]*m/g;
const TRAILING_PAD = /( +)((?:\x1b\[[0-9;:]*m)*)$/;

/**
 * Put `chips` before the first visible character of a rendered row, as the
 * thinking panel does. The row's colours are re-applied after them (a chip
 * resets fg/bg) and the width comes out of its trailing padding, truncating
 * only when there isn't enough. undefined when the row has no text.
 */
export function prefixChips(
	line: string,
	chips: string,
	width: number,
	truncate: (s: string, w: number) => string,
	widthOf: (s: string) => number,
): string | undefined {
	let i = 0;
	while (i < line.length) {
		ANSI_AT.lastIndex = i;
		const m = ANSI_AT.exec(line);
		if (m) i += m[0].length;
		else if (line[i] === " ") i++;
		else break;
	}
	if (i >= line.length) return undefined;
	const active = (line.slice(0, i).match(SGR) ?? []).join("");
	const need = widthOf(chips) + 1;
	const pad = TRAILING_PAD.exec(line);
	const body =
		pad && pad[1].length >= need
			? line.slice(0, pad.index) + " ".repeat(pad[1].length - need) + pad[2]
			: line;
	// A chip's bg reset would show the terminal background on a tinted row.
	const tinted = chips.replaceAll("\x1b[49m", "\x1b[49m" + active);
	const out = body.slice(0, i) + tinted + active + " " + body.slice(i);
	return widthOf(out) > width ? truncate(out, width) : out;
}
