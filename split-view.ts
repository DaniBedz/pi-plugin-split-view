/**
 * split-view.ts — unified panel TUI extension
 *
 * One extension owns the whole "split the main window" surface:
 *   - thinking panel  (top-left band)
 *   - tools panel     (top-right band)
 *   - files panel     (right dock side column, with an edit-diff subpanel)
 *
 * Layout (fullscreen, composed in ONE layer owned by layout-manager):
 *
 *   band on?  files on?
 *   ─────────────────────────────────────
 *   both  → HStack(VStack(band, transcript), filesDock)
 *   band  → VStack(band, transcript)
 *   files → HStack(transcript, filesDock)
 *   none  → transcript (no layer)
 *
 * With trimResponse on, "transcript" above is replaced by the response doc
 * ScrollView + the base root's reused editor dock (works standalone, without
 * band or files).
 *
 * Regular (non-fullscreen) mode: the files panel falls back to a non-capturing
 * overlay; the band needs the layout engine and only works in fullscreen.
 *
 * Commands:
 *   /split              full toggle pair: OFF = all panels off (bare pi
 *                       layout), ON = the panel flags saved as startup defaults
 *   /split-thinking     toggle the thinking panel within the band
 *   /split-tools        toggle the tools panel within the band
 *   /files              toggle the files panel (dock in fullscreen, overlay otherwise)
 *   /split-tools-view   toggle tool panel compact ↔ full detail
 *   /split-trim-response toggle panel C: pi transcript ↔ response-only view
 *   /split-height <n>   set the top band height in rows (6–40)
 *   /split-save       persist current layout as startup defaults for NEW
 *                     windows (toggles are session-local by default, so
 *                     concurrent pi windows don't clobber each other)
 *
 * Panels use the measurement-safe architecture: no separate border-column
 * flanks; the ScrollView's always-on scrollbar (track styled as border) IS the right frame
 * edge, and MeasurementSafeVStack subclasses make the engine's discarded
 * intrinsic-height measurement passes O(1) instead of eagerly rendering whole
 * subtrees (panels + transcript) every keystroke frame. Bodies render a
 * newest-first row-capped window (~96 rows). Full history stays in the
 * transcript; the band is a recent-history view.
 *
 * Panel C trim mode (trimResponse): the transcript region of pi's base root is
 * swapped for an extension-owned ScrollView over a document of user / assistant
 * messages (reused from branch + streamed live via pi's own message
 * components), so rendering matches the native transcript minus tool calls,
 * thinking blocks and extension custom entries. The editor dock
 * (pending/status/editor/footer) is reused verbatim, so input is untouched.
 *
 * Response-only is native-parity BY DESIGN (SV-09/SV-10/SV-18, USER DECISION
 * 2026-10-07, decisions/E-policy.md): it shows TEXT content only — pi's own
 * transcript renders user messages as text and drops non-text blocks, so
 * image-only user turns render nothing there either; it keeps FULL scrollback
 * (unbounded — pi's own transcript is unbounded and offers no virtualization
 * primitive, so this matches the platform's cost model, a constant factor
 * only); and it preserves the NUMERIC scroll offset across branch switches —
 * the ScrollView clamps the old offset into the new content, exactly like
 * the native transcript on the same /tree switch. Toggling trim itself does
 * not move the response doc's scroll position.
 *
 * Single-TUI-context assumption (SV-20): this extension and layout-manager.ts
 * assume ONE interactive TUI context per process. Module state (tuiRef, panel
 * flags, buffers) and the shared layout manager (one tuiRef / baseRoot / layer
 * map on globalThis) are singletons. pi does not guarantee this upstream, and
 * simultaneous TUI contexts in one process are unverified and unsupported.
 *
 * Performance: pi's renderCache is fresh every frame, so panels cache their
 * wrapped/styled output on a (version, width) key; unchanged frames are O(1).
 * requestRender() is gated on any panel being active.
 *
 * Shortcuts (ctrl+o/ctrl+t) are dropped: reserved built-ins, un-registrable.
 */

