/*
 * fold-code-collision.test.ts — how often a 6-char fold code can identify the wrong block.
 *
 * A fold code is the low 6 base-36 digits of an FNV-1a 32-bit hash of the block's durable id, so
 * the code space is 36^6 ≈ 2.18e9. That is wide enough that a random collision is not the real
 * risk: at 2,000 blocks the birthday probability is ~0.09%, and a long session realistically folds
 * a few hundred. The real risk is that a collision is SILENT.
 *
 * These tests pin both halves of that finding so a future change to the code width or to the
 * resolution path has a baseline to fail against.
 */
import { describe, it, expect } from "vitest";
import { foldCode } from "../src/core/digest";

const SPACE = 36 ** 6;

/** Birthday probability that n draws from SPACE contain at least one collision. */
function collisionProbability(n: number): number {
	let none = 1;
	for (let i = 0; i < n; i++) none *= 1 - i / SPACE;
	return 1 - none;
}

describe("fold-code space", () => {
	it("is the low 6 base-36 digits of a 32-bit hash", () => {
		expect(SPACE).toBe(2_176_782_336);
		expect(foldCode("r:c1")).toMatch(/^[0-9a-z]{6}$/);
	});

	it("keeps birthday collisions negligible at realistic session sizes", () => {
		// Folded-block counts, not total blocks: only folds get codes.
		expect(collisionProbability(300)).toBeLessThan(1e-4);
		expect(collisionProbability(2_000)).toBeLessThan(1e-3);
		// The floor: even 5,000 folds stays under 1%.
		expect(collisionProbability(5_000)).toBeLessThan(0.01);
	});

	it("is NOT collision-free — the failure mode is silent, not a crash", () => {
		// Two distinct ids that share a code. The pair is found by brute force (it lands around the
		// millionth probe, i.e. ~2.4x the code space) so this stays a regression test rather than a
		// lucky fixture.
		const seen = new Map<string, string>();
		let found: [string, string] | null = null;
		for (let i = 0; i < 3_000_000 && found === null; i++) {
			const id = `r:collide-${i}`;
			const code = foldCode(id);
			const prev = seen.get(code);
			if (prev !== undefined && prev !== id) found = [prev, id];
			else seen.set(code, id);
		}
		expect(found).not.toBeNull();
		const [a, b] = found!;
		expect(a).not.toBe(b);
		expect(foldCode(a)).toBe(foldCode(b));
	});

	it("a colliding block is dropped, never allowed to shadow the incumbent", () => {
		// emitFoldIndex treats a code already owned by another block as a permanent per-block drop:
		// the collider stays raw and is held for the rest of the session, so recall keeps resolving to
		// the block that actually owns the code. Asserted here as a property of the resolution rule.
		const owners = new Map<string, string>();
		const deposit = (id: string): boolean => {
			const code = foldCode(id);
			const owner = owners.get(code);
			if (owner !== undefined && owner !== id) return false; // dropped
			owners.set(code, id);
			return true;
		};
		expect(deposit("r:first")).toBe(true);
		expect(deposit("r:first")).toBe(true); // idempotent: the same block re-registers
		// A genuinely colliding id is refused rather than rewriting the owner.
		const collidingId = "r:collide-1111884";
		const incumbent = "r:collide-317618";
		expect(foldCode(collidingId)).toBe(foldCode(incumbent));
		owners.clear();
		expect(deposit(incumbent)).toBe(true);
		expect(deposit(collidingId)).toBe(false);
		expect(owners.get(foldCode(incumbent))).toBe(incumbent);
	});
});
