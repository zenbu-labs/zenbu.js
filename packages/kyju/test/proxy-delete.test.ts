import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { nanoid } from "nanoid";
import zod from "zod";
import { createDb } from "../src/v2/db/db";
import { createReplica } from "../src/v2/replica/replica";
import { createClient } from "../src/v2/client/client";
import {
  createSchema,
  f,
  type InferSchema,
} from "../src/v2/db/schema";
import { VERSION } from "../src/v2/shared";
import { createRecordingProxy } from "../src/v2/client/proxy";

function tmpDbPath() {
  return path.join(os.tmpdir(), `kyju-proxy-delete-test-${nanoid()}`);
}

const recordSchema = createSchema({
  // `f.record(...)` is the same surface our consumers use when they
  // want a "Record<id, value>" — exactly the surface that failed in
  // practice when callers tried to `delete root.records[id]`.
  records: f
    .record(
      zod.string(),
      zod.object({
        id: zod.string(),
        token: zod.string(),
      }),
    )
    .default({
      a: { id: "a", token: "tok-a" },
      b: { id: "b", token: "tok-b" },
      c: { id: "c", token: "tok-c" },
    }),
  nested: f
    .object({
      inner: zod.record(zod.string(), zod.number()),
    })
    .default({ inner: { x: 1, y: 2, z: 3 } }),
});

type RecordSchema = InferSchema<typeof recordSchema>;

async function setup() {
  const dbPath = tmpDbPath();
  let db!: Awaited<ReturnType<typeof createDb>>;

  const replica = createReplica({
    send: (event) => db.postMessage(event),
    maxPageSizeBytes: 1024 * 1024,
  });

  db = await createDb({
    path: dbPath,
    schema: recordSchema,
    migrations: [],
    send: (event) => replica.postMessage(event),
  });

  await replica.postMessage({ kind: "connect", version: VERSION });

  const client = createClient<RecordSchema>(replica);

  return {
    db,
    replica,
    client,
    dbPath,
    cleanup: async () => {
      try {
        await db.flush();
      } catch {
        // best-effort
      }
      fs.rmSync(dbPath, { recursive: true, force: true });
    },
  };
}

let cleanup: () => Promise<void> | void;
afterEach(async () => {
  await cleanup?.();
});

describe("recording proxy — delete operator", () => {
  it("records a delete op when an entry is removed from a record", () => {
    const target = {
      records: {
        a: { id: "a", token: "tok-a" },
        b: { id: "b", token: "tok-b" },
      },
    };
    const { proxy, getOperations, snapshot } = createRecordingProxy(target);

    delete (proxy.records as Record<string, unknown>).b;

    // The local snapshot reflects the delete.
    expect(snapshot.records).toEqual({ a: { id: "a", token: "tok-a" } });

    // And the recorded operations carry it so the replica applies it.
    const ops = getOperations();
    expect(ops).toEqual([{ kind: "delete", path: ["records", "b"] }]);
  });

  it("update() with `delete root.records[id]` removes the entry from the DB", async () => {
    const ctx = await setup();
    cleanup = ctx.cleanup;

    expect(Object.keys(ctx.client.readRoot().records).sort()).toEqual([
      "a",
      "b",
      "c",
    ]);

    await ctx.client.update((root) => {
      delete (root.records as Record<string, unknown>).b;
    });

    expect(Object.keys(ctx.client.readRoot().records).sort()).toEqual([
      "a",
      "c",
    ]);
    expect(ctx.client.readRoot().records.b).toBeUndefined();
  });

  it("update() with delete on a nested record works", async () => {
    const ctx = await setup();
    cleanup = ctx.cleanup;

    await ctx.client.update((root) => {
      delete (root.nested.inner as Record<string, unknown>).y;
    });

    expect(ctx.client.readRoot().nested.inner).toEqual({ x: 1, z: 3 });
  });

  it("deleting then re-setting the same key works in a single update", async () => {
    const ctx = await setup();
    cleanup = ctx.cleanup;

    await ctx.client.update((root) => {
      const r = root.records as Record<
        string,
        { id: string; token: string }
      >;
      delete r.b;
      r.b = { id: "b", token: "tok-b-reborn" };
    });

    expect(ctx.client.readRoot().records.b).toEqual({
      id: "b",
      token: "tok-b-reborn",
    });
  });

  it("deleting a non-existent key is a no-op (no op recorded, no error)", () => {
    const target = { records: { a: 1 } };
    const { proxy, getOperations } = createRecordingProxy(target);

    delete (proxy.records as Record<string, unknown>).does_not_exist;

    expect(getOperations()).toEqual([])
  });
});
