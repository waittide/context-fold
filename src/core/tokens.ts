/*
 * tokens.ts — crude, uniform token estimation.
 *
 * Bare-bones: ~4 chars per token. Good enough to drive the budget bar and the fold
 * boundary. A real per-model tokenizer is deferred; everything downstream reads from
 * estTokens so swapping it is a one-line change. (Ported verbatim from Accordion
 * `engine/tokens.ts`, pinned commit 0c22434.)
 */

const CHARS_PER_TOKEN = 4;
/** Per-block structural overhead (role tags, delimiters). */
export const BLOCK_OVERHEAD = 4;

export function estTokens(s: string): number {
	if (!s) return 0;
	return Math.ceil(s.length / CHARS_PER_TOKEN);
}

/** Prefix slice that never splits a surrogate pair (backs off one unit at a mid-pair cut). */
export function safeSlice(s: string, end: number): string {
	const cut = Math.min(Math.max(0, end), s.length);
	if (cut >= s.length) return s;
	return s.slice(0, isHighSurrogate(s.charCodeAt(cut - 1)) ? cut - 1 : cut);
}

// ── UTF-16 safety ────────────────────────────────────────────────────────────
// A plain slice can land between the two code units of an astral character (emoji, CJK
// ext-B+), stranding a lone surrogate. JSON.stringify emits it as a `\udXXX` escape, and
// any gateway that re-encodes request bodies to strict UTF-8 then throws on every retry:
// a deterministic poison that never heals (ranxianglei/billion-context#816). Fold digests
// are hand-built strings clipped straight out of user content, so this path is reachable.
//
// Adapted from billion-context kernel `src/truncate.ts` (MIT, Copyright (c) 2026
// ranxianglei); retargeted to this module's naming and merged with `safeSlice`.

function isHighSurrogate(c: number): boolean {
	return c >= 0xd800 && c <= 0xdbff;
}

function isLowSurrogate(c: number): boolean {
	return c >= 0xdc00 && c <= 0xdfff;
}

/** At most `maxUnits` code units; never ends on a stranded high surrogate. */
export function clampPrefix(s: string, maxUnits: number): string {
	const cut = Math.min(Math.max(0, maxUnits), s.length);
	if (cut > 0 && isHighSurrogate(s.charCodeAt(cut - 1))) return s.slice(0, cut - 1);
	return s.slice(0, cut);
}

/** A `[start, end)` window with both edges snapped off surrogate pairs. */
export function clampWindow(s: string, start: number, end: number): string {
	let a = Math.max(0, Math.min(start, s.length));
	let b = Math.min(s.length, Math.max(a, end));
	if (a > 0 && isLowSurrogate(s.charCodeAt(a))) a += 1;
	if (b > a && isHighSurrogate(s.charCodeAt(b - 1))) b -= 1;
	return s.slice(a, Math.max(a, b));
}

/**
 * Belt-and-braces: replace any unpaired surrogate half (whatever its source — folded
 * digests, hand-built strings, upstream payload) with U+FFFD so it can never reach
 * JSON.stringify as an unpaired escape. Valid pairs pass through verbatim.
 */
export function scrubLoneSurrogates(s: string): string {
	if (!s) return s;
	return s
		.replace(/[\ud800-\udbff](?![\udc00-\udfff])/g, "\ufffd")
		.replace(/(?<![\ud800-\udbff])[\udc00-\udfff]/g, "\ufffd");
}

export function clip(s: string, n: number): string {
	const m = Math.max(1, n);
	const t = s.replace(/\s+/g, " ").trim();
	if (t.length <= m) return t;
	return scrubLoneSurrogates(clampPrefix(t, m - 1)).trimEnd() + "…";
}

export function firstLine(s: string, n = 100): string {
	const line = (s.split("\n").find((l) => l.trim()) ?? "").trim();
	return clip(line, n);
}
