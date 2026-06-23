import fs from "node:fs";
import path from "node:path";
import type { MigrationOp } from "../v2/migrations";
import type { SchemaSnapshot } from "./serializer";

export type JournalEntry = {
  idx: number;
  tag: string;
  when: number;
  /**
   * Basename (no extension) of the on-disk migration file. Newly generated
   * migrations always populate this. When absent (legacy entries written
   * before this field existed), the loader falls back to the historical
   * `{pad(idx)}_{tag}` naming so existing migration directories keep
   * loading without rewrites.
   *
   * Why this exists: the old `{pad(idx)}_{tag}` convention guaranteed a
   * merge conflict whenever two branches each generated a migration off
   * the same head — both picked the same `idx`, both wrote the same
   * filename. The new convention embeds `when` (a near-unique timestamp)
   * so parallel branches produce distinct files. The journal still owns
   * ordering via `idx`; only `idx` need be reconciled at merge time.
   */
  file?: string;
};

export type Journal = {
  version: string;
  entries: JournalEntry[];
};

/**
 * Resolve the on-disk basename for a journal entry. Prefers the explicit
 * `file` field for new entries, falls back to the legacy numeric naming
 * for entries written before `file` was tracked.
 */
export function entryBaseName(entry: JournalEntry): string {
  return entry.file ?? `${pad(entry.idx)}_${entry.tag}`;
}

/**
 * Resolve the on-disk basename for an entry's snapshot file (without the
 * `_snapshot.json` suffix or `meta/` prefix). Mirrors `entryBaseName` for
 * new entries; falls back to the legacy `{pad(idx)}` snapshot naming for
 * legacy entries (snapshots historically did NOT include the tag).
 */
export function entrySnapshotBaseName(entry: JournalEntry): string {
  return entry.file ?? pad(entry.idx);
}

const INLINE_MIGRATION_TYPES = `type MigrationOp =
  | { op: "add"; key: string; kind: "data"; hasDefault: boolean; default?: any }
  | { op: "add"; key: string; kind: "collection"; debugName?: string }
  | { op: "add"; key: string; kind: "blob"; debugName?: string }
  | { op: "remove"; key: string; kind: "collection" | "blob" | "data" }
  | { op: "alter"; key: string; changes: Record<string, any> };

type KyjuMigration = {
  version: number;
  operations?: MigrationOp[];
  migrate?: (prev: any, ctx: { apply: (data: any) => any }) => any;
};`;

function pad(n: number, width = 4): string {
  return String(n).padStart(width, "0");
}

function sanitizeTag(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_|_$/g, "");
}

export function readJournal(outPath: string): Journal {
  const journalPath = path.join(outPath, "meta", "_journal.json");
  if (!fs.existsSync(journalPath)) {
    return { version: "1", entries: [] };
  }
  return JSON.parse(fs.readFileSync(journalPath, "utf-8"));
}

function readSnapshotForEntry(outPath: string, entry: JournalEntry): SchemaSnapshot | null {
  const primary = path.join(outPath, "meta", `${entrySnapshotBaseName(entry)}_snapshot.json`);
  if (fs.existsSync(primary)) {
    return JSON.parse(fs.readFileSync(primary, "utf-8"));
  }
  // Legacy fallback: an entry written with the new `file` field but
  // sitting next to a snapshot that was generated under the old naming
  // scheme. Should be rare, but cheap to support.
  if (entry.file) {
    const legacy = path.join(outPath, "meta", `${pad(entry.idx)}_snapshot.json`);
    if (fs.existsSync(legacy)) {
      return JSON.parse(fs.readFileSync(legacy, "utf-8"));
    }
  }
  return null;
}

export function getLastSnapshot(outPath: string, journal: Journal): SchemaSnapshot | null {
  if (journal.entries.length === 0) return null;
  const lastEntry = journal.entries[journal.entries.length - 1]!;
  return readSnapshotForEntry(outPath, lastEntry);
}

export function getSnapshotAtIndex(outPath: string, journal: Journal, index: number): SchemaSnapshot | null {
  const entry = journal.entries[index];
  if (!entry) return null;
  return readSnapshotForEntry(outPath, entry);
}

