/*
 * turn-integrity.ts — strict-echo coupling: reasoning must not be rewritten under its act.
 *
 * Folding is content substitution: a block stays in the array and keeps its callId, so a
 * tool_call/tool_result pair can never ORPHAN (see apply.ts). These are the couplings that
 * substitution alone does NOT protect:
 *
 *   • Strict-echo reasoning. Pi forwards prior `thinking` blocks back to the provider with their
 *     signature / reasoning field intact (`anthropic-messages`: `{type:"thinking", thinking:
 *     sanitizeSurrogates(text), signature}`; `openai-completions`: the text is re-sent as
 *     `reasoning_content`). Rewriting the text while keeping the signature or the tool call that
 *     the reasoning produced makes the request internally inconsistent. DeepSeek states the
 *     contract outright: "The `reasoning_content` in the thinking mode must be passed back to
 *     the API" — and the failure mode is an HTTP 400, not a degraded answer.
 *
 * So: a `thinking` block may be folded only when the assistant act it produced is folded with it,
 * or when the turn has no tool call at all. Because this project never folds `tool_call`, that
 * reduces to one rule for tool-using turns — the reasoning stays verbatim.
 *
 * Adapted from billion-context `kernel/src/turn-integrity.ts` and `kernel/src/reasoning-pairs.ts`
 * (MIT, Copyright (c) 2026 ranxianglei), re-expressed against this project's durable block ids
 * instead of that project's CoreMessage list. Upstream makes every member of a turn atomic; this
 * port narrows the scope to the one coupling that can actually break a request here, because a
 * whole-turn rule would disable thinking folds in every tool-using turn.
 *
 * Pure: no Pi imports, no I/O, no clock.
 */
import { type WireBlock, isDurableId } from "./block";

/**
 * The ids in each turn that must share a fold disposition.
 *
 * A "turn" here is the span from a `thinking` run through the assistant act it introduces, and
 * the answering tool_result of every call in that act. Only turns that contain BOTH thinking and a
 * tool call are returned: those are the strict-echo risk. A thinking run with no tool call, a call
 * with no reasoning, and orphan reasoning all carry no constraint and are omitted.
 *
 * Members are keyed by durable id; a turn whose members are not all durably identifiable is
 * returned intact and the caller simply never folds them (fail-open).
 */
export function computeStrictEchoGroups(blocks: WireBlock[]): string[][] {
	const resultIndexByCallId = new Map<string, number>();
	blocks.forEach((b, i) => {
		if (b.kind === "tool_result" && typeof b.callId === "string" && b.callId) {
			if (!resultIndexByCallId.has(b.callId)) resultIndexByCallId.set(b.callId, i);
		}
	});

	const groups: string[][] = [];
	const claimed = new Set<number>();

	for (let i = 0; i < blocks.length; i++) {
		if (blocks[i]!.kind !== "thinking" || claimed.has(i)) continue;

		// Walk the reasoning run, then the act that follows it.
		const runStart = i;
		let cursor = i;
		while (cursor < blocks.length && blocks[cursor]!.kind === "thinking") cursor++;
		const runEnd = cursor - 1;

		// The act: the maximal run of text/tool_call blocks right after the reasoning.
		const actStart = cursor;
		let actEnd = cursor - 1;
		while (cursor < blocks.length && (blocks[cursor]!.kind === "text" || blocks[cursor]!.kind === "tool_call")) {
			actEnd = cursor;
			cursor++;
		}
		if (actEnd < actStart) {
			i = runEnd; // orphan reasoning: nothing to couple with
			continue;
		}

		const act = blocks.slice(actStart, actEnd + 1);
		const hasCall = act.some((b) => b.kind === "tool_call");
		if (!hasCall) {
			// Reasoning that only produced prose: no signature-bearing act to contradict.
			i = runEnd;
			continue;
		}

		// Only SIGNED reasoning is bound to its text. An unsigned thinking block (DeepSeek-style
		// bare `reasoning_content`, or a provider that drops prior reasoning) can be replaced
		// freely: nothing in the request ties the old text to the surviving call.
		const run = blocks.slice(runStart, runEnd + 1);
		if (!run.some((b) => b.signed === true)) {
			i = runEnd;
			continue;
		}

		const ids: string[] = [];
		for (let k = runStart; k <= actEnd; k++) ids.push(blocks[k]!.id);
		for (const member of act) {
			if (member.kind !== "tool_call" || !member.callId) continue;
			const ridx = resultIndexByCallId.get(member.callId);
			if (ridx !== undefined) ids.push(blocks[ridx]!.id);
		}

		// A group with any positional (non-durable) member can never be folded as a unit; record it
		// anyway so the caller withdraws the whole thing rather than a fragment.
		const unique = [...new Set(ids)];
		for (let k = runStart; k <= actEnd; k++) claimed.add(k);
		groups.push(unique);
		i = actEnd;
	}

	return groups;
}

/**
 * Which of the proposed fold ids must stay verbatim, given the strict-echo coupling.
 *
 * A group is withdrawn whole when the fold would rewrite some of its members while leaving others
 * verbatim. A group that is entirely folded, or entirely kept, is a valid wire state.
 *
 * The caller's foldable set never includes `tool_call`, so in practice this means: reasoning in a
 * tool-using turn is not foldable. Everything else folds as before.
 *
 * @param foldedIds the ids the policy wants to mask
 * @returns the subset that must remain visible
 */
export function computeStrictEchoWithdrawals(blocks: WireBlock[], foldedIds: ReadonlySet<string>): Set<string> {
	const withdrawn = new Set<string>();
	if (foldedIds.size === 0) return withdrawn;
	for (const ids of computeStrictEchoGroups(blocks)) {
		let folded = 0;
		for (const id of ids) if (foldedIds.has(id)) folded++;
		if (folded === 0 || folded === ids.length) continue; // all-kept or all-folded
		for (const id of ids) if (foldedIds.has(id)) withdrawn.add(id);
	}
	return withdrawn;
}

/** How many strict-echo groups exist and how many are currently folded — for status reporting. */
export function strictEchoStats(
	blocks: WireBlock[],
	foldedIds: ReadonlySet<string>,
): { groups: number; foldedGroups: number } {
	let groups = 0;
	let foldedGroups = 0;
	for (const ids of computeStrictEchoGroups(blocks)) {
		groups++;
		let folded = 0;
		for (const id of ids) if (foldedIds.has(id)) folded++;
		if (folded > 0 && folded < ids.length) foldedGroups++;
	}
	return { groups, foldedGroups };
}

/** Re-export so callers import durability rules from one place alongside the grouping logic. */
export { isDurableId };
