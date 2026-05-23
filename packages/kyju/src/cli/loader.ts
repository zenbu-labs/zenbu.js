import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { KyjuMigration } from "../v2/migrations";
import { entryBaseName, type Journal } from "./generator";

function readJournalFromDir(dir: string): Journal {
  const journalPath = path.join(dir, "meta", "_journal.json");
  if (!fs.existsSync(journalPath)) {
    return { version: "1", entries: [] };
  }
  return JSON.parse(fs.readFileSync(journalPath, "utf-8"));
}

/**
 * Load migrations from a kyju output directory by reading the journal
 * and dynamically importing each migration file in order.
 */
export async function loadMigrationsFromDir(dir: string): Promise<KyjuMigration[]> {
  const absDir = path.resolve(dir);
  const journal = readJournalFromDir(absDir);

  if (journal.entries.length === 0) return [];

  const migrations: KyjuMigration[] = [];

  for (const entry of journal.entries) {
    // `entryBaseName` returns the journal-recorded basename for new entries
    // and falls back to the legacy `{pad(idx)}_{tag}` naming for entries
    // written before `file` was tracked. That keeps every migration dir on
    // disk loading correctly without a rewrite step.
    const base = entryBaseName(entry);
    const candidates = [".ts", ".js", ".mjs"];
    let filePath: string | null = null;
    for (const ext of candidates) {
      const candidate = path.join(absDir, base + ext);
      if (fs.existsSync(candidate)) {
        filePath = candidate;
        break;
      }
    }
    if (!filePath) {
      throw new Error(
        `Migration file not found for entry ${entry.idx} (${entry.tag}) in ${absDir}`,
      );
    }

    const mod = await import(pathToFileURL(filePath).href);
    const migration: KyjuMigration = mod.default ?? mod;
    migrations.push(migration);
  }

  return migrations;
}
