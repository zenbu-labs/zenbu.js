import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { nanoid } from "nanoid";
import { generate } from "../../src/cli/generator";
import { loadMigrationsFromDir } from "../../src/cli/loader";

function tmpDir() {
  const p = path.join(os.tmpdir(), `kyju-loader-test-${nanoid()}`);
  fs.mkdirSync(p, { recursive: true });
  return p;
}

let cleanups: string[] = [];
afterEach(() => {
  for (const p of cleanups) {
    fs.rmSync(p, { recursive: true, force: true });
  }
  cleanups = [];
});

describe("loadMigrationsFromDir", () => {
  it("loads migrations written under the new (merge-safe) naming", async () => {
    const out = tmpDir();
    cleanups.push(out);

    generate({
      outPath: out,
      snapshot: { id: "a", prevId: "", fields: {} },
      ops: [],
      name: "first",
    });
    generate({
      outPath: out,
      snapshot: { id: "b", prevId: "a", fields: {} },
      ops: [],
      name: "second",
    });

    const migrations = await loadMigrationsFromDir(out);
    expect(migrations).toHaveLength(2);
    expect(migrations[0]!.version).toBe(1);
    expect(migrations[1]!.version).toBe(2);
  });

  it("loads migrations written under the legacy `{pad(idx)}_{tag}` naming", async () => {
    const out = tmpDir();
    cleanups.push(out);

    // Simulate a directory produced by an older generator. No `file`
    // field on entries; filenames carry the numeric `idx` prefix.
    fs.mkdirSync(path.join(out, "meta"), { recursive: true });
    fs.writeFileSync(
      path.join(out, "0000_legacy_init.ts"),
      "export default { version: 1, operations: [] }\n",
    );
    fs.writeFileSync(
      path.join(out, "0001_legacy_next.ts"),
      "export default { version: 2, operations: [] }\n",
    );
    fs.writeFileSync(
      path.join(out, "meta", "_journal.json"),
      JSON.stringify(
        {
          version: "1",
          entries: [
            { idx: 0, tag: "legacy_init", when: 1 },
            { idx: 1, tag: "legacy_next", when: 2 },
          ],
        },
        null,
        2,
      ),
    );

    const migrations = await loadMigrationsFromDir(out);
    expect(migrations).toHaveLength(2);
    expect(migrations.map((m) => m.version)).toEqual([1, 2]);
  });

  it("two parallel branches off the same head produce non-colliding filenames", async () => {
    // The whole reason we did this: simulate the conflict that used to be
    // unavoidable. Dev A and Dev B both branch off `out` with one
    // existing migration and each generates a new migration locally. The
    // resulting filenames must differ so a textual git merge has nothing
    // to fight over.
    const base = tmpDir();
    cleanups.push(base);
    generate({
      outPath: base,
      snapshot: { id: "head", prevId: "", fields: {} },
      ops: [],
      name: "head",
    });

    const branchA = tmpDir();
    const branchB = tmpDir();
    cleanups.push(branchA, branchB);
    fs.cpSync(base, branchA, { recursive: true });
    fs.cpSync(base, branchB, { recursive: true });

    // Force distinct `when` values across branches. In practice two devs
    // generating at the same wall-clock millisecond is vanishingly rare;
    // we just don't want this test to flake on fast machines.
    await new Promise((r) => setTimeout(r, 2));
    generate({
      outPath: branchA,
      snapshot: { id: "a", prevId: "head", fields: {} },
      ops: [],
      name: "feature_a",
    });
    await new Promise((r) => setTimeout(r, 2));
    generate({
      outPath: branchB,
      snapshot: { id: "b", prevId: "head", fields: {} },
      ops: [],
      name: "feature_b",
    });

    const aFiles = fs
      .readdirSync(branchA)
      .filter((f) => f.endsWith(".ts"))
      .sort();
    const bFiles = fs
      .readdirSync(branchB)
      .filter((f) => f.endsWith(".ts"))
      .sort();

    // The shared `head_*` file is identical on both branches. The new
    // files differ in name, so there's no textual collision.
    const aNew = aFiles.find((f) => !f.startsWith("head_"))!;
    const bNew = bFiles.find((f) => !f.startsWith("head_"))!;
    expect(aNew).toBeDefined();
    expect(bNew).toBeDefined();
    expect(aNew).not.toBe(bNew);
    expect(aNew.startsWith("feature_a_")).toBe(true);
    expect(bNew.startsWith("feature_b_")).toBe(true);
  });
});
