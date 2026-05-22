/**
 * Behavioral spec for `setAtPath` after the iterative rewrite.
 *
 * Three properties this file pins down:
 *
 *   1. Numeric path segments create arrays, string segments create
 *      objects. Subtle in the rewrite because the index/key decision
 *      drives intermediate container creation.
 *   2. The replica variant clones every container along the path
 *      (so React's `useDb` selectors see fresh references at each
 *      level) while leaving untouched siblings === to their
 *      originals. The db variant mutates in place. These contracts
 *      are why we have two separate copies of the function.
 *   3. Long paths do not overflow. Both variants used to recurse
 *      one frame per segment and blew up around ~14k. The bug
 *      showed up in production through a recording-proxy op with
 *      a pathological path.
 */
import { describe, it, expect } from "vitest";
import { setAtPath as dbSetAtPath } from "../src/v2/db/helpers";
import { setAtPath as replicaSetAtPath } from "../src/v2/replica/helpers";

describe("setAtPath", () => {
  it("creates arrays for numeric segments and objects for string segments", () => {
    // Mixed path: object → array → object.
    const out = dbSetAtPath({
      root: {} as any,
      path: ["users", "0", "name"],
      value: "alice" as any,
    });
    expect(out).toEqual({ users: [{ name: "alice" }] });
    expect(Array.isArray((out as any).users)).toBe(true);
  });

  it("db variant mutates in place and returns the same top-level reference", () => {
    const root = { a: { b: 0 } } as any;
    const next = dbSetAtPath({ root, path: ["a", "b"], value: 1 as any });
    expect(next).toBe(root);
    expect(root.a.b).toBe(1);
  });

  it("replica variant gives fresh refs along the path and shares untouched siblings", () => {
    const root = {
      a: { x: 1, y: 2 },
      b: { keep: { me: true } },
    } as any;
    const next = replicaSetAtPath({
      root,
      path: ["a", "y"],
      value: 99 as any,
    }) as any;

    expect(next).toEqual({ a: { x: 1, y: 99 }, b: { keep: { me: true } } });
    // Untouched subtree must be shared so React skips re-rendering it.
    expect(next.b).toBe(root.b);
    // Path must be freshly cloned at every level so selectors at any
    // depth observe a new reference.
    expect(next).not.toBe(root);
    expect(next.a).not.toBe(root.a);
  });

  it("handles pathological path depths without overflowing the stack", () => {
    // Pre-fix: both variants recursed once per segment and threw
    // RangeError around ~14k. We test 20k as a margin above that.
    const path = Array.from({ length: 20_000 }, (_, i) => `k${i}`);

    const dbOut = dbSetAtPath({ root: {} as any, path, value: 42 as any });
    const replicaOut = replicaSetAtPath({
      root: {} as any,
      path,
      value: 42 as any,
    });

    // Walk both results down to the leaf to confirm correctness, not
    // just absence of throw.
    let cur: any = dbOut;
    for (const seg of path) cur = cur[seg];
    expect(cur).toBe(42);

    cur = replicaOut;
    for (const seg of path) cur = cur[seg];
    expect(cur).toBe(42);
  });
});