function typesPreamble(alias?: string): string {
  if (alias) {
    return `import type { KyjuMigration } from "${alias}"`;
  }
  return INLINE_MIGRATION_TYPES;
}

function generateDeclarativeMigration(idx: number, ops: MigrationOp[], alias?: string): string {
  const opsJson = JSON.stringify(ops, null, 2)
    .split("\n")
    .map((line, i) => (i === 0 ? line : "  " + line))
    .join("\n");

  return `${typesPreamble(alias)}

const migration: KyjuMigration = {
  version: ${idx + 1},
  operations: ${opsJson},
}

export default migration
`;
}

function generateCustomMigration(idx: number, ops: MigrationOp[], alias?: string): string {
  const opsJson = JSON.stringify(ops, null, 2)
    .split("\n")
    .map((line, i) => (i === 0 ? line : "  " + line))
    .join("\n");

  return `${typesPreamble(alias)}

const migration: KyjuMigration = {
  version: ${idx + 1},
  operations: ${opsJson},
  migrate(prev, { apply }) {
    const result = apply(prev)
    throw new Error(
      "Migration requires a custom transform. Replace this stub before running the application.",
    )
    return result
  },
}

export default migration
`;
}

export type GenerateOptions = {
  outPath: string;
  snapshot: SchemaSnapshot;
  ops: MigrationOp[];
  name?: string;
  custom?: boolean;
  amend?: boolean;
  alias?: string;
};

export function generate(opts: GenerateOptions): {
  migrationPath: string;
  snapshotPath: string;
} {
  const { outPath, snapshot, ops, name, custom, amend, alias } = opts;

  fs.mkdirSync(path.join(outPath, "meta"), { recursive: true });

  const journal = readJournal(outPath);

  let idx: number;
  let tag: string;
  let when: number;

  if (amend) {
    if (journal.entries.length === 0) {
      throw new Error("No migration to amend");
    }
    const lastEntry = journal.entries[journal.entries.length - 1]!;
    idx = lastEntry.idx;
    tag = sanitizeTag(name || lastEntry.tag);
    when = Date.now();

    // Delete the previous on-disk artifacts. Use the journal's recorded
    // basename when present (new entries); fall back to the legacy naming
    // for entries created before `file` was tracked.
    const oldMigBase = entryBaseName(lastEntry);
    const oldSnapBase = entrySnapshotBaseName(lastEntry);
    const oldMigration = path.join(outPath, `${oldMigBase}.ts`);
    const oldSnapshot = path.join(outPath, "meta", `${oldSnapBase}_snapshot.json`);
    if (fs.existsSync(oldMigration)) fs.unlinkSync(oldMigration);
    if (fs.existsSync(oldSnapshot)) fs.unlinkSync(oldSnapshot);
  } else {
    idx = journal.entries.length;
    tag = sanitizeTag(name || `migration`);
    when = Date.now();
  }

  // Filename is `{tag}_{when}`. Two branches diverging off the same head
  // produce different `when` values, so the files don't collide and the
  // only merge surface is the journal itself (which is small and easy to
  // reconcile by renumbering `idx`).
  const file = `${tag}_${when}`;
  const entry: JournalEntry = { idx, tag, when, file };

  if (amend) {
    journal.entries[journal.entries.length - 1] = entry;
  } else {
    journal.entries.push(entry);
  }

  const snapshotPath = path.join(outPath, "meta", `${file}_snapshot.json`);
  fs.writeFileSync(snapshotPath, JSON.stringify(snapshot, null, 2) + "\n");

  const hasAlterOps = ops.some((o) => o.op === "alter");
  const useCustom = custom || hasAlterOps;

  const migrationCode = useCustom
    ? generateCustomMigration(idx, ops, alias)
    : generateDeclarativeMigration(idx, ops, alias);

  const migrationPath = path.join(outPath, `${file}.ts`);
  fs.writeFileSync(migrationPath, migrationCode);

  const journalPath = path.join(outPath, "meta", "_journal.json");
  fs.writeFileSync(journalPath, JSON.stringify(journal, null, 2) + "\n");

  return { migrationPath, snapshotPath };
}
