import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { nanoid } from "nanoid";
import { generate, readJournal, getLastSnapshot } from "../../src/cli/generator";
import type { SchemaSnapshot } from "../../src/cli/serializer";
import type { MigrationOp } from "../../src/v2/migrations";

function tmpDir() {
  const p = path.join(os.tmpdir(), `kyju-amend-test-${nanoid()}`);
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

function makeSnapshot(
  fields: SchemaSnapshot["fields"],
  id = "snap-1",
  prevId = "",
): SchemaSnapshot {
  return { id, prevId, fields };
}

describe("generate --amend", () => {
  it("replaces last migration and snapshot instead of creating new ones", () => {
    const out = tmpDir();
    cleanups.push(out);

    const snap1 = makeSnapshot({
      title: { kind: "data", hasDefault: true, default: "", typeHash: "abc" },
    });
    generate({
      outPath: out,
      snapshot: snap1,
      ops: [{ op: "add", key: "title", kind: "data", hasDefault: true, default: "" }],
      name: "initial",
    });

    const snap2 = makeSnapshot({
      title: { kind: "data", hasDefault: true, default: "", typeHash: "abc" },
      mode: { kind: "data", hasDefault: true, default: "", typeHash: "def" },
    });
    generate({
      outPath: out,
      snapshot: snap2,
      ops: [{ op: "add", key: "mode", kind: "data", hasDefault: true, default: "" }],
      name: "add_mode",
    });

    expect(readJournal(out).entries).toHaveLength(2);

    const snap3 = makeSnapshot({
      title: { kind: "data", hasDefault: true, default: "", typeHash: "abc" },
      mode: { kind: "data", hasDefault: true, default: "fundamental-mode", typeHash: "def" },
    });
    const result = generate({
      outPath: out,
      snapshot: snap3,
      ops: [{ op: "add", key: "mode", kind: "data", hasDefault: true, default: "fundamental-mode" }],
      name: "add_mode",
      amend: true,
    });

    const journal = readJournal(out);
    expect(journal.entries).toHaveLength(2);
    expect(journal.entries[1]!.idx).toBe(1);
    expect(journal.entries[1]!.tag).toBe("add_mode");

    const lastSnap = getLastSnapshot(out, journal)!;
    expect((lastSnap.fields.mode as any).default).toBe("fundamental-mode");

    const migContent = fs.readFileSync(result.migrationPath, "utf-8");
    expect(migContent).toContain("fundamental-mode");
    expect(migContent).toContain("version: 2");

    // Amending must not leave a stale second migration on disk.
    const tsFiles = fs.readdirSync(out).filter((f) => f.endsWith(".ts"));
    expect(tsFiles).toHaveLength(2);
    const lastEntry = journal.entries[1]!;
    expect(lastEntry.file).toBeDefined();
    expect(fs.existsSync(path.join(out, `${lastEntry.file}.ts`))).toBe(true);
  });

  it("amend with only one migration replaces it", () => {
    const out = tmpDir();
    cleanups.push(out);

    const snap1 = makeSnapshot({
      mode: { kind: "data", hasDefault: true, default: "", typeHash: "abc" },
    });
    generate({
      outPath: out,
      snapshot: snap1,
      ops: [{ op: "add", key: "mode", kind: "data", hasDefault: true, default: "" }],
      name: "initial",
    });

    const snap2 = makeSnapshot({
      mode: { kind: "data", hasDefault: true, default: "fundamental-mode", typeHash: "abc" },
    });
    generate({
      outPath: out,
      snapshot: snap2,
      ops: [{ op: "add", key: "mode", kind: "data", hasDefault: true, default: "fundamental-mode" }],
      name: "initial",
      amend: true,
    });

    const journal = readJournal(out);
    expect(journal.entries).toHaveLength(1);
    expect(journal.entries[0]!.idx).toBe(0);

    const lastSnap = getLastSnapshot(out, journal)!;
    expect((lastSnap.fields.mode as any).default).toBe("fundamental-mode");
  });

  it("amend with no existing migrations throws", () => {
    const out = tmpDir();
    cleanups.push(out);

    const snap = makeSnapshot({});
    expect(() =>
      generate({ outPath: out, snapshot: snap, ops: [], amend: true }),
    ).toThrow();
  });

  it("amend preserves name from previous entry when no name given", () => {
    const out = tmpDir();
    cleanups.push(out);

    generate({
      outPath: out,
      snapshot: makeSnapshot({ x: { kind: "data", hasDefault: true, default: 0, typeHash: "a" } }),
      ops: [{ op: "add", key: "x", kind: "data", hasDefault: true, default: 0 }],
      name: "my_feature",
    });

    generate({
      outPath: out,
      snapshot: makeSnapshot({ x: { kind: "data", hasDefault: true, default: 1, typeHash: "a" } }),
      ops: [{ op: "add", key: "x", kind: "data", hasDefault: true, default: 1 }],
      amend: true,
    });

    const journal = readJournal(out);
    expect(journal.entries[0]!.tag).toBe("my_feature");
    const entry = journal.entries[0]!;
    expect(entry.file).toBe(`my_feature_${entry.when}`);
    expect(fs.existsSync(path.join(out, `${entry.file}.ts`))).toBe(true);
  });

  it("amend cleans up old migration file when name changes", () => {
    const out = tmpDir();
    cleanups.push(out);

    generate({
      outPath: out,
      snapshot: makeSnapshot({}),
      ops: [],
      name: "old_name",
    });

    const initialJournal = readJournal(out);
    const oldEntry = initialJournal.entries[0]!;
    expect(oldEntry.file).toBe(`old_name_${oldEntry.when}`);
    expect(fs.existsSync(path.join(out, `${oldEntry.file}.ts`))).toBe(true);

    generate({
      outPath: out,
      snapshot: makeSnapshot({}),
      ops: [],
      name: "new_name",
      amend: true,
    });

    const newJournal = readJournal(out);
    const newEntry = newJournal.entries[0]!;
    expect(newEntry.tag).toBe("new_name");
    expect(newEntry.file).toBe(`new_name_${newEntry.when}`);
    expect(fs.existsSync(path.join(out, `${oldEntry.file}.ts`))).toBe(false);
    expect(fs.existsSync(path.join(out, `${newEntry.file}.ts`))).toBe(true);
  });
});