import {
	generateDiffString,
	renderDiff,
	AssistantMessageComponent,
	UserMessageComponent,
	SkillInvocationMessageComponent,
	parseSkillBlock,
	getMarkdownTheme,
	type ExtensionAPI,
	type ExtensionContext,
	type Theme,
} from "@earendil-works/pi-coding-agent";
import {
	Container,
	HStack,
	ScrollView,
	Spacer,
	VStack,
	type Component,
	type OverlayHandle,
	type TuiMouseEvent,
	type TuiMouseEventResult,
	wrapTextWithAnsi,
	sliceByColumn,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";
import {
	loadUiPanelsConfig,
	saveUiPanelsConfig,
	saveUiPanelsSizes,
	normalizeConfig,
	type ToolMode as ToolModeCfg,
} from "./ui-panels-config.ts";
import { inHerdr, openInHerdrNvim } from "./herdr-nvim.ts";
import {
	getBaseRoot,
	initLayoutManager,
	setLayoutLayer,
	isLayoutLayerActive,
	selfHealLayout,
} from "./layout-manager.ts";
import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import * as path from "node:path";

const WIDGET_KEY = "split-view";
const MAX_TOOLS = 60;
// Display window (logical lines) for the thinking panel. The full transcript
// keeps everything; the band is a recent-history view. Must stay small: the
// per-flush render cost is dominated by wrapping the visible window.
const MAX_LINES = 400;
// A newline-free streaming tail grows char by char; every flush re-wraps it
// (its key changes each time). Render only its recent suffix so per-flush
// work is bounded even for one giant paragraph.
const MAX_TAIL_CHARS = 2000;
const MAX_FILES = 500;
const MIN_TERM_WIDTH = 90;
const MAX_TOOL_OUTPUT_LINES = 20;
// OracleSpec body window: hard cap on FINAL VISUAL rows rendered by band
// panels (logical lines can wrap into many). ~2 viewports of scrollback.
const MAX_BODY_ROWS = 96;
// Hard cap on raw chars processed per logical line (giant-line guard).
const MAX_LINE_CHARS = 600;

/** Legend shown at the bottom of the files list. */
const LEGEND = "r read · w write · s seen(bash) · a subagent";

// ─── module-lifetime state ───────────────────────────────────────────────────

let tuiRef: any;
/** ctx.ui.notify, for module-level code (mouse handlers). */
let notifyRef:
	| ((message: string, type?: "info" | "warning" | "error") => void)
	| undefined;
let widgetSet = false;
let startupTimer: ReturnType<typeof setTimeout> | null = null;
/** SV-14: the saved startup composition is still unapplied. Armed in
 * session_start before reconstruct(); consumed by the widget factory (the
 * first point where the fullscreen root is available, BEFORE the first
 * paint) or by the deferred startup timer as a fallback. */
let startupPending = false;

// Overlay registry for the regular-mode files panel (survives /reload).
const REG_KEY = Symbol.for("pi.explored-files");
interface Registry {
	gen: number;
	active?: OverlayHandle | null;
	activeGen?: number;
	/** The overlay's component, stored so the extension — the valid lifecycle
	 * owner — can dispose it on close/shutdown (Option C: no ctx.ui.custom()
	 * promise exists to dispose it for us). decisions/D-overlay-lifecycle.md */
	panel?: FilesPanel | null;
}
const G = globalThis as Record<symbol, Registry>;
const REG: Registry = G[REG_KEY] ?? { gen: 0 };
G[REG_KEY] = REG;
const MY_GEN = ++REG.gen;

/** Terminal height, captured by the overlay's visible callback each render. */
let termHeight = 0;

// Panel enable flags (kept in sync with config; thinking/tools default true).
let thinkingOn = true;
let toolsOn = true;
let filesOn = false;
/** Files panel edit-diff subpanel (session-local; /split-diff, persisted by
 * /split-save). Off keeps the file list but drops the bottom diff section. */
let showDiff = false;
/** Response-only divider between successive assistant messages: "rule" (dim
 * dashed line) or "space" (plain blank line). Session-local; /split-divider,
 * persisted by /split-save. */
let answerDividerMode: "rule" | "space" = "rule";
let toolMode: ToolModeCfg = "compact";
/** Panel C: response-only view instead of pi's transcript (persisted). */
let trimResponse = false;
/** Top band height in rows (6–40, persisted; /split-height). */
let bandHeight = 14;
/** F: tools panel's share of the band width in percent (20–60, default 35,
 * persisted as toolsWidthPct; session-local, only /split-save writes it). */
let toolsWidthPct = 35;
/** Right dock width in columns once dragged (persisted as dockWidth); null =
 * the automatic 25%-of-terminal width, clamped to 34–48. */
let dockWidth: number | null = null;

/** SV-08: fingerprint of the live theme's panel-relevant colors, captured
 * when the composition was built. pi replaces the global theme object on a
 * theme change (extensions receive no event), and components/caches capture
 * ANSI at build time — so the widget render compares this fingerprint and
 * recomposes theme-dependent components on a change ONLY. */
let composedThemeFp: string | null = null;

function themeFingerprint(theme: Theme): string {
	return [
		theme.fg("border", "x"),
		theme.fg("accent", "x"),
		theme.fg("muted", "x"),
		theme.fg("thinkingText", "x"),
		theme.fg("toolOutput", "x"),
		theme.fg("success", "x"),
		theme.fg("error", "x"),
		theme.fg("warning", "x"),
		theme.fg("dim", "x"),
		theme.fg("text", "x"),
	].join("|");
}

// ─── thinking buffer ─────────────────────────────────────────────────────────

interface ThinkingBlock {
	lines: string[];
	tail: string;
	complete: boolean;
}

/**
 * Coalesce streaming appends: each token bumps `version`, which invalidates the
 * panel's (version, width) render cache → full re-wrap of all lines per frame.
 * During a stream we bump at most every THINK_RAF_MS instead, so keystroke
 * frames don't queue behind 5000-line re-wraps. Complete blocks + end() are
 * unaffected (they bump synchronously).
 */
const THINK_RAF_MS = 100;
let thinkFlushTimer: ReturnType<typeof setTimeout> | null = null;
let thinkDirty = false;

function flushThinking(): void {
	thinkFlushTimer = null;
	if (!thinkDirty) return;
	thinkDirty = false;
	thinking.version++;
	requestRender();
}

function cancelPendingThinkFlush(): void {
	thinkDirty = false;
	if (thinkFlushTimer) {
		clearTimeout(thinkFlushTimer);
		thinkFlushTimer = null;
	}
}

/**
 * Tools-side twin of the thinking flush: tool_execution_update can fire many
 * times per second while a command streams output; each bump would re-wrap
 * the tools window + repaint. Coalesce to ≤1 version bump per TOOLS_FLUSH_MS.
 * start/end stay synchronous (entry appears / finalizes immediately).
 */
const TOOLS_FLUSH_MS = 100;
let toolsFlushTimer: ReturnType<typeof setTimeout> | null = null;
let toolsDirty = false;

function flushTools(): void {
	toolsFlushTimer = null;
	if (!toolsDirty) return;
	toolsDirty = false;
	toolsVersionCounter++;
	requestRender();
}

function cancelPendingToolsFlush(): void {
	toolsDirty = false;
	if (toolsFlushTimer) {
		clearTimeout(toolsFlushTimer);
		toolsFlushTimer = null;
	}
}

function markToolsDirty(): void {
	toolsDirty = true;
	if (!toolsFlushTimer) toolsFlushTimer = setTimeout(flushTools, TOOLS_FLUSH_MS);
}

const thinking = {
	blocks: [] as ThinkingBlock[],
	current: null as ThinkingBlock | null,
	streaming: false,
	version: 0,
	start() {
		if (this.current && (this.current.lines.length || this.current.tail)) {
			this.current.complete = true;
			this.blocks.push(this.current);
		}
		this.current = { lines: [], tail: "", complete: false };
		this.streaming = true;
		this.version++;
	},
	append(delta: string) {
		if (!this.current) this.current = { lines: [], tail: "", complete: false };
		this.current.tail += delta;
		if (this.current.tail.length > MAX_TAIL_CHARS)
			this.current.tail = this.current.tail.slice(-MAX_TAIL_CHARS);
		let nl = this.current.tail.indexOf("\n");
		while (nl !== -1) {
			this.current.lines.push(this.current.tail.slice(0, nl));
			this.current.tail = this.current.tail.slice(nl + 1);
			nl = this.current.tail.indexOf("\n");
		}
		this.trim();
		thinkDirty = true;
		if (!thinkFlushTimer)
			thinkFlushTimer = setTimeout(flushThinking, THINK_RAF_MS);
	},
	end(text: string) {
		cancelPendingThinkFlush();
		if (this.current) {
			if (text) {
				// Authoritative final content: replace the accumulated buffer.
				this.current.lines = text.split(/\r?\n/);
				this.current.tail = "";
			} else if (this.current.tail) {
				// SV-21: an empty/omitted end payload must not wipe streamed
				// text — finalize the accumulated tail into the current block.
				this.current.lines.push(this.current.tail);
				this.current.tail = "";
			}
			this.current.complete = true;
			this.blocks.push(this.current);
			this.current = null;
			this.trim();
		}
		this.streaming = false;
		this.version++;
	},
	trim() {
		// Hard-bound the whole display buffer (oldest lines first, splicing
		// partially into the front/current block so a giant block trims instead
		// of vanishing). The old version only evicted whole completed blocks, so
		// an oversized current block or reconstruct() output could blow past
		// MAX_LINES.
		let excess = this.countLines() - MAX_LINES;
		while (excess > 0) {
			const b = this.blocks[0];
			if (!b) {
				if (this.current) {
					const cut = Math.min(excess, this.current.lines.length);
					this.current.lines.splice(0, cut);
					excess -= cut;
				}
				break;
			}
			if (b.lines.length <= excess) {
				this.blocks.shift();
				excess -= b.lines.length;
			} else {
				b.lines.splice(0, excess);
				excess = 0;
			}
		}
	},
	countLines() {
		let total = 0;
		for (const b of this.blocks) total += b.lines.length;
		if (this.current) total += this.current.lines.length;
		return total;
	},
	reset() {
		cancelPendingThinkFlush();
		this.blocks = [];
		this.current = null;
		this.streaming = false;
		this.version++;
	},
};

/** Drop leading/trailing blank lines and collapse internal blank runs so each
 * thinking entry only takes the rows its text needs. */
function compactLines(lines: string[]): string[] {
	const out: string[] = [];
	for (const l of lines) {
		const blank = l.trim() === "";
		if (blank && (out.length === 0 || out[out.length - 1].trim() === "")) continue;
		out.push(l);
	}
	while (out.length && out[out.length - 1].trim() === "") out.pop();
	return out;
}

function thinkingLines(theme: Theme, width: number): string[] {
	const out: string[] = [];
	const sep = theme.fg("dim", "─".repeat(Math.max(8, Math.min(60, width - 3))));
	for (const b of thinking.blocks) {
		const lines = compactLines(b.lines);
		if (lines.length === 0) continue;
		out.push(sep);
		for (const l of lines) out.push(l);
	}
	if (thinking.current) {
		const lines = compactLines(thinking.current.lines);
		if (out.length && (lines.length || thinking.current.tail)) out.push(sep);
		for (const l of lines) out.push(l);
		if (thinking.current.tail) out.push(thinking.current.tail);
	}
	return out;
}

// ─── response doc (panel C trim mode) ───────────────────────────────

/**
 * Panel C's document: user + assistant messages only, rendered with pi's own
 * transcript components. Built from the branch (session start / tree) and
 * streamed live (message_start/update/end). Assistant content is filtered to
 * drop thinking blocks (panel A owns those) — tool calls never render here
 * (panel B owns those), so an assistant message with no text is skipped.
 */
const responseDoc = new Container();
let streamingResponseComponent: AssistantMessageComponent | null = null;

/** Live theme proxy captured from ctx.ui.theme / the widget factory; it
 * resolves the current global theme on every access, so answer dividers never
 * go stale after a theme change (the doc is rebuilt on change anyway). */
let docTheme: Theme | null = null;

/** One dim rule separating consecutive assistant messages in the response-only
 *  doc. Dashed (and dim) so it reads fainter than the panel borders. */
class AnswerDivider implements Component {
	render(width: number): string[] {
		const rule = "┄".repeat(Math.max(0, width));
		return [docTheme ? docTheme.fg("dim", rule) : rule];
	}
	invalidate(): void {}
	dispose(): void {}
}

/** Role of the last message actually added to the response doc. */
let lastResponseRole: "user" | "assistant" | null = null;

/**
 * Begin a response-doc entry: always a blank spacer between turns, plus the
 * divider ONLY between two successive assistant messages (never around a user
 * message). `answerDivider` = "space" drops the rule, leaving plain
 * blank-line spacing.
 */
function beginResponseEntry(role: "user" | "assistant"): void {
	if (responseDoc.children.length > 0) responseDoc.addChild(new Spacer(1));
	if (
		role === "assistant" &&
		lastResponseRole === "assistant" &&
		answerDividerMode === "rule"
	)
		responseDoc.addChild(new AnswerDivider());
	lastResponseRole = role;
}

function messageText(msg: any): string {
	const c = msg?.content;
	if (typeof c === "string") return c;
	if (Array.isArray(c))
		return c
			.filter((p: any) => p?.type === "text" && typeof p.text === "string")
			.map((p: any) => p.text)
			.join("");
	return "";
}

/** Content with thinking blocks and tool calls stripped (panel C is response-only). */
function responseContent(msg: any): any[] {
	return (Array.isArray(msg?.content) ? msg.content : []).filter(
		(c: any) => c?.type !== "thinking" && c?.type !== "toolCall",
	);
}

/** Append a message to the response doc (user or assistant). */
function addResponseMessage(msg: any): void {
	try {
		if (msg.role === "user") {
			const text = messageText(msg);
			if (!text.trim()) return;
			beginResponseEntry("user");
			// A skill invocation shows as pi's collapsed one-line `[skill] name`
			// (click to expand), followed by any message typed after it.
			const skill = parseSkillBlock(text);
			if (skill) {
				responseDoc.addChild(
					new SkillInvocationMessageComponent(skill, getMarkdownTheme()),
				);
				if (!skill.userMessage?.trim()) return;
				responseDoc.addChild(new Spacer(1));
			}
			responseDoc.addChild(
				new UserMessageComponent(skill?.userMessage ?? text, getMarkdownTheme()),
			);
			return;
		}
		if (msg.role === "assistant") {
			const content = responseContent(msg);
			const hasText = content.some(
				(c: any) =>
					c?.type === "text" && typeof c.text === "string" && c.text.trim(),
			);
			// Keep empty-text messages whose stopReason shows an error marker.
			if (!hasText && msg.stopReason !== "error" && msg.stopReason !== "aborted")
				return;
			beginResponseEntry("assistant");
			// toolCalls are stripped too so the component's error/abort markers
			// render (it suppresses them when toolCalls exist — in the full
			// transcript the tool components show errors instead).
			responseDoc.addChild(
				new AssistantMessageComponent(
					{ ...msg, content },
					true,
					getMarkdownTheme(),
					"Thinking…",
					1,
					[],
				),
			);
		}
	} catch {
		/* theme not ready yet — skipped; rebuilt on next reconstruct */
	}
}

/** Rebuild the whole response doc from the current branch. */
function rebuildResponseDoc(ctx: ExtensionContext): void {
	responseDoc.clear();
	streamingResponseComponent = null;
	lastResponseRole = null;
	const branch = ctx.sessionManager.getBranch();
	for (const entry of branch) {
		if (entry.type !== "message") continue;
		const msg = (entry as any).message;
		if (msg) addResponseMessage(msg);
	}
}

/** Live-stream an assistant message into the doc (lazy: created on first visible text). */
function responseMessageUpdate(msg: any): void {
	if (msg?.role !== "assistant") return;
	const stripped = { ...msg, content: responseContent(msg) };
	const hasVisible = stripped.content.some(
		(c: any) => c?.type === "text" && typeof c.text === "string" && c.text.trim(),
	);
	if (!streamingResponseComponent) {
		// Pure tool-call / thinking rounds never create a component — no stray
		// spacers accumulate in the doc.
		if (!hasVisible) return;
		try {
			beginResponseEntry("assistant");
			streamingResponseComponent = new AssistantMessageComponent(
				undefined as any,
				true,
				getMarkdownTheme(),
				"Thinking…",
				1,
				[],
			);
			responseDoc.addChild(streamingResponseComponent);
		} catch {
			/* theme not ready */
			return;
		}
	}
	try {
		streamingResponseComponent.updateContent(stripped, true);
	} catch {
		/* ignore */
	}
}

function responseMessageEnd(msg: any): void {
	if (msg?.role !== "assistant") return;
	if (streamingResponseComponent) {
		try {
			streamingResponseComponent.updateContent(
				{ ...msg, content: responseContent(msg) },
				false,
			);
		} catch {
			/* ignore */
		}
		streamingResponseComponent = null;
	} else {
		// No component was streamed (no update fired, or thinking/tool-only
		// round): finalize from the full message — addResponseMessage itself
		// skips empty text and keeps error/abort markers.
		addResponseMessage(msg);
	}
}

// ─── tool buffer ─────────────────────────────────────────────────────────────

let toolsVersionCounter = 0;

interface ToolEntry {
	id: string;
	name: string;
	args: string;
	output: string;
	active: boolean;
	isError: boolean;
	subagent?: boolean;
	agent?: string;
}
const toolsBy = new Map<string, ToolEntry>();
const toolOrder: string[] = [];

/** True if c is a UTF-16 high (lead) surrogate — the first half of an astral
 * code point. Used to keep truncation cuts off surrogate-pair boundaries. */
function isHighSurrogate(c: number): boolean {
	return c >= 0xd800 && c <= 0xdbff;
}

function truncateInline(s: string, max = 40): string {
	const flat = s.replace(/\s+/g, " ").trim();
	if (flat.length <= max) return flat;
	let end = max - 1;
	// Never end mid surrogate pair (a lone trailing half renders as U+FFFD).
	if (end >= 1 && isHighSurrogate(flat.charCodeAt(end - 1))) end--;
	return flat.slice(0, end) + "…";
}

/** SV-16: storage cap for one tool's text (args JSON or result output), in
 * UTF-16 code units (≈ in-memory size of the stored string). Below pi's own
 * bash-output cap (50KB) so even maximal tool output is bounded here, and
 * ~2.7× the maximum displayed content (20 lines × 600 chars). */
const MAX_TOOL_TEXT_CHARS = 32 * 1024;

/** SV-16: bound one tool text to MAX_TOOL_TEXT_CHARS, keeping the NEWEST
 * suffix and prepending an explicit truncation marker. The cut is aligned to
 * a code point so a UTF-16 surrogate pair is never split. Text within the
 * cap passes through unchanged (byte-identical). */
function capToolText(s: string): string {
	if (s.length <= MAX_TOOL_TEXT_CHARS) return s;
	const total = s.length;
	const marker = `[truncated: newest ${MAX_TOOL_TEXT_CHARS} of ${total} chars]\n`;
	const budget = MAX_TOOL_TEXT_CHARS - marker.length;
	let end = s.length;
	let units = 0;
	while (end > 0 && units < budget) {
		// Width of the code point ENDING at `end`: an astral char occupies
		// end-2..end-1 (lead surrogate at end-2), so a pair is never split.
		const w = end >= 2 && isHighSurrogate(s.charCodeAt(end - 2)) ? 2 : 1;
		if (units + w > budget) break;
		units += w;
		end -= w;
	}
	return marker + s.slice(end);
}

function resultText(r: any): string {
	let text: string;
	if (typeof r === "string") text = r;
	else {
		const content = r?.content;
		if (typeof content === "string") text = content;
		else if (Array.isArray(content)) {
			text = content
				.filter((c: any) => c?.type === "text" && typeof c.text === "string")
				.map((c: any) => c.text)
				.join("");
		} else text = "";
	}
	// SV-16: bound the stored text before the caller splits/keeps lines.
	return capToolText(text);
}

function argsJson(args: any): string {
	try {
		// SV-16: bound the stored args JSON (newest suffix + marker).
		return capToolText(JSON.stringify(args ?? {}));
	} catch {
		return "";
	}
}

function setToolOutput(e: ToolEntry, text: string): void {
	// SV-16: cap BEFORE splitting so the split never sees unbounded text.
	const lines = capToolText(text).split(/\r?\n/);
	e.output = lines.slice(-MAX_TOOL_OUTPUT_LINES).join("\n");
}

/** SV-17: ingest one tool call through the SAME path for live events and
 * branch reconstruction (resume / session_tree), so the bounded buffer,
 * the newest-first display and the MAX_TOOLS eviction (oldest shifted out)
 * behave identically for resumed and live entries. */
function ingestToolCall(id: string, name: string, args: any): void {
	toolOrder.push(id);
	toolsBy.set(id, {
		id,
		name,
		args: argsJson(args),
		output: "",
		active: true,
		isError: false,
	});
	toolsVersionCounter++;
	if (toolOrder.length > MAX_TOOLS) {
		const evict = toolOrder.shift()!;
		toolsBy.delete(evict);
	}
}

/** SV-17: ingest one tool result, correlated to its call by id (live event
 * or resumed branch entry). A result whose call is not in the bounded buffer
 * (evicted or unknown) is ignored. */
function ingestToolResult(id: string, result: any, isError: boolean): void {
	const e = toolsBy.get(id);
	if (!e) return;
	const text = resultText(result);
	if (text) setToolOutput(e, text);
	e.active = false;
	e.isError = isError;
	cancelPendingToolsFlush();
	toolsVersionCounter++;
}

function toolLines(theme: Theme, width: number): string[] {
	const th = theme;
	const out: string[] = [];
	const full = toolMode === "full";
	// Text budget inside the frame: 1 col inset + ≥2 trailing pad cols
	// (the transient scrollbar paints over the pad, never the frame).
	const textWidth = Math.max(8, width - 3);
	for (const id of toolOrder) {
		const e = toolsBy.get(id);
		if (!e) continue;
		const mark = e.active
			? th.fg("warning", "●")
			: e.isError
				? th.fg("error", "✗")
				: th.fg("success", "✓");
		const name = e.active
			? th.fg("accent", e.name)
			: e.isError
				? th.fg("error", e.name)
				: th.fg("success", e.name);
		const badge = e.subagent ? th.fg("muted", `[${e.agent ?? "sub"}]`) : "";
		const prefix = `${mark} ${name}${badge}`;
		const room = textWidth - visibleWidth(prefix) - 1;
		const args =
			e.args && room >= 8
				? th.fg("muted", ` ${truncateInline(e.args, room)}`)
				: "";
		out.push(prefix + args);
		if (!full) {
			if (out.length > 1) out.splice(out.length - 1, 0, "");
			continue;
		}
		const content = (e.output || "")
			.split(/\r?\n/)
			.map((l) => l.trim())
			.filter(Boolean);
		if (content.length === 0) {
			if (e.active) out.push(th.fg("dim", "  · …"));
		} else {
			for (const l of content.slice(0, 2))
				out.push(th.fg("toolOutput", `  · ${truncateInline(l, textWidth - 4)}`));
			if (content.length > 2)
				out.push(th.fg("dim", `  · +${content.length - 2} more`));
		}
	}
	return out;
}

const toolsVersion = () => toolsVersionCounter;

// ─── files buffer ────────────────────────────────────────────────────────────

interface FileEntry {
	path: string;
	ops: string;
	count: number;
}
const files = new Map<string, FileEntry>();
let filesVersion = 0;

function pathsFrom(
	toolName: string,
	input: any,
): { abs: string; op: string }[] {
	const out: { abs: string; op: string }[] = [];
	if (toolName === "bash") {
		const cmd = typeof input?.command === "string" ? input.command : "";
		for (const raw of cmd.split(/\s+/)) {
			const tok = raw.replace(/^[("'`]+/, "").replace(/[)"'`;:,]+$/, "");
			if (!tok || tok.startsWith("-") || /[|&><`$*?]/.test(tok)) continue;
			try {
				const abs = path.resolve(tok);
				if (existsSync(abs) && statSync(abs).isFile()) out.push({ abs, op: "s" });
			} catch {
				/* skip */
			}
		}
		return out;
	}
	const add = (v: unknown, op: string, unconditional: boolean) => {
		if (typeof v !== "string" || !v) return;
		try {
			const abs = path.resolve(v);
			if (!unconditional && (!existsSync(abs) || !statSync(abs).isFile())) return;
			out.push({ abs, op });
		} catch {
			/* skip */
		}
	};
	if (toolName === "read") {
		add(input?.path, "r", true);
		return out;
	}
	if (toolName === "write" || toolName === "edit") {
		add(input?.path, "w", true);
		return out;
	}
	for (const key of ["path", "filePath", "file_path", "imagePath"])
		add(input?.[key], "r", false);
	for (const key of ["paths", "files", "filePaths"]) {
		if (Array.isArray(input?.[key]))
			for (const v of input[key]) add(v, "r", false);
	}
	return out;
}

function record(toolName: string, input: any): void {
	const seen = new Set<string>();
	for (const { abs, op } of pathsFrom(toolName, input)) {
		if (seen.has(abs)) continue;
		seen.add(abs);
		const prev = files.get(abs);
		if (prev) {
			files.delete(abs);
			prev.count++;
			if (!prev.ops.includes(op)) prev.ops += op;
			files.set(abs, prev);
		} else {
			if (files.size >= MAX_FILES)
				files.delete(files.keys().next().value as string);
			files.set(abs, { path: abs, ops: op, count: 1 });
		}
	}
	filesVersion++;
}

function bumpFilesVersion(): void {
	filesVersion++;
}

const recentEntries = (): FileEntry[] => [...files.values()].reverse();

function displayPath(abs: string): string {
	const rel = path.relative(process.cwd(), abs);
	if (rel && !rel.startsWith("..")) return rel;
	const home = homedir();
	if (abs.startsWith(home + path.sep)) return `~${abs.slice(home.length)}`;
	return abs;
}

// ─── edit-diff buffer ────────────────────────────────────────────────────────

/**
 * Raw (unrendered) history of the most recent edit diffs, oldest first.
 * We store raw text (not ANSI) so it survives theme changes; `renderDiff` is
 * applied at draw time. Each entry is keyed by its edit's toolCallId: the
 * tool_call preview creates the entry and the tool_result's authoritative diff
 * replaces THAT entry only, so a slow older result can never overwrite a
 * newer edit (SV-23).
 */
interface DiffEntry {
	id: string | undefined;
	path: string;
	diff: string;
	/** From the tool result. Preview diffs are computed from the edit's
	 * snippets, so their line numbers are snippet-relative, not file lines. */
	final: boolean;
}
const MAX_DIFFS = 10;
/** Per-diff cap in the diffs panel (rendered lines, before wrapping). */
const MAX_DIFF_LINES = 150;
const diffHistory: DiffEntry[] = [];
let diffVersion = 0;

const lastDiff = (): DiffEntry | undefined =>
	diffHistory[diffHistory.length - 1];

/** Add a diff, or replace the existing entry for the same toolCallId. */
function putEditDiff(
	id: string | undefined,
	p: string,
	diff: string,
	final: boolean,
): void {
	const existing =
		id !== undefined ? diffHistory.find((d) => d.id === id) : undefined;
	if (existing) {
		if (p) existing.path = p;
		existing.diff = diff;
		existing.final = final;
	} else {
		diffHistory.push({ id, path: p, diff, final });
		while (diffHistory.length > MAX_DIFFS) diffHistory.shift();
	}
	diffVersion++;
}

function clearEditDiffs(): void {
	diffHistory.length = 0;
	diffVersion++;
}

/** A file location a diffs-panel line opens on double-click. */
interface DiffTarget {
	file: string;
	line: number;
}
/** Parallel to the last diffLines() output: each line's target, if any. */
let diffTargets: (DiffTarget | undefined)[] = [];

/**
 * New-file line for each line of an edit-result diff (`+N`, `-N`, ` N`).
 * Context and removed lines carry OLD-file numbers, so track the running
 * new−old offset; a removed line maps to where it used to be.
 */
function diffLineNumbers(diff: string): (number | undefined)[] {
	let delta = 0;
	return diff.split(/\r?\n/).map((l) => {
		const m = /^([+\- ])\s*(\d+) /.exec(l);
		if (!m) return undefined;
		const n = Number(m[2]);
		if (m[1] === "+") {
			delta++;
			return n;
		}
		const line = Math.max(1, n + delta);
		if (m[1] === "-") delta--;
		return line;
	});
}

function resolveEditPath(p: string): string {
	if (p === "~" || p.startsWith("~/")) return path.join(homedir(), p.slice(1));
	return path.resolve(process.cwd(), p);
}

function diffLines(theme: Theme, width: number): string[] {
	const out: string[] = [];
	const targets: (DiffTarget | undefined)[] = [];
	for (const d of diffHistory) {
		const file = d.final && d.path ? resolveEditPath(d.path) : undefined;
		const nums = file ? diffLineNumbers(d.diff) : [];
		const at = (line: number | undefined) =>
			file && line !== undefined ? { file, line } : undefined;
		const label = ` ✎ ${displayPath(d.path) || "(unknown)"} `;
		const title = truncateToWidth(label, Math.max(1, width - 5), "…");
		out.push(
			theme.fg("border", "─") +
				theme.fg("accent", title) +
				theme.fg(
					"border",
					"─".repeat(Math.max(0, width - 4 - visibleWidth(title))),
				),
		);
		// The header opens the first changed line.
		const firstChange = d.diff
			.split(/\r?\n/)
			.findIndex((l) => /^[+-]\s*\d/.test(l));
		targets.push(at(nums[firstChange]));
		// renderDiff keeps one output line per diff line, in order.
		const rendered = renderDiff(d.diff).split(/\r?\n/);
		const aligned = rendered.length === nums.length;
		rendered.slice(0, MAX_DIFF_LINES).forEach((l, i) => {
			out.push(l);
			targets.push(aligned ? at(nums[i]) : undefined);
		});
		if (rendered.length > MAX_DIFF_LINES) {
			out.push(theme.fg("dim", `… +${rendered.length - MAX_DIFF_LINES} more`));
			targets.push(undefined);
		}
	}
	diffTargets = targets;
	return out;
}

/** Double-click handler for a diffs-panel line, if it maps to a file line. */
function diffLineAction(index: number): (() => void) | undefined {
	const t = diffTargets[index];
	if (!t || !inHerdr()) return undefined;
	return () =>
		openInHerdrNvim(t.file, t.line, process.cwd(), (msg) =>
			notifyRef?.(`Open in nvim failed: ${msg}`, "error"),
		);
}

// ─── shared helpers ──────────────────────────────────────────────────────────

function requestRender(): void {
	try {
		tuiRef?.requestRender?.();
	} catch {
		/* ignore */
	}
}

const anyPanelActive = () =>
	isLayoutLayerActive("ui") || isLayoutLayerActive("files") || !!REG.active;
// SV-01 (revised): /split is a full toggle pair over every panel flag
// (thinking/tools/files/trim), so its "on" state is the flag disjunction.
// The old bandActive() derived state from the band alone, which made a
// files-only or trim-only layout report "off" for a not-bare view and left
// those panels running after a /split off. Layout-layer checks remain in use
// only for layout ownership (anyPanelActive/filesActive).
const panelsActive = () =>
	thinkingOn || toolsOn || filesOn || showDiff || trimResponse;
const filesActive = () => isLayoutLayerActive("files") || !!REG.active;

// ─── drag-to-resize ──────────────────────────────────────────────────────────

/**
 * A draggable panel boundary. `value()` is the size when the drag starts;
 * `set(start, delta)` applies a drag of `delta` cells along `axis` and
 * returns whether the size changed. Grips are module constants, so their
 * identity survives the recompose each drag step triggers.
 */
interface Grip {
	axis: "x" | "y";
	value: () => number;
	set: (start: number, delta: number) => boolean;
}

/** Border cells of one component that start a drag: its first/last column,
 * or any cell of the row. */
interface Grips {
	row?: Grip;
	left?: Grip;
	right?: Grip;
}

/** The drag in progress. pi sends every drag/release to the component that
 * took the press (`owner`), even after a recompose dropped it from the
 * layout. */
let gripDrag: {
	owner: object;
	grip: Grip;
	from: number;
	start: number;
	moved: boolean;
} | null = null;
/** Theme of the last composition, for recomposing mid-drag. */
let layoutTheme: Theme | null = null;

/** Columns the conversation side always keeps when the dock is dragged wide. */
const MIN_LEFT_COLS = 50;

const clamp = (n: number, lo: number, hi: number) =>
	Math.max(lo, Math.min(Math.max(lo, hi), n));
const termCols = () => tuiRef?.terminal?.columns ?? 120;
const termRows = () => tuiRef?.terminal?.rows ?? 24;

/** Top band height: drag the band's bottom border or the conversation's top. */
const BAND_GRIP: Grip = {
	axis: "y",
	value: () => bandHeight,
	set: (start, delta) => {
		const next = clamp(start + delta, 6, Math.min(40, termRows() - 8));
		if (next === bandHeight) return false;
		bandHeight = next;
		return true;
	},
};

/** Right dock width: drag the edge between the conversation and the dock. */
const DOCK_GRIP: Grip = {
	axis: "x",
	value: () => dockColsFor(termCols()),
	set: (start, delta) => {
		const before = dockColsFor(termCols());
		dockWidth = clamp(start - delta, 24, termCols() - MIN_LEFT_COLS);
		return dockColsFor(termCols()) !== before;
	},
};

/** Thinking | Tool Usage split: drag the edge between the two panels. */
const SPLIT_GRIP: Grip = {
	axis: "x",
	value: () => bandToolsColsFor(bandBaseCols()),
	set: (start, delta) => {
		const base = Math.max(1, bandBaseCols());
		const next = clamp(Math.round(((start - delta) * 100) / base), 20, 60);
		if (next === toolsWidthPct) return false;
		toolsWidthPct = next;
		return true;
	},
};

/** Persist the sizes once a drag ends (size keys only; see
 * saveUiPanelsSizes). */
function saveSizes(): void {
	const ok = saveUiPanelsSizes({
		bandHeight,
		toolsWidthPct,
		...(dockWidth === null ? {} : { dockWidth }),
	});
	if (!ok) notifyRef?.("Could not save panel sizes (config write failed)", "error");
}

/**
 * Mouse handler for a component with grip cells. A left press on a grip cell
 * starts a drag; the drag events and release pi then routes to the same
 * component resize live and save on release. Anything else is unhandled.
 */
function gripsMouse(
	owner: object,
	grips: Grips | undefined,
	event: TuiMouseEvent,
): TuiMouseEventResult | undefined {
	const d = gripDrag;
	if (d && d.owner === owner && event.type === "drag") {
		const pos = d.grip.axis === "x" ? event.screenX : event.screenY;
		if (!d.grip.set(d.start, pos - d.from))
			return { handled: true, render: false };
		d.moved = true;
		if (layoutTheme) reconcileLayout(layoutTheme);
		return { handled: true, render: true };
	}
	if (d && d.owner === owner && event.type === "release") {
		gripDrag = null;
		if (d.moved) saveSizes();
		return { handled: true, render: false };
	}
	if (!grips || event.type !== "press" || event.button !== "left")
		return undefined;
	const grip =
		(event.x === 0 && grips.left) ||
		(event.x === event.width - 1 && grips.right) ||
		grips.row;
	if (!grip) return undefined;
	gripDrag = {
		owner,
		grip,
		from: grip.axis === "x" ? event.screenX : event.screenY,
		start: grip.value(),
		moved: false,
	};
	return { handled: true, render: false };
}

// ─── framed panel components ─────────────────────────────────────────────────

class BorderTop {
	constructor(
		private theme: Theme,
		private title: string,
		private color: "accent" | "muted",
		private streaming: () => boolean,
		private grips?: Grips,
	) {}
	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		return gripsMouse(this, this.grips, event);
	}
	render(width: number): string[] {
		const th = this.theme;
		const contentWidth = Math.max(1, width - 2);
		const title = th.fg(this.color, ` ${this.title} `);
		const dot = this.streaming() ? th.fg("warning", "●") : "";
		const label = truncateToWidth(title + dot, contentWidth);
		const fill = th.fg(
			"border",
			"─".repeat(Math.max(0, contentWidth - visibleWidth(label))),
		);
		return [th.fg("border", "╭") + label + fill + th.fg("border", "╮")];
	}
	invalidate(): void {}
	dispose(): void {}
}

class BorderBottom {
	constructor(
		private theme: Theme,
		private grips?: Grips,
	) {}
	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		return gripsMouse(this, this.grips, event);
	}
	render(width: number): string[] {
		return [
			this.theme.fg("border", "╰") +
				this.theme.fg("border", "─".repeat(Math.max(0, width - 2))) +
				this.theme.fg("border", "╯"),
		];
	}
	invalidate(): void {}
	dispose(): void {}
}

/**
 * OracleSpec: a VStack whose component-level render() is a constant sentinel.
 * The layout engine checks LAYOUT_NODE before plain render (layoutComponent),
 * so real layout/painting is untouched — but the engine's DISCARDED intrinsic-
 * height measurement passes (hstack node branch) call component.render() and
 * now cost O(1) instead of eagerly rendering the whole subtree (band panels,
 * and via the dock, the full transcript) on every keystroke frame.
 */
class MeasurementSafeVStack extends VStack {
	render(_width: number): string[] {
		return [""];
	}
}

/**
 * OracleSpec body: renders the recent window with a left │ edge only — the
 * ScrollView's always-on scrollbar column is the right frame edge (track
 * styled as border, so the frame reads as complete; thumb slides when
 * overflowing). Pads every row to EXACT width and always emits at least
 * `minRows` rows so the left edge is continuous when content is short. No
 * per-line memo: the window is small, a (version, width) cache suffices.
 */
class RecentBody {
	private cacheVersion = -1;
	/** SV-19: bounded width cache — keep the current width plus a small LRU of
	 * recent widths so resize cycling cannot grow it unbounded. */
	private cacheByWidth = new Map<number, { out: string[]; src: number[] }>();
	private static readonly MAX_CACHED_WIDTHS = 4;
	/** Source-line index of each row of the last render (-1: filler/empty). */
	private rowSource: number[] = [];
	constructor(
		private theme: Theme,
		private style: (line: string) => string,
		private lines: (width: number) => string[],
		private version: () => number,
		private empty: string,
		/** Rows to guarantee so the left edge has no gaps (viewport height). */
		private minRows: () => number,
		/** Cap on retained visual rows (newest kept). */
		private maxRows: number = MAX_BODY_ROWS,
		/** Double-click action for a source line (index into lines()), if any. */
		private action?: (index: number) => (() => void) | undefined,
		/** Drag handle on the left │ edge, if any. */
		private leftGrip?: Grip,
	) {}
	/** The layout dispatches with content-relative y (scroll offset applied).
	 * Claim the press only on actionable rows (or the left grip edge), so text
	 * selection still works everywhere else. */
	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		const g = gripsMouse(
			this,
			this.leftGrip ? { left: this.leftGrip } : undefined,
			event,
		);
		if (g) return g;
		if (!this.action || event.button !== "left") return undefined;
		if (event.type !== "press" && event.type !== "click") return undefined;
		const src = this.rowSource[event.y] ?? -1;
		const act = src >= 0 ? this.action(src) : undefined;
		if (!act) return undefined;
		if (event.type === "click" && (event.clickCount ?? 1) >= 2) act();
		return { handled: true, render: false };
	}
	render(width: number): string[] {
		const th = this.theme;
		const v = this.version();
		if (v !== this.cacheVersion) {
			this.cacheVersion = v;
			this.cacheByWidth.clear();
		}
		const cached = this.cacheByWidth.get(width);
		if (cached) {
			// SV-19: refresh recency so eviction is genuinely LRU, not FIFO —
			// delete+set moves this width to the Map's newest position.
			this.cacheByWidth.delete(width);
			this.cacheByWidth.set(width, cached);
			this.rowSource = cached.src;
			return cached.out;
		}
		const edge = th.fg("border", "│");
		const pad = (s: string) =>
			" ".repeat(Math.max(0, width - 1 - visibleWidth(s)));
		// Wrap newest-first, keep only the newest MAX_BODY_ROWS visual rows;
		// giant logical lines are suffix-capped before wrapping.
		// SV-03/SV-04: fragments of ONE source line are wrapped as a group and
		// the group is inserted in order (an individual unshift reversed the
		// fragments of one line); the MAX_BODY_ROWS cap counts VISUAL rows, not
		// source lines, so one long line cannot blow past the cap at narrow
		// widths. A group that would straddle the cap is skipped whole (no
		// fragment is ever split); the newest groups always fit. A single group
		// larger than the whole cap keeps only its newest fragments.
		const src = this.lines(width);
		const groups: { index: number; frags: string[] }[] = [];
		let used = 0;
		for (let i = src.length - 1; i >= 0; i--) {
			const line =
				src[i].length > MAX_LINE_CHARS
					? "… " + src[i].slice(-MAX_LINE_CHARS + 1)
					: src[i];
			const frags = wrapTextWithAnsi(
				this.style(line),
				Math.max(1, width - 3),
			).map((w: string) => " " + w);
			if (used + frags.length > this.maxRows) {
				if (groups.length === 0 && frags.length > this.maxRows)
					groups.push({
						index: i,
						frags: frags.slice(frags.length - this.maxRows),
					});
				break;
			}
			groups.push({ index: i, frags });
			used += frags.length;
		}
		const rows: string[] = [];
		const rowSrc: number[] = [];
		for (let g = groups.length - 1; g >= 0; g--)
			for (const f of groups[g].frags) {
				rows.push(f);
				rowSrc.push(groups[g].index);
			}
		let out: string[];
		if (rows.length === 0) {
			const empty = " " + th.fg("dim", this.empty);
			out = [edge + empty + pad(empty)];
		} else {
			out = rows.map((r) => edge + r + pad(r));
		}
		// Guarantee a continuous left edge: fill short content up to minRows.
		const min = Math.max(1, this.minRows());
		const filler = edge + " ".repeat(Math.max(0, width - 1));
		while (out.length < min) out.push(filler);
		this.cacheByWidth.set(width, { out, src: rowSrc });
		this.rowSource = rowSrc;
		// SV-19: bound the number of cached widths (Map preserves insertion
		// order; hits refresh recency above, so the first key is least-recent
		// and eviction is true LRU).
		while (this.cacheByWidth.size > RecentBody.MAX_CACHED_WIDTHS) {
			const oldest = this.cacheByWidth.keys().next().value as number;
			this.cacheByWidth.delete(oldest);
		}
		return out;
	}
	invalidate(): void {
		this.cacheVersion = -1;
		this.cacheByWidth.clear();
	}
	dispose(): void {}
}

// ─── files panel (list + edit-diff subpanel) ──────────────────────────────────

class FilesPanel {
	private cacheKey = "";
	private cacheLines: string[] = [];

	constructor(
		private theme: Theme,
		/** Fullscreen dock: allotted rows. Overlay: undefined. */
		private heightProvider?: () => number,
		/** Overlay mode embeds the last-edit subpanel; the fullscreen dock shows
		 * diffs in their own panel instead. */
		private withDiff: () => boolean = () => showDiff,
	) {}

	/** In the fullscreen dock the left │ edge resizes the dock. */
	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		return gripsMouse(
			this,
			this.heightProvider ? { left: DOCK_GRIP } : undefined,
			event,
		);
	}

	// No handleInput: the regular-mode overlay is nonCapturing, so it never
	// receives keys — Escape belongs to the editor/Pi, and /files is the
	// close/reopen path (Option C, decisions/D-overlay-lifecycle.md).

	render(width: number): string[] {
		if (REG.gen !== MY_GEN) return [];
		const height =
			this.heightProvider?.() || termHeight || recentEntries().length + 12;
		// Cache key MUST include height: a height-only terminal resize changes
		// the list/diff row split without bumping filesVersion or width.
		const showDiff = this.withDiff();
		const key = `${filesVersion}|${diffVersion}|${width}|${height}|${showDiff ? 1 : 0}`;
		if (key === this.cacheKey) return this.cacheLines;

		const th = this.theme;
		const inner = Math.max(1, width - 2);
		const pad = (s: string) =>
			s + " ".repeat(Math.max(0, inner - visibleWidth(s)));
		const row = (c: string) =>
			th.fg("border", "│") + pad(truncateToWidth(c, inner)) + th.fg("border", "│");

		const entries = recentEntries();
		// Reserve the bottom half for the edit diff (min 2 list rows) when the
		// diff subpanel is shown; otherwise the list owns the whole panel.
		const half = Math.max(6, Math.floor(height / 2));
		const listRows = showDiff ? Math.max(2, half - 4) : Math.max(1, height - 4);
		// SV-06: exact row accounting so the bottom border lands on the last
		// allocated row. Fixed chrome is 6 rows (top, title, list separator,
		// diff separator, diff title, bottom border) and the list always pads
		// to listRows, so the diff section gets exactly what remains. Without
		// this a short diff left an unframed hole between the panel and the
		// viewport bottom (the old diffRows budget was never padded when a diff
		// existed, only when it did not). When the diff subpanel is off the
		// chrome is 4 rows (top, title, list separator, bottom border).
		const diffRows = showDiff ? Math.max(0, height - listRows - 6) : 0;

		const meta = (e: FileEntry) =>
			th.fg("muted", `${e.ops}${e.count > 1 ? `×${e.count}` : ""}`);

		const rows: { line: string; files: number }[] = [];
		let i = 0;
		while (i < entries.length) {
			const dir = path.dirname(entries[i].path);
			let j = i;
			while (j < entries.length && path.dirname(entries[j].path) === dir) j++;
			const run = entries.slice(i, j);
			if (run.length > 3) {
				const label = displayPath(dir);
				rows.push({
					line: row(` ${th.fg("accent", label === "." ? "./" : `${label}/`)}`),
					files: 0,
				});
				for (const e of run)
					rows.push({
						line: row(`   ${meta(e)} ${th.fg("text", path.basename(e.path))}`),
						files: 1,
					});
			} else {
				for (const e of run)
					rows.push({
						line: row(` ${meta(e)} ${th.fg("text", path.basename(e.path))}`),
						files: 1,
					});
			}
			i = j;
		}

		const body: string[] = [];
		let filesShown = 0;
		for (const r of rows) {
			if (body.length >= listRows - 2) break;
			body.push(r.line);
			filesShown += r.files;
		}
		if (body.length === 0 && entries.length === 0)
			body.push(row(` ${th.fg("dim", "No files touched yet")}`));
		if (entries.length > filesShown)
			body.push(row(` ${th.fg("dim", `… +${entries.length - filesShown} more`)}`));
		body.push(row(` ${th.fg("dim", LEGEND)}`));
		while (body.length < listRows) body.push(row(""));

		// ── edit-diff subpanel (optional: /split-diff) ──
		const diffBody: string[] = [];
		const editDiff = lastDiff() ?? { path: "", diff: "" };
		if (showDiff) {
			diffBody.push(th.fg("border", `├${"─".repeat(inner)}┤`));
			// SV-05: truncate the title by DISPLAY COLUMNS (wide/CJK/emoji paths)
			// and compute the fill from the truncated title's visible width, so the
			// title can never overrun the fill and collide with the right border.
			// Budget: leading " ✎ " + trailing " " around the path text.
			const title = editDiff.path
				? th.fg("accent", ` ✎ ${truncateToWidth(displayPath(editDiff.path), inner - 4, "…")} `)
				: th.fg("dim", " Last Edit ");
			const titleFill = "─".repeat(
				Math.max(0, inner - visibleWidth(title)),
			);
			diffBody.push(
				th.fg("border", "│") +
					title +
					th.fg("border", titleFill) +
					th.fg("border", "│"),
			);

			if (editDiff.diff) {
				const rendered = renderDiff(editDiff.diff).split(/\r?\n/);
				// SV-06: cap content one row below the pad target so the "… +N more"
				// marker always fits; the section is then padded to diffRows so the
				// frame closes on the last row.
				const shown = rendered.slice(0, Math.max(0, diffRows - 1));
				for (const l of shown) diffBody.push(row(` ${l}`));
				if (rendered.length > shown.length && diffRows > 0)
					diffBody.push(
						row(` ${th.fg("dim", `… +${rendered.length - shown.length} more`)}`),
					);
				while (diffBody.length < diffRows + 2) diffBody.push(row(""));
			} else {
				if (diffRows > 0)
					diffBody.push(row(` ${th.fg("dim", "No edit yet")}`));
				while (diffBody.length < diffRows + 2) diffBody.push(row(""));
			}
		}

		const out = [
			th.fg("border", `╭${"─".repeat(inner)}╮`),
			row(` ${th.fg("accent", `📂 Files (${entries.length})`)}`),
			th.fg("border", `├${"─".repeat(inner)}┤`),
			...body,
			...diffBody,
			th.fg("border", `╰${"─".repeat(inner)}╯`),
		];
		this.cacheKey = key;
		this.cacheLines = out;
		return out;
	}

	invalidate(): void {
		this.cacheKey = "";
	}
	dispose(): void {}
}

// ─── layout composition (one layer) ──────────────────────────────────────────

/**
 * Panel scaffold: no separate border columns, no inner HStack — the always-on
 * scrollbar column is the right frame edge (track styled as border; the idle
 * full-height thumb is border-colored too, accent only while actively
 * scrolling), so nothing ever paints over a frame line and there is no
 * second composite layer. The MeasurementSafeVStack wrapper keeps the
 * engine's discarded measurement passes O(1).
 */
function framedPanel(
	theme: Theme,
	top: Component,
	body: RecentBody,
	bottomGrips?: Grips,
): Component {
	const scroll = new ScrollView(body, {
		follow: "end",
		overscroll: "contain",
		scrollbar: "always",
		scrollbarTrackStyle: (t: string) => theme.fg("border", t),
		// SV-25: the layout engine paints the idle thumb as "┃" (heavy) while
		// the track is "│" (light) — same border color, different glyph, so the
		// right frame edge read as broken at the thumb's rows. Map the IDLE
		// thumb to the track's glyph so the edge is a uniform │ column at rest;
		// the ACTIVE thumb keeps "█" in accent for scroll feedback. No second
		// edge column, no track/color change, design unchanged.
		scrollbarThumbStyle: (t: string) =>
			theme.fg(t === "█" ? "accent" : "border", t === "┃" ? "│" : t),
	});
	return new MeasurementSafeVStack([
		{ component: top, basis: 1, grow: 0, shrink: 0 },
		{ component: scroll, basis: 0, grow: 1, shrink: 1, minSize: 1 },
		{
			component: new BorderBottom(theme, bottomGrips),
			basis: 1,
			grow: 0,
			shrink: 0,
		},
	]);
}

function buildBand(theme: Theme, inner: Component): Component {
	const panels: { component: Component; basis: number; grow: number }[] = [];
	const minRows = () => Math.max(1, bandHeight - 2);

	const defs: {
		title: string;
		color: "accent" | "muted";
		streaming: () => boolean;
		style: (line: string) => string;
		lines: (width: number) => string[];
		version: () => number;
		empty: string;
	}[] = [];
	if (thinkingOn)
		defs.push({
			title: "Thinking",
			color: "accent",
			streaming: () => thinking.streaming,
			style: (l) => theme.fg("thinkingText", l),
			lines: (w) => thinkingLines(theme, w),
			version: () => thinking.version,
			empty: "Thinking idle",
		});
	if (toolsOn)
		defs.push({
			title: "Tool Usage",
			color: "muted",
			streaming: () => toolOrder.some((id) => toolsBy.get(id)?.active),
			style: (l) => l,
			lines: (w) => toolLines(theme, w),
			version: toolsVersion,
			empty: "No tools called yet",
		});

	// F/F2: explicit tunable width split — no equal-flex weights or engine
	// content measurement. toolsWidthPct % of the ALLOCATED band width goes
	// to the tools panel, thinking gets the rest (minimum clamps inside the
	// helper). F2: the base is the allocated band region — with the files dock
	// visible (filesOn, ≥ MIN_TERM_WIDTH) that is the terminal width minus the
	// dock columns (the SV-07 clamp), not the full terminal width.
	// Single-panel bands keep the full width (no ratio involved).
	const cols = termCols();
	const dockVisible = dockOn() && cols >= MIN_TERM_WIDTH;
	const base = bandBaseCols();
	const splitBand = defs.length === 2;
	const toolsW = splitBand ? bandToolsColsFor(base) : -1;
	const thinkW = base - toolsW;
	composedBandTermCols = cols;

	let di = 0;
	for (const d of defs) {
		// defs order: thinking first (when on), then tools. The tools panel's
		// left edge is the Thinking | Tool Usage divider.
		const splitGrip = splitBand && di === 1 ? SPLIT_GRIP : undefined;
		const top = new BorderTop(theme, d.title, d.color, d.streaming, {
			left: splitGrip,
		});
		const w = splitBand ? (di === 0 ? thinkW : toolsW) : 1;
		panels.push({
			component: framedPanel(
				theme,
				top,
				new RecentBody(
					theme,
					d.style,
					d.lines,
					d.version,
					d.empty,
					minRows,
					MAX_BODY_ROWS,
					undefined,
					splitGrip,
				),
				{ row: BAND_GRIP, left: splitGrip },
			),
			basis: w,
			grow: splitBand ? 0 : 1,
		});
		di++;
	}

	// No enabled sub-panels → no band at all.
	if (panels.length === 0) return inner;

	// A single panel needs no HStack wrapper at all.
	const band =
		panels.length === 1
			? panels[0]!.component
			: new HStack(panels.map((p) => ({ ...p, shrink: 1, minSize: 1 })));
	const conversation = framedConversation(
		theme,
		inner,
		dockVisible ? DOCK_GRIP : undefined,
	);
	return new VStack([
		{
			component: band,
			basis: bandHeight,
			grow: 0,
			shrink: 1,
			minSize: Math.min(6, bandHeight),
		},
		{ component: conversation, basis: 0, grow: 1, shrink: 1, minSize: 1 },
	]);
}

/** One border column, as tall as whatever height it is given (paint clips). */
class BorderEdge implements Component {
	constructor(
		private theme: Theme,
		private grip?: Grip,
	) {}
	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		return gripsMouse(this, this.grip ? { left: this.grip } : undefined, event);
	}
	render(_width: number): string[] {
		const rows = Math.max(1, tuiRef?.terminal?.rows ?? 200);
		return new Array(rows).fill(this.theme.fg("border", "│"));
	}
	invalidate(): void {}
	dispose(): void {}
}

/**
 * Frame the conversation below the band: ╭─╮ on top, │ edges down both
 * sides of the transcript, ╰─╯ under it. The editor dock (pi's own, or the
 * one reused by trim mode) stays outside the frame. Falls back to just the
 * top rule when the inner root isn't the expected VStack[transcript, dock].
 * The top rule resizes the band; with the dock beside it, the right edge
 * resizes the dock (`dockGrip`).
 */
function framedConversation(
	theme: Theme,
	inner: Component,
	dockGrip?: Grip,
): Component {
	const top = new (class implements Component {
		invalidate(): void {}
		dispose(): void {}
		handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
			return gripsMouse(this, { row: BAND_GRIP, right: dockGrip }, event);
		}
		render(w: number): string[] {
			return [
				theme.fg("border", "╭") +
					theme.fg("border", "─".repeat(Math.max(0, w - 2))) +
					theme.fg("border", "╮"),
			];
		}
	})();
	const topEntry = { component: top, basis: 1, grow: 0, shrink: 0 };
	const entries: any[] | undefined = (inner as any)?.entries;
	const ti = Array.isArray(entries)
		? entries.findIndex((e) => e?.component && Object.hasOwn(e.component, "child"))
		: -1;
	if (!entries || ti < 0)
		return new VStack([
			topEntry,
			{ component: inner, basis: 0, grow: 1, shrink: 1, minSize: 1 },
		]);
	const edge = { basis: 1, grow: 0, shrink: 0 };
	const framed = new HStack([
		{ component: new BorderEdge(theme), ...edge },
		{
			// Keep the HStack's height-measurement pass from rendering the
			// whole transcript.
			component: new MeasurementSafeVStack([
				{ component: entries[ti].component, basis: 0, grow: 1, shrink: 1, minSize: 1 },
			]),
			basis: 0,
			grow: 1,
			shrink: 1,
			minSize: 1,
		},
		{ component: new BorderEdge(theme, dockGrip), ...edge },
	]);
	return new VStack([
		topEntry,
		...entries.flatMap((e, i) =>
			i === ti
				? [
						{ ...e, component: framed },
						{
							component: new BorderBottom(theme, { right: dockGrip }),
							basis: 1,
							grow: 0,
							shrink: 0,
						},
					]
				: [{ ...e, component: withoutEditorGap(e.component) }],
		),
	]);
}

/**
 * Re-centres status rows (e.g. a custom working-indicator spinner) that were
 * padded to centre on the full terminal width, so they centre on the width
 * they actually get beside the dock. Left-aligned rows are left alone.
 * Also drops the blank row pi's Loader puts above the indicator, so it sits
 * flush between the conversation frame and the editor.
 */
class RecentreLines implements Component {
	constructor(private inner: Component) {}
	render(width: number): string[] {
		let lines = this.inner.render(width);
		const first = lines.findIndex((l) => visibleWidth(l.trim()) > 0);
		// Copy, never mutate: inner components may return a cached array.
		lines = first < 0 ? [] : lines.slice(first);
		const cols = tuiRef?.terminal?.columns ?? width;
		if (width >= cols) return lines;
		return lines.map((l) => {
			const lead = l.length - l.trimStart().length;
			if (lead < 2) return l;
			const rest = l.trimStart();
			const restW = visibleWidth(rest.trimEnd());
			if (Math.abs(lead - Math.floor((cols - restW) / 2)) > 2) return l;
			return " ".repeat(Math.max(0, Math.floor((width - restW) / 2))) + rest;
		});
	}
	invalidate(): void {
		this.inner.invalidate?.();
	}
	dispose(): void {}
}

/** Replace the editor dock entry of pi's VStack[transcript, dock] root. */
function mapDock(
	inner: Component,
	fn: (dock: Component) => Component,
): Component {
	const entries: any[] | undefined = (inner as any)?.entries;
	if (!Array.isArray(entries)) return inner;
	const di = entries.findIndex(
		(e) => e?.component && !Object.hasOwn(e.component, "child"),
	);
	if (di < 0) return inner;
	return new VStack(
		entries.map((e, i) => (i === di ? { ...e, component: fn(e.component) } : e)),
	);
}

/** Wrap the dock's status row (index 1: after pending messages). */
function withCentredStatus(inner: Component): Component {
	return mapDock(inner, (dock) => {
		const entries: any[] | undefined = (dock as any)?.entries;
		if (!Array.isArray(entries) || entries.length < 4 || !entries[1]?.component)
			return dock;
		return new VStack(
			entries.map((e, i) =>
				i === 1 ? { ...e, component: new RecentreLines(e.component) } : e,
			),
		);
	});
}

/** Drops a component's leading blank row. */
class TrimLeadingBlank implements Component {
	constructor(private inner: Component) {}
	render(width: number): string[] {
		const lines = this.inner.render(width);
		return lines.length && visibleWidth(lines[0]!.trim()) === 0
			? lines.slice(1)
			: lines;
	}
	invalidate(): void {
		this.inner.invalidate?.();
	}
	dispose(): void {}
}

/**
 * pi's dock (VStack[pending, status, widgetsAbove, editor, widgetsBelow,
 * footer]) always starts widgetsAbove with a 1-row spacer. Under the framed
 * conversation that row is just a gap, so drop it. Anything unexpected is
 * returned unchanged.
 */
function withoutEditorGap(dock: Component): Component {
	const entries: any[] | undefined = (dock as any)?.entries;
	if (!Array.isArray(entries)) return dock;
	const ei = entries.findIndex((e) => e?.minSize === 3);
	if (ei < 3 || !entries[ei - 1]?.component) return dock;
	return new VStack(
		entries.map((e, i) =>
			i === ei - 1
				? { ...e, component: new TrimLeadingBlank(e.component) }
				: // The editor, and the footer below it, keep their insets.
					i === ei || (i === entries.length - 1 && i > ei)
					? { ...e, component: new FlushEdges(e.component) }
					: e,
		),
	);
}

const isBlankCell = (l: string, col: number) =>
	visibleWidth(sliceByColumn(l, col, 1).trim()) === 0;

/**
 * An editor that keeps a 1-column blank margin on each side (e.g. a chat-
 * bubble editor) looks 2 columns narrower than the framed conversation above
 * it. Render it 2 columns wider and cut the margins off, so its edges line up
 * with the frame. The footer gets the same treatment so it stays inset from
 * the editor by the same amount. Rows without blank margins render unchanged.
 */
class FlushEdges implements Component {
	constructor(private inner: Component) {}
	render(width: number): string[] {
		const wide = this.inner.render(width + 2);
		const flush =
			wide.length > 0 &&
			wide.every(
				(l) =>
					visibleWidth(l) <= width + 2 &&
					isBlankCell(l, 0) &&
					(visibleWidth(l) <= width + 1 || isBlankCell(l, width + 1)),
			);
		if (!flush) return this.inner.render(width);
		// sliceByColumn stops at the cut, dropping any trailing reset.
		return wide.map((l) => sliceByColumn(l, 1, width) + "\x1b[0m");
	}
	invalidate(): void {
		this.inner.invalidate?.();
	}
	dispose(): void {}
}

/** Dock width (clamped, 34–48) that the current composition was built with.
 *  SV-07: the dock basis is captured at compose time; the widget render
 *  compares it against the live terminal width and recomposes on change. */
let composedDockCols = -1;
/** Terminal rows the dock was composed with (files/diffs split + padding). */
let composedDockRows = -1;

/** F: explicit band split — minimum panel widths (cols) below which the
 * toolsWidthPct ratio clamps, so neither panel degenerates at narrow
 * terminals. */
const MIN_THINK_COLS = 24;
const MIN_TOOLS_COLS = 20;

/** F: tools panel width (cols) for the given terminal width under the
 * current toolsWidthPct, with the minimum clamps. When both minimums
 * cannot hold (very narrow terminals) the raw ratio is used — the panels
 * share whatever is available. */
function bandToolsColsFor(total: number): number {
	const raw = Math.round((total * toolsWidthPct) / 100);
	let toolsW = raw;
	let thinkW = total - toolsW;
	if (toolsW < MIN_TOOLS_COLS) {
		toolsW = MIN_TOOLS_COLS;
		thinkW = total - toolsW;
	}
	if (thinkW < MIN_THINK_COLS) {
		thinkW = MIN_THINK_COLS;
		toolsW = total - thinkW;
	}
	if (toolsW < MIN_TOOLS_COLS) {
		toolsW = raw;
		thinkW = total - toolsW;
	}
	return toolsW;
}

/** TERMINAL width the current band composition was built with. F2: the
 * widget render recomposes on any terminal-width change, so a resize never
 * leaves a stale basis — even when the tools cols round to the same value
 * (e.g. 101→102 cols at 50%). */
let composedBandTermCols = -1;

/** F2: the files dock's clamped width (SV-07) for a terminal width — shared
 * by buildFilesDock and buildBand so the band split uses the SAME allocated
 * base the dock actually takes. */
function dockColsFor(cols: number): number {
	if (dockWidth !== null) return clamp(dockWidth, 24, cols - MIN_LEFT_COLS);
	return Math.max(34, Math.min(48, Math.floor(cols * 0.25)));
}

/** Width the top band is split across: the terminal minus the dock when the
 * dock is visible. */
function bandBaseCols(): number {
	const cols = termCols();
	return cols - (dockOn() && cols >= MIN_TERM_WIDTH ? dockColsFor(cols) : 0);
}

/** The right dock holds the files list and/or the diffs panel. */
const dockOn = () => filesOn || showDiff;

/** Files-list rows when it shares the dock with the diffs panel. */
const dockFilesRows = () =>
	Math.max(6, Math.floor((tuiRef?.terminal?.rows ?? 24) * 0.4));

function buildDiffsPanel(theme: Theme, rows: () => number): Component {
	return framedPanel(
		theme,
		new BorderTop(theme, "Edits", "accent", () => false, { left: DOCK_GRIP }),
		new RecentBody(
			theme,
			(l) => l,
			(w) => diffLines(theme, w),
			() => diffVersion,
			"No edits yet",
			() => Math.max(1, rows() - 2),
			MAX_DIFFS * (MAX_DIFF_LINES + 2) * 2,
			diffLineAction,
			DOCK_GRIP,
		),
		{ left: DOCK_GRIP },
	);
}

function buildDockPanel(theme: Theme): Component {
	const termRows = () => tuiRef?.terminal?.rows ?? 0;
	if (filesOn && showDiff) {
		const filesRows = dockFilesRows();
		return new VStack([
			{
				component: new FilesPanel(theme, () => filesRows, () => false),
				basis: filesRows,
				grow: 0,
				shrink: 1,
				minSize: 4,
			},
			{
				component: buildDiffsPanel(theme, () => termRows() - filesRows),
				basis: 0,
				grow: 1,
				shrink: 1,
				minSize: 3,
			},
		]);
	}
	if (filesOn) return new FilesPanel(theme, termRows, () => false);
	return buildDiffsPanel(theme, termRows);
}

function buildFilesDock(theme: Theme, inner: Component): Component {
	const cols = tuiRef?.terminal?.columns ?? 120;
	const panelCols = dockColsFor(cols);
	composedDockCols = panelCols;
	composedDockRows = tuiRef?.terminal?.rows ?? 0;
	const panel = buildDockPanel(theme);
	// Wrap the left subtree in a MeasurementSafeVStack — the dock
	// HStack's discarded intrinsic-height measurement would otherwise eagerly
	// render the ENTIRE left side (band + transcript) every keystroke frame.
	// ENTRY FORM MATTERS: a bare component defaults to grow:0, and this
	// wrapper's sentinel render measures as 1 row — with grow:0 a SHORTER-
	// than-screen left subtree (e.g. trim mode's response doc) would collapse
	// to its intrinsic height instead of stretching, blanking the left side.
	const left = new MeasurementSafeVStack([
		{ component: inner, basis: 0, grow: 1, shrink: 1, minSize: 1 },
	]);
	return new HStack([
		{ component: left, basis: 0, grow: 1, shrink: 1, minSize: 1 },
		{
			component: panel,
			basis: panelCols,
			grow: 0,
			shrink: 0,
			minSize: panelCols,
			visible: (v: { width: number }) => v.width >= MIN_TERM_WIDTH,
		},
	]);
}

/**
 * Panel C trim mode: replace the transcript region of the base root with a
 * ScrollView over our response doc. The editor dock (pending/status/editor/
 * widgets/footer) is reused verbatim from the base root's second entry, so
 * input is untouched and the composition stays lossless to toggle.
 */
let responseScrollView: ScrollView | null = null;

/** Extract the editor dock from pi's base root (VStack[transcript, dock]). */
function baseDockOf(base: any): Component | null {
	const entries = base?.entries;
	if (!Array.isArray(entries)) return null;
	// The transcript entry holds the ScrollView (own `child`); the dock is the
	// other entry.
	for (const e of entries) {
		const c = e?.component;
		if (!c) continue;
		if (!Object.hasOwn(c, "child")) return c as Component; // not a ScrollView → dock
	}
	return null;
}

/** Build the trimmed inner: VStack([responseScroll, dock]) like pi's viewport. */
function buildTrimInner(theme: Theme): Component | null {
	const base = getBaseRoot();
	if (!base) return null;
	const dock = baseDockOf(base);
	if (!dock) return null;
	if (!responseScrollView) {
		responseScrollView = new ScrollView(responseDoc, {
			follow: "end",
			overscroll: "chain",
			scrollbar: "auto",
			scrollbarTrackStyle: (t: string) => theme.fg("dim", t),
			scrollbarThumbStyle: (t: string) => theme.fg("accent", t),
		});
	}
	return new VStack([
		{ component: responseScrollView, basis: 0, grow: 1, shrink: 1, minSize: 1 },
		{ component: dock, basis: "auto", grow: 0, shrink: 1, minSize: 1 },
	]);
}

/** Build the full composed layout root based on enabled panels. */
function composeLayout(theme: Theme, inner: Component): Component {
	// Trim mode swaps pi's transcript for the response doc; the base root's
	// dock (editor/footer) is preserved inside the swapped inner.
	let root = withCentredStatus(inner);
	if (trimResponse) {
		const trimmed = buildTrimInner(theme);
		if (trimmed) root = withCentredStatus(trimmed);
	}
	const wantBand = thinkingOn || toolsOn;
	if (wantBand) root = buildBand(theme, root);
	if (dockOn() && tuiRef && typeof tuiRef.setLayoutRoot === "function")
		root = buildFilesDock(theme, root);
	return root;
}

/** Reconcile the single "ui" layout layer with the current panel flags. */
function reconcileLayout(theme: Theme): void {
	const wantAny = thinkingOn || toolsOn || dockOn() || trimResponse;
	if (!wantAny || !tuiRef || typeof tuiRef.setLayoutRoot !== "function") {
		if (isLayoutLayerActive("ui")) setLayoutLayer("ui", null);
		return;
	}
	layoutTheme = theme;
	setLayoutLayer("ui", (inner: Component) => composeLayout(theme, inner));
	// SV-08: remember the theme this composition was built with.
	composedThemeFp = themeFingerprint(theme);
}

// ─── wiring ──────────────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
	pi.registerFlag("no-split", {
		description: "Start bare: skip the split-view panels (thinking/tools/files)",
		type: "boolean",
		default: false,
	});

	const ensureWidget = (ctx: ExtensionContext) => {
		if (ctx.mode !== "tui" || widgetSet) return;
		widgetSet = true;
		ctx.ui.setWidget(
			WIDGET_KEY,
			(tui, theme) => {
				tuiRef = tui;
				notifyRef = (m, t) => ctx.ui.notify(m, t);
				docTheme = theme;
				initLayoutManager(tui);
				// SV-14: apply the still-pending startup composition here. The
				// factory runs synchronously during session_start (before the
				// first paint) and the fullscreen root is available right now, so
				// the saved panels land in the FIRST painted frame. The deferred
				// startupTimer remains as the fallback for a later-ready root.
				if (startupPending && REG.gen === MY_GEN) {
					startupPending = false;
					reconcileLayout(ctx.ui.theme);
				}
				return {
					render: (width: number) => {
						selfHealLayout();
						// SV-08: pi swaps the global theme object on a theme change
						// (extensions get no event) and the composition + response doc
						// capture ANSI at build time. Compare a color fingerprint and
						// recompose with the live theme ONLY on a change — ordinary
						// state changes never rebuild the tree.
						const liveTheme = ctx.ui.theme;
						const fp = themeFingerprint(liveTheme);
						if (composedThemeFp === null) composedThemeFp = fp;
						else if (fp !== composedThemeFp) {
							composedThemeFp = fp;
							if (anyPanelActive()) {
								rebuildResponseDoc(ctx);
								reconcileLayout(liveTheme);
							}
						}
						// SV-07: the dock basis is captured at compose time, so a resize
						// used to leave the width frozen. Compare the clamped width the
						// composition would use now and recompose on change; the 34–48
						// clamp and the <90 hide rule are preserved (hide/show stays
						// dynamic via the entry's visible callback).
						if (
							dockOn() &&
							typeof tuiRef?.setLayoutRoot === "function" &&
							isLayoutLayerActive("ui")
						) {
							const cols = tuiRef?.terminal?.columns ?? 120;
							const want = dockColsFor(cols);
							const rows = tuiRef?.terminal?.rows ?? 0;
							if (want !== composedDockCols || rows !== composedDockRows)
								reconcileLayout(ctx.ui.theme);
						}
						// F2: same recompose hook for the band's explicit width split,
						// keyed on the TERMINAL width — any resize recomposes, even
						// when the tools cols round to the same value (101→102 at 50%).
						if (
							thinkingOn &&
							toolsOn &&
							typeof tuiRef?.setLayoutRoot === "function" &&
							isLayoutLayerActive("ui")
						) {
							const cols = tuiRef?.terminal?.columns ?? 120;
							if (cols !== composedBandTermCols)
								reconcileLayout(ctx.ui.theme);
						}
						// The files summary bar is hidden; the widget stays registered
						// only for the layout self-heal/recompose hooks above.
						return [];
					},
					invalidate: () => {},
				};
			},
			{ placement: "belowEditor" },
		);
	};

	/** Rebuild all buffers from the current branch (start / reload / tree). */
	const reconstruct = (ctx: ExtensionContext) => {
		thinking.reset();
		toolsBy.clear();
		toolOrder.length = 0;
		toolsVersionCounter++;
		files.clear();
		bumpFilesVersion();
		clearEditDiffs();
		rebuildResponseDoc(ctx);

		const branch = ctx.sessionManager.getBranch();
		const thoughts: string[] = [];
		/** edit toolCallId → path, so persisted results get their file name. */
		const editPaths = new Map<string, string>();
		for (const entry of branch) {
			if (entry.type !== "message") continue;
			const msg = (entry as any).message;
			if (!msg) continue;
			if (msg.role === "assistant" && Array.isArray(msg.content)) {
				for (const c of msg.content) {
					if (c?.type === "thinking" && typeof c.thinking === "string")
						thoughts.push(c.thinking);
					if (c?.type === "toolCall" && c.name) {
						if (
							c.name === "edit" &&
							typeof c.id === "string" &&
							typeof c.arguments?.path === "string"
						)
							editPaths.set(c.id, c.arguments.path);
						try {
							// SV-17: rebuild the bounded tools buffer from the
							// branch through the same ingest path live events use.
							if (typeof c.id === "string")
								ingestToolCall(c.id, c.name, c.arguments ?? {});
							record(c.name, c.arguments ?? {});
						} catch {
							/* skip */
						}
					}
				}
			}
			// Reconstruct the recent edit diffs from persisted tool-result details.
			if (msg.role === "toolResult" && msg.toolName === "edit") {
				const d = msg.details;
				if (d?.diff) {
					const id =
						typeof msg.toolCallId === "string" ? msg.toolCallId : undefined;
					const p =
						(id && editPaths.get(id)) || msg.input?.path || "";
					putEditDiff(id, p, d.diff, true);
				}
			}
			// SV-17: rebuild tool outputs from persisted results, correlated
			// to their calls by toolCallId.
			if (msg.role === "toolResult" && typeof msg.toolCallId === "string") {
				try {
					ingestToolResult(msg.toolCallId, msg.content, msg.isError);
				} catch {
					/* skip */
				}
			}
		}
		if (thoughts.length) {
			for (const t of thoughts) {
				thinking.current = { lines: t.split(/\r?\n/), tail: "", complete: true };
				thinking.blocks.push(thinking.current);
				thinking.current = null;
			}
			thinking.trim();
			thinking.version++;
		}
		ensureWidget(ctx);
		if (anyPanelActive()) requestRender();
	};

	pi.on("session_start", (_e, ctx) => {
		let cfg = normalizeConfig(loadUiPanelsConfig());
		if (pi.getFlag("no-split")) {
			// --no-split: start bare, ignoring the saved ui-panels.json defaults.
			cfg = {
				...cfg,
				split: false,
				thinking: false,
				tools: false,
				files: false,
				diff: false,
				trimResponse: false,
			};
		}
		thinkingOn = cfg.thinking;
		toolsOn = cfg.tools;
		toolMode = cfg.toolMode;
		bandHeight = cfg.bandHeight;
		toolsWidthPct = cfg.toolsWidthPct;
		dockWidth = cfg.dockWidth;
		filesOn = cfg.files;
		showDiff = cfg.diff;
		answerDividerMode = cfg.answerDivider;
		trimResponse = cfg.trimResponse;
		// SV-14: arm the startup composition BEFORE reconstruct — the widget
		// factory runs synchronously inside it and is the first point where the
		// fullscreen root is available (before the first paint). The deferred
		// timer below used to be the ONLY composition point, but it fires after
		// the first paint, so the first screen never showed the saved panels.
		startupPending = ctx.mode === "tui";
		reconstruct(ctx);
		// Reapply the saved composition after the fullscreen root is ready.
		if (ctx.mode === "tui") {
			if (startupTimer) clearTimeout(startupTimer);
			startupTimer = setTimeout(() => {
				startupTimer = null;
				if (REG.gen !== MY_GEN) return;
				try {
					if (tuiRef && typeof tuiRef.setLayoutRoot === "function") {
						// SV-14: fallback — the factory composes when the root is
						// already available there; this timer only composes if
						// that has not happened yet.
						if (startupPending) {
							startupPending = false;
							reconcileLayout(ctx.ui.theme);
						}
						if (cfg.split) ctx.ui.notify("Split view on", "info");
					} else if (cfg.files) {
						// Regular mode uses an overlay; filesOn is already the saved
						// state, so clear it before calling the toggle.
						filesOn = false;
						toggleFilesPanel(ctx);
					}
				} catch {
					/* never crash pi from a deferred callback */
				}
			}, 0);
		}
	});
	pi.on("session_tree", (_e, ctx) => reconstruct(ctx));

	// Thinking stream.
	pi.on("message_update", (event) => {
		const d = (event as any).assistantMessageEvent;
		if (d) {
			if (d.type === "thinking_start") thinking.start();
			else if (d.type === "thinking_delta") thinking.append(d.delta ?? "");
			else if (d.type === "thinking_end") thinking.end(d.content ?? "");
		}
		responseMessageUpdate((event as any).message);
		if (anyPanelActive()) requestRender();
	});

	// Response stream (panel C trim mode): mirror user/assistant messages into
	// the response doc. Always maintained so toggling trim mid-turn is seamless.
	// Assistant components are created lazily on first visible text (update),
	// so tool-only / thinking-only rounds add nothing to the doc.
	pi.on("message_start", (event) => {
		const msg = (event as any).message;
		if (msg?.role === "user") addResponseMessage(msg);
		if (anyPanelActive()) requestRender();
	});
	pi.on("message_end", (event) => {
		responseMessageEnd((event as any).message);
		if (anyPanelActive()) requestRender();
	});

	// Tool stream.
	pi.on("tool_execution_start", (event) => {
		// SV-17: same ingest path the branch rebuild uses.
		ingestToolCall(event.toolCallId, event.toolName, event.args);
		if (anyPanelActive()) requestRender();
	});
	pi.on("tool_execution_update", (event) => {
		const e = toolsBy.get(event.toolCallId);
		if (e) {
			setToolOutput(e, resultText((event as any).partialResult));
			markToolsDirty();
		}
		if (anyPanelActive()) requestRender();
	});
	pi.on("tool_execution_end", (event) => {
		// SV-17: same ingest path the branch rebuild uses.
		ingestToolResult(event.toolCallId, (event as any).result, event.isError);
		if (anyPanelActive()) requestRender();
	});

	// Edit diff: preview on tool_call (preflight args), authoritative on result.
	pi.on("tool_call", (event) => {
		if (event.toolName !== "edit") {
			// Still record files for non-edit tools (write/read/bash/grep...).
			try {
				record(event.toolName, event.input ?? {});
			} catch {
				/* skip */
			}
			bumpFilesVersion();
			if (anyPanelActive()) requestRender();
			return;
		}
		const input = event.input ?? {};
		const p = typeof input.path === "string" ? input.path : "";
		const edits = Array.isArray(input.edits) ? input.edits : [];
		const id = typeof event.toolCallId === "string" ? event.toolCallId : undefined;
		// Compute a diff from the edit pairs (synchronous, no file read needed).
		// generateDiffString(oldText, newText, contextLines) produces a unified diff.
		const parts: string[] = [];
		for (const e of edits) {
			const o = typeof e.oldText === "string" ? e.oldText : "";
			const n = typeof e.newText === "string" ? e.newText : "";
			if (o !== n) parts.push(generateDiffString(o, n, 3).diff);
		}
		// Preview entry, keyed by toolCallId; the result replaces it in place.
		if (parts.length) putEditDiff(id, p, parts.join("\n"), false);
		try {
			record("edit", input);
		} catch {
			/* skip */
		}
		bumpFilesVersion();
		if (anyPanelActive()) requestRender();
	});
	pi.on("tool_result", (event) => {
		if (event.toolName !== "edit") return;
		// Authoritative diff from the result details (branch-correct).
		const d = (event as any).details;
		if (d?.diff) {
			// SV-23: the result replaces only its own preview entry (matched by
			// toolCallId), so an older, slower result never touches a newer
			// edit. Without an ID it refines the newest entry for the same path.
			const rawId = (event as any).toolCallId;
			const inputPath = (event as any).input?.path;
			const p = typeof inputPath === "string" ? inputPath : "";
			const id = typeof rawId === "string" ? rawId : undefined;
			if (id === undefined) {
				const last = lastDiff();
				if (last && last.id === undefined && (!p || last.path === p)) {
					last.diff = d.diff;
					last.final = true;
					diffVersion++;
					if (anyPanelActive()) requestRender();
					return;
				}
			}
			putEditDiff(id, p, d.diff, true);
			if (anyPanelActive()) requestRender();
		}
	});

	// Subagent tool calls: record files with "a" op AND tool panel entries.
	pi.events.on("subagents:tool_call", (data) => {
		const { toolName, input, agent } = (data ?? {}) as {
			toolName?: string;
			input?: unknown;
			agent?: string;
		};
		if (!toolName) return;
		// Files tracking with "a" op.
		try {
			for (const { abs } of pathsFrom(toolName, input ?? {})) {
				const prev = files.get(abs);
				if (prev) {
					files.delete(abs);
					prev.count++;
					if (!prev.ops.includes("a")) prev.ops += "a";
					files.set(abs, prev);
				} else {
					if (files.size >= MAX_FILES)
						files.delete(files.keys().next().value as string);
					files.set(abs, { path: abs, ops: "a", count: 1 });
				}
			}
			bumpFilesVersion();
		} catch {
			/* never break the listener */
		}
		// Tool panel entry with [agent] badge.
		const id = `sub:${Date.now()}:${Math.random().toString(36).slice(2, 7)}`;
		toolOrder.push(id);
		toolsBy.set(id, {
			id,
			name: toolName,
			args: argsJson(input),
			output: "",
			active: false,
			isError: false,
			subagent: true,
			agent,
		});
		toolsVersionCounter++;
		if (toolOrder.length > MAX_TOOLS) {
			const evict = toolOrder.shift()!;
			toolsBy.delete(evict);
		}
		if (anyPanelActive()) requestRender();
	});

	pi.on("session_shutdown", (_e, ctx) => {
		if (startupTimer) {
			clearTimeout(startupTimer);
			startupTimer = null;
		}
		// SV-02/SV-15 (Option C): retire the overlay through the same valid
		// owner for the CURRENT generation AND for a stale one. The
		// identity-specific handle's hide() removes only its own entry (a safe
		// no-op if Pi already removed it — it never pops an unrelated topmost
		// overlay), and the stored component is disposed with it. Never merely
		// forget REG.active: an undisposed stale-generation panel keeps
		// rendering blank.
		if (REG.active) {
			REG.active.hide();
			REG.active = null;
		}
		if (REG.panel) {
			REG.panel.dispose();
			REG.panel = null;
		}
		REG.activeGen = undefined;
		if (isLayoutLayerActive("ui")) setLayoutLayer("ui", null);
		ctx.ui.setWidget(WIDGET_KEY, undefined);
		widgetSet = false;
	});

	// ── panel toggles ──

	/** Toggle the files panel (dock in fullscreen, overlay in regular). */
	const toggleFilesPanel = (ctx: ExtensionContext): boolean => {
		if (ctx.mode !== "tui") {
			ctx.ui.notify("/files requires interactive mode", "error");
			return filesActive();
		}
		// Fullscreen: use the composed layer.
		if (tuiRef && typeof tuiRef.setLayoutRoot === "function") {
			if (filesOn) {
				filesOn = false;
				reconcileLayout(ctx.ui.theme);
				ctx.ui.notify("Files panel closed", "info");
				return false;
			}
			filesOn = true;
			reconcileLayout(ctx.ui.theme);
			// SV-24: be truthful when the dock is composed but gated invisible
			// — the entry's visible callback hides it below MIN_TERM_WIDTH, so
			// "docked right" alone would overstate what the user sees.
			const dockCols = tuiRef?.terminal?.columns ?? 0;
			if (dockCols > 0 && dockCols < MIN_TERM_WIDTH) {
				ctx.ui.notify(
					`Files panel on — hidden below ${MIN_TERM_WIDTH} cols (now ${dockCols})`,
					"warning",
				);
			} else {
				ctx.ui.notify("Files panel docked right", "info");
			}
			return true;
		}
		// Regular mode: passive TUI overlay (Option C — decisions/D-overlay-lifecycle.md).
		// No ctx.ui.custom() promise is created, so nothing can be stranded; the
		// extension owns the lifecycle: the identity-specific OverlayHandle is
		// the only close path, and the panel component is disposed with it.
		// Escape belongs to the editor/Pi — /files is the close/reopen path.
		if (REG.active) {
			const wasStale = REG.activeGen !== MY_GEN;
			// SV-15: retire even a stale-generation overlay through the same
			// valid owner (handle hide + component dispose) instead of merely
			// forgetting REG.active.
			REG.active.hide();
			REG.panel?.dispose();
			REG.active = null;
			REG.panel = null;
			REG.activeGen = undefined;
			if (!wasStale) {
				ctx.ui.notify("Files panel closed", "info");
				return false;
			}
			// A stale overlay was retired — fall through and open a fresh one
			// so a single /files leaves exactly one live overlay.
		}
		if ((process.stdout.columns ?? 0) < MIN_TERM_WIDTH) {
			ctx.ui.notify(`Terminal too narrow (min ${MIN_TERM_WIDTH} cols)`, "warning");
			return false;
		}
		if (!tuiRef || typeof tuiRef.showOverlay !== "function") {
			ctx.ui.notify("/files requires interactive mode", "error");
			return false;
		}
		const panel = new FilesPanel(ctx.ui.theme);
		const cols = tuiRef?.terminal?.columns ?? process.stdout.columns ?? 0;
		REG.panel = panel;
		REG.active = tuiRef.showOverlay(panel, {
			anchor: "top-right",
			width: dockColsFor(cols),
			margin: 0,
			maxHeight: "100%",
			nonCapturing: true,
			visible: (w: number, h: number) => {
				termHeight = h;
				return w >= MIN_TERM_WIDTH;
			},
		});
		REG.activeGen = MY_GEN;
		return true;
	};

	pi.registerCommand("split", {
		description:
			"Toggle all panels: off = bare pi layout, on = saved startup defaults",
		handler: async (_args, ctx) => {
			if (ctx.mode !== "tui") {
				ctx.ui.notify("/split requires interactive mode", "error");
				return;
			}
			if (!tuiRef || typeof tuiRef.setLayoutRoot !== "function") {
				ctx.ui.notify("/split requires fullscreen mode", "warning");
				return;
			}
			// Full toggle pair (revised SV-01): OFF clears every panel flag so
			// pi's native layout is fully restored (no band, no files dock, no
			// trim/response-only swap). ON restores the panel flags saved as
			// startup defaults (ui-panels.json, written by /split-save); if the
			// saved layout has no panels on (or was never saved), fall back to
			// the classic default of thinking + tools. Geometry (bandHeight,
			// toolMode, toolsWidthPct) is session-local and not reset here.
			const wasOn = panelsActive();
			if (wasOn) {
				thinkingOn = false;
				toolsOn = false;
				filesOn = false;
				showDiff = false;
				trimResponse = false;
				reconcileLayout(ctx.ui.theme);
				ctx.ui.notify("Split view off (all panels) · /split-save saves defaults", "info");
			} else {
				const cfg = normalizeConfig(loadUiPanelsConfig());
				if (
					!cfg.thinking &&
					!cfg.tools &&
					!cfg.files &&
					!cfg.diff &&
					!cfg.trimResponse
				) {
					thinkingOn = true;
					toolsOn = true;
				} else {
					thinkingOn = cfg.thinking;
					toolsOn = cfg.tools;
					filesOn = cfg.files;
					showDiff = cfg.diff;
					answerDividerMode = cfg.answerDivider;
					trimResponse = cfg.trimResponse;
				}
				reconcileLayout(ctx.ui.theme);
				ctx.ui.notify("Split view on (saved layout) · /split-save saves defaults", "info");
			}
		},
	});

	pi.registerCommand("split-thinking", {
		description: "Toggle the thinking panel within the band",
		handler: async (_args, ctx) => {
			if (ctx.mode !== "tui") return;
			thinkingOn = !thinkingOn;
			if (thinkingOn || toolsOn) {
				reconcileLayout(ctx.ui.theme);
				ctx.ui.notify(`Thinking ${thinkingOn ? "on" : "off"}`, "info");
			} else {
				reconcileLayout(ctx.ui.theme);
				ctx.ui.notify("Band off (no panels)", "info");
			}
		},
	});

	pi.registerCommand("split-tools", {
		description: "Toggle the tools panel within the band",
		handler: async (_args, ctx) => {
			if (ctx.mode !== "tui") return;
			toolsOn = !toolsOn;
			reconcileLayout(ctx.ui.theme);
			ctx.ui.notify(`Tools ${toolsOn ? "on" : "off"}`, "info");
		},
	});

	pi.registerCommand("files", {
		description: "Toggle the files panel (dock or overlay)",
		handler: async (_args, ctx) => {
			toggleFilesPanel(ctx);
		},
	});

	pi.registerCommand("split-diff", {
		description:
			"Toggle the edits panel (last 10 diffs, scrollable), independent of /files",
		handler: async (_args, ctx) => {
			showDiff = !showDiff;
			filesVersion++;
			// Fullscreen: the edits panel is its own dock entry; regular mode
			// keeps it as the files overlay's last-edit subpanel.
			if (tuiRef && typeof tuiRef.setLayoutRoot === "function")
				reconcileLayout(ctx.ui.theme);
			requestRender();
			ctx.ui.notify(`Edits panel ${showDiff ? "on" : "off"}`, "info");
		},
	});

	pi.registerCommand("split-tools-view", {
		description: "Toggle tool panel compact ↔ full detail",
		handler: async (_args, ctx) => {
			toolMode = toolMode === "compact" ? "full" : "compact";
			toolsVersionCounter++;
			ctx.ui.notify(`Tool panel: ${toolMode}`, "info");
			requestRender();
		},
	});

	pi.registerCommand("split-height", {
		description: "Set the top band height in rows (6-40)",
		handler: async (args, ctx) => {
			const n = Number.parseInt(String(args ?? "").trim(), 10);
			if (Number.isNaN(n)) {
				ctx.ui.notify(
					`Band height: ${bandHeight} rows (usage: /split-height 6-40)`,
					"info",
				);
				return;
			}
			bandHeight = Math.max(6, Math.min(40, n));
			reconcileLayout(ctx.ui.theme);
			ctx.ui.notify(`Band height: ${bandHeight} rows`, "info");
		},
	});

	pi.registerCommand("split-tools-width", {
		description: "Set tools panel width as % of the band (20-60, default 35)",
		handler: async (args, ctx) => {
			const arg = String(args ?? "").trim();
			if (!arg) {
				ctx.ui.notify(
					`Tools panel width: ${toolsWidthPct}% of the band (usage: /split-tools-width 20-60)`,
					"info",
				);
				return;
			}
			const n = Number.parseInt(arg, 10);
			if (Number.isNaN(n)) {
				ctx.ui.notify(
					"Invalid percentage (usage: /split-tools-width 20-60)",
					"error",
				);
				return;
			}
			toolsWidthPct = Math.max(20, Math.min(60, n));
			reconcileLayout(ctx.ui.theme);
			ctx.ui.notify(`Tools panel width: ${toolsWidthPct}%`, "info");
		},
	});

	pi.registerCommand("split-divider", {
		description:
			"Response-only divider between successive answers: rule | space",
		handler: async (args, ctx) => {
			if (ctx.mode !== "tui") return;
			const arg = String(args ?? "").trim().toLowerCase();
			if (arg === "rule") answerDividerMode = "rule";
			else if (arg === "space") answerDividerMode = "space";
			else answerDividerMode = answerDividerMode === "rule" ? "space" : "rule";
			// Doc children were built with the old mode → rebuild from branch.
			rebuildResponseDoc(ctx);
			if (anyPanelActive()) requestRender();
			ctx.ui.notify(`Answer divider: ${answerDividerMode}`, "info");
		},
	});

	pi.registerCommand("split-trim-response", {
		description:
			"Panel C: full transcript ↔ response-only (on|off) — response-only: text-only (native parity), full scrollback, scroll offset preserved on branch switch",
		handler: async (args, ctx) => {
			if (ctx.mode !== "tui") {
				ctx.ui.notify("/split-trim-response requires interactive mode", "error");
				return;
			}
			if (!tuiRef || typeof tuiRef.setLayoutRoot !== "function") {
				ctx.ui.notify("/split-trim-response requires fullscreen mode", "warning");
				return;
			}
			const arg = String(args ?? "")
				.trim()
				.toLowerCase();
			const next = arg === "on" ? true : arg === "off" ? false : !trimResponse;
			if (next) {
				const base = getBaseRoot();
				if (!base) {
					ctx.ui.notify("Layout root not ready yet", "warning");
					return;
				}
				// SV-22: trim mode swaps the transcript for the response doc and
				// keeps only the extracted editor dock. If the dock cannot be
				// extracted, fail loudly instead of silently leaving the native
				// transcript while claiming response-only.
				if (!baseDockOf(base)) {
					ctx.ui.notify(
						"Panel C unavailable: editor dock not found in the layout root",
						"error",
					);
					return;
				}
			}
			trimResponse = next;
			reconcileLayout(ctx.ui.theme);
			ctx.ui.notify(
				`Panel C: ${trimResponse ? "response only" : "full transcript"}`,
				"info",
			);
		},
	});

	pi.registerCommand("split-save", {
		description: "Save current panel layout as the startup defaults",
		handler: async (_args, ctx) => {
			// SV-11: serialize the EFFECTIVE files state — a regular-mode files
			// overlay of the CURRENT generation counts as files-on; an overlay left
			// over from a stale generation must not save a phantom panel.
			const filesEffective =
				filesOn || (REG.active !== null && REG.activeGen === MY_GEN);
			// SV-13: report the real outcome — success only after a durable write.
			const saved = saveUiPanelsConfig({
				split: thinkingOn || toolsOn,
				thinking: thinkingOn,
				tools: toolsOn,
				files: filesEffective,
				toolMode,
				trimResponse,
				bandHeight,
				toolsWidthPct,
				...(dockWidth === null ? {} : { dockWidth }),
				diff: showDiff,
				answerDivider: answerDividerMode,
			});
			ctx.ui.notify(
				saved
					? "Panel layout saved as startup defaults for new windows"
					: "Could not save panel layout (config write failed)",
				saved ? "info" : "error",
			);
		},
	});
}
