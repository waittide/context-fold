/*
 * turn-integrity.test.ts — the strict-echo gate.
 *
 * A folded `thinking` block is re-sent to the provider as text, but pi forwards SIGNED reasoning
 * (Anthropic's `thinkingSignature`) alongside the untouched tool call that reasoning produced.
 * A signature authenticates the text that carried it, so rewriting the text alone leaves a request
 * the provider rejects. The gate keeps such a turn verbatim.
 *
 * Unsigned reasoning (a provider that echoes bare reasoning text, or one that strips prior
 * thinking) is NOT gated: nothing in the request ties the old text to the surviving call, so the
 * fold is sound and the savings are real.
 */
import { describe, it, expect } from "vitest";
import { linearize } from "../src/core/block";
import { computeStrictEchoGroups, computeStrictEchoWithdrawals, strictEchoStats } from "../src/core/turn-integrity";
import { assistantWithCalls, toolResult, user } from "./helpers";
import type { AgentMessage } from "../src/core/block";

const blocks = (...msgs: AgentMessage[]) => linearize(msgs);

/** An assistant turn with SIGNED reasoning followed by one tool call. */
function signedReasoningCall(opts: { responseId?: string; callId?: string; signature?: string } = {}): AgentMessage {
	const msg = assistantWithCalls([{ id: opts.callId ?? "c1", name: "read", args: {} }], {
		thinking: "let me look at the file",
		responseId: opts.responseId ?? "r2",
	});
	(msg.content as any[])[0].thinkingSignature = opts.signature ?? "sig-abc123";
	return msg;
}

/** The same turn, but the reasoning carries no signature. */
function unsignedReasoningCall(responseId = "r2"): AgentMessage {
	return assistantWithCalls([{ id: "c1", name: "read", args: {} }], {
		thinking: "let me look at the file",
		responseId,
	});
}

describe("linearize records the signature", () => {
	it("marks a signed thinking block", () => {
		const b = blocks(signedReasoningCall());
		expect(b.find((x) => x.kind === "thinking")?.signed).toBe(true);
	});
	it("leaves an unsigned thinking block unflagged", () => {
		const b = blocks(unsignedReasoningCall());
		expect(b.find((x) => x.kind === "thinking")?.signed).toBeUndefined();
	});
});

describe("computeStrictEchoGroups", () => {
	it("groups signed reasoning with the tool call it produced", () => {
		expect(computeStrictEchoGroups(blocks(signedReasoningCall()))).toEqual([["a:r2:p0", "a:r2:p1"]]);
	});

	it("pulls the answering tool_result into the group", () => {
		const b = blocks(signedReasoningCall(), toolResult("c1", "file contents"));
		expect(computeStrictEchoGroups(b)[0]).toContain("r:c1");
	});

	it("ignores UNSIGNED reasoning even when a tool call follows", () => {
		expect(computeStrictEchoGroups(blocks(unsignedReasoningCall(), toolResult("c1", "x")))).toHaveLength(0);
	});

	it("ignores signed reasoning that produced only prose", () => {
		const msg = assistantWithCalls([], { thinking: "hm", text: "answer", responseId: "r3" });
		(msg.content as any[])[0].thinkingSignature = "sig";
		expect(computeStrictEchoGroups(blocks(msg))).toHaveLength(0);
	});

	it("ignores a tool call with no preceding reasoning", () => {
		expect(computeStrictEchoGroups(blocks(assistantWithCalls([{ id: "c1", name: "read", args: {} }])))).toHaveLength(0);
	});

	it("ignores orphan signed reasoning with no following act", () => {
		const msg = assistantWithCalls([], { thinking: "dangling", responseId: "r4" });
		(msg.content as any[])[0].thinkingSignature = "sig";
		expect(computeStrictEchoGroups(blocks(msg))).toHaveLength(0);
	});

	it("never pulls a user block into a group", () => {
		const groups = computeStrictEchoGroups(blocks(user("fix it"), signedReasoningCall()));
		expect(groups).toHaveLength(1);
		expect(groups[0].some((id) => id.startsWith("u:"))).toBe(false);
	});
});

describe("computeStrictEchoWithdrawals", () => {
	const turn = () => blocks(signedReasoningCall(), toolResult("c1", "file contents"));

	it("withdraws reasoning folded under a verbatim tool call", () => {
		// tool_call is never foldable, so this is exactly the real op shape.
		expect(computeStrictEchoWithdrawals(turn(), new Set(["a:r2:p0"])).has("a:r2:p0")).toBe(true);
	});

	it("allows folding the whole group", () => {
		expect(computeStrictEchoWithdrawals(turn(), new Set(["a:r2:p0", "a:r2:p1", "r:c1"])).size).toBe(0);
	});

	it("leaves an entirely unfolded group alone", () => {
		expect(computeStrictEchoWithdrawals(turn(), new Set(["r:other"])).size).toBe(0);
	});

	it("is a no-op for an empty fold set", () => {
		expect(computeStrictEchoWithdrawals(turn(), new Set()).size).toBe(0);
	});

	it("withdraws only the folded members, not the whole group", () => {
		const withdrawn = computeStrictEchoWithdrawals(turn(), new Set(["a:r2:p0", "r:c1"]));
		expect([...withdrawn].sort()).toEqual(["a:r2:p0", "r:c1"]);
	});

	it("lets unsigned reasoning fold next to a live tool call", () => {
		const b = blocks(unsignedReasoningCall(), toolResult("c1", "x"));
		expect(computeStrictEchoWithdrawals(b, new Set(["a:r2:p0"])).size).toBe(0);
	});

	it("does not withdraw reasoning from a prose-only turn", () => {
		const msg = assistantWithCalls([], { thinking: "hm", text: "answer", responseId: "r5" });
		(msg.content as any[])[0].thinkingSignature = "sig";
		expect(computeStrictEchoWithdrawals(blocks(msg), new Set(["a:r5:p0"])).size).toBe(0);
	});
});

describe("strictEchoStats", () => {
	it("counts split groups", () => {
		const b = blocks(signedReasoningCall(), toolResult("c1", "x"));
		expect(strictEchoStats(b, new Set(["a:r2:p0"]))).toEqual({ groups: 1, foldedGroups: 1 });
		expect(strictEchoStats(b, new Set())).toEqual({ groups: 1, foldedGroups: 0 });
	});
});
