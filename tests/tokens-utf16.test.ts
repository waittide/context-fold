/*
 * tokens-utf16.test.ts — UTF-16 boundary safety for folded digests.
 *
 * A lone surrogate reaches the wire as a `\udXXX` escape; a gateway that re-encodes the request
 * body to strict UTF-8 then throws on every retry, a deterministic poison that never heals
 * (ranxianglei/billion-context#816). Fold digests are clipped straight out of user content, so
 * every clipping helper must leave valid text behind.
 */
import { describe, it, expect } from "vitest";
import { safeSlice, clampPrefix, clampWindow, scrubLoneSurrogates, clip, firstLine } from "../src/core/tokens";
import { digest, foldTag } from "../src/core/digest";

/** An astral character (emoji) as its two UTF-16 code units. */
const EMOJI = "\u{1F600}"; // 😀
const HIGH = "\ud83d";
const LOW = "\ude00";

/** No unpaired surrogate survives in `s`. */
function hasLoneSurrogate(s: string): boolean {
	return /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/.test(s);
}

describe("safeSlice", () => {
	it("backs off one unit when the cut lands mid-pair", () => {
		const s = `a${EMOJI}b`; // a, high, low, b
		expect(safeSlice(s, 2)).toBe("a"); // would cut between high and low
		expect(safeSlice(s, 3)).toBe(`a${EMOJI}`);
	});
	it("is a no-op past the end and clamps negative input", () => {
		expect(safeSlice("abc", 99)).toBe("abc");
		expect(safeSlice("abc", -1)).toBe("");
	});
	it("never strands a high surrogate for every cut point", () => {
		const s = `${EMOJI}${EMOJI}${EMOJI}`;
		for (let i = 0; i <= s.length; i++) expect(hasLoneSurrogate(safeSlice(s, i))).toBe(false);
	});
});

describe("clampPrefix", () => {
	it("never ends on a stranded high surrogate", () => {
		const s = `${EMOJI}x`;
		expect(clampPrefix(s, 1)).toBe("");
		expect(clampPrefix(s, 2)).toBe(EMOJI);
		expect(clampPrefix(s, 3)).toBe(`${EMOJI}x`);
	});
	it("clamps out-of-range counts", () => {
		expect(clampPrefix("abc", 99)).toBe("abc");
		expect(clampPrefix("abc", -5)).toBe("");
	});
});

describe("clampWindow", () => {
	it("snaps both edges off a surrogate pair", () => {
		const s = `a${EMOJI}b`; // indices: 0=a 1=high 2=low 3=b
		expect(clampWindow(s, 2, 3)).toBe(""); // starts on low, ends after low -> empty
		expect(clampWindow(s, 1, 3)).toBe(EMOJI); // starts on high, ends at pair end
		expect(clampWindow(s, 0, 4)).toBe(s);
	});
	it("never strands a surrogate for any window", () => {
		const s = `x${EMOJI}y${EMOJI}z`;
		for (let a = 0; a <= s.length; a++) {
			for (let b = a; b <= s.length; b++) {
				expect(hasLoneSurrogate(clampWindow(s, a, b))).toBe(false);
			}
		}
	});
});

describe("scrubLoneSurrogates", () => {
	it("replaces an unpaired high surrogate with U+FFFD", () => {
		expect(scrubLoneSurrogates(`a${HIGH}b`)).toBe("a\ufffdb");
	});
	it("replaces an unpaired low surrogate with U+FFFD", () => {
		expect(scrubLoneSurrogates(`a${LOW}b`)).toBe("a\ufffdb");
	});
	it("passes valid pairs and ordinary text through verbatim", () => {
		expect(scrubLoneSurrogates(EMOJI)).toBe(EMOJI);
		expect(scrubLoneSurrogates("hello 世界")).toBe("hello 世界");
		expect(scrubLoneSurrogates("")).toBe("");
	});
	it("leaves no lone surrogate behind after scrubbing a mix", () => {
		const s = `${HIGH}ok${LOW}${EMOJI}${HIGH}`;
		const out = scrubLoneSurrogates(s);
		expect(hasLoneSurrogate(out)).toBe(false);
		expect(out).toContain(EMOJI); // the valid pair survives
	});
});

describe("clip and firstLine keep the wire valid", () => {
	it("clip never strands a surrogate at the cut point", () => {
		const s = `${EMOJI.repeat(10)}`;
		for (let n = 1; n <= 12; n++) {
			const out = clip(s, n);
			expect(hasLoneSurrogate(out)).toBe(false);
		}
	});
	it("firstLine on an emoji-only line stays valid", () => {
		const out = firstLine(`${EMOJI.repeat(50)}\nsecond`);
		expect(hasLoneSurrogate(out)).toBe(false);
	});
	it("clip does not corrupt a valid adjacent pair at the boundary", () => {
		// 3 chars of budget: "ab" + high/low would need 4, so the pair is dropped whole.
		const out = clip(`ab${EMOJI}`, 3);
		expect(hasLoneSurrogate(out)).toBe(false);
	});
});

describe("digest is wire-safe for astral content", () => {
	const mk = (kind: "tool_result" | "thinking" | "text", text: string) => ({
		id: "r:c1",
		kind,
		text,
		tokens: 1,
		toolName: "read",
		isError: false,
	});

	it("a tool_result whose peek lands mid-emoji still digests validly", () => {
		const d = digest(mk("tool_result", `${EMOJI.repeat(40)} tail`));
		expect(hasLoneSurrogate(d)).toBe(false);
		expect(d.startsWith(foldTag("r:c1"))).toBe(true);
	});
	it("a thinking digest is valid for astral content", () => {
		const d = digest(mk("thinking", `${EMOJI.repeat(30)}`));
		expect(hasLoneSurrogate(d)).toBe(false);
	});
	it("a text digest is valid for astral content", () => {
		const d = digest(mk("text", `${EMOJI.repeat(80)}`));
		expect(hasLoneSurrogate(d)).toBe(false);
	});
	it("JSON.stringify of a digest holds no unpaired escape", () => {
		const d = digest(mk("tool_result", `${HIGH}raw${LOW}`));
		expect(JSON.stringify(d)).not.toMatch(/\\ud[89ab][0-9a-f]{2}(?!\\ud[c-f])/i);
	});
});
