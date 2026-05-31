/**
 * Contract tests for `Db.addSection` / `Db.removeSection`.
 *
 * The premise: enabling/disabling a plugin in zenbu must not require
 * rebuilding the kyju instance, because rebuilding kills all session
 * ids and forces every renderer to reconnect (which today silently
 * breaks any client-initiated request \u2014 blob fetches, mutations,
 * queries). `addSection` adds a new top-level namespace to an
 * already-running Db, runs any pending migrations for that section
 * through the normal write path so existing replicas receive the
 * updates as ordinary `db-update` broadcasts, and crucially keeps
 * existing sessions valid throughout.
 *
 * These tests are the contract. They run red against current main
 * (no `addSection` method exists) and gate the implementation.
 */

import { describe, it, expect, afterEach } from "vitest"
import os from "node:os"
import path from "node:path"
import fs from "node:fs"
import zod from "zod"
import { nanoid } from "nanoid"
import { createDb } from "../src/v2/db/db"
import { createReplica } from "../src/v2/replica/replica"
import { createClient } from "../src/v2/client/client"
import { createSchema, f, type SchemaShape } from "../src/v2/db/schema"
import type { KyjuMigration, SectionConfig } from "../src/v2/migrations"
import { VERSION } from "../src/v2/shared"

// --------------------------------------------------------------------
// helpers

function tmpDbPath(): string {
  return path.join(os.tmpdir(), `kyju-add-section-test-${nanoid()}`)
}

/**
 * Spin up a Db with the given starting sections and one connected
 * replica. Returns the db, the replica, a client backed by the
 * replica, and the sessionId the replica negotiated on connect so
 * tests can assert it doesn't change across addSection calls.
 */
async function openSectionedDb(args: {
  dbPath: string
  sections: SectionConfig[]
}): Promise<{
  db: Awaited<ReturnType<typeof createDb>>
  replica: ReturnType<typeof createReplica>
  client: ReturnType<typeof createClient<SchemaShape>>
  sessionId: string
}> {
  let db!: Awaited<ReturnType<typeof createDb>>

  const replica = createReplica({
    send: (event) => db.postMessage(event),
    maxPageSizeBytes: 1024 * 1024,
  })

  db = await createDb({
    path: args.dbPath,
    sections: args.sections,
    send: (event) => replica.postMessage(event),
  })

  const connectAck = (await replica.postMessage({
    kind: "connect",
    version: VERSION,
  })) as unknown as { sessionId?: string }
  // The current shape of the connect ack on the replica returns
  // void; the actual sessionId is captured inside the replica's
  // state. Read it back via the client's internals.
  const sessionId =
    (replica as unknown as { __testSessionId?: string }).__testSessionId ?? ""

  const client = createClient<SchemaShape>(replica)
  return { db, replica, client, sessionId }
}

const alphaSchema = createSchema({
  items: f
    .array(zod.object({ id: zod.string(), text: zod.string() }))
    .default([]),
  count: f.number().default(0),
})

const betaSchema = createSchema({
  config: f.object({ theme: zod.string() }).default({ theme: "dark" }),
})

const alphaSection: SectionConfig = {
  name: "alpha",
  schema: alphaSchema,
  migrations: [],
}

const betaSection: SectionConfig = {
  name: "beta",
  schema: betaSchema,
  migrations: [],
}

// One-migration variant used by the version-tracking tests.
const betaSectionV1: SectionConfig = {
  name: "beta",
  schema: betaSchema,
  migrations: [
    {
      version: 1,
      operations: [
        {
          op: "add",
          key: "extra",
          kind: "data",
          hasDefault: true,
          default: { populated: true },
        },
      ],
    } as KyjuMigration,
  ],
}

let cleanupPath: string | null = null
afterEach(() => {
  if (cleanupPath) {
    fs.rmSync(cleanupPath, { recursive: true, force: true })
    cleanupPath = null
  }
})

// --------------------------------------------------------------------
// addSection: brand-new section

describe("Db.addSection", () => {
  it("introduces a brand-new section visible to existing replicas", async () => {
    const dbPath = tmpDbPath()
    cleanupPath = dbPath
    const { db, client } = await openSectionedDb({
      dbPath,
      sections: [alphaSection],
    })

    // Sanity: before addSection, only `alpha` is in the root.
    {
      const root = client.readRoot() as Record<string, unknown>
      expect(root.alpha).toBeDefined()
      expect(root.beta).toBeUndefined()
    }

    // Add beta on a live db. Replicas should see it.
    await (db as unknown as {
      addSection: (s: SectionConfig) => Promise<void>
    }).addSection(betaSection)

    const root = client.readRoot() as Record<string, unknown>
    expect(root.beta).toBeDefined()
    expect((root.beta as Record<string, unknown>).config).toEqual({
      theme: "dark",
    })
  })

  it("is idempotent when called with the same section twice", async () => {
    const dbPath = tmpDbPath()
    cleanupPath = dbPath
    const { db, client } = await openSectionedDb({
      dbPath,
      sections: [alphaSection],
    })

    const addSection = (db as unknown as {
      addSection: (s: SectionConfig) => Promise<void>
    }).addSection.bind(db)

    await addSection(betaSection)
    // User-visible data:
    await client.update((r) => {
      ;(r as Record<string, { config: { theme: string } }>).beta.config.theme =
        "midnight"
    })
    await addSection(betaSection)

    // Second add must NOT clobber the user's write.
    const root = client.readRoot() as Record<string, unknown>
    expect((root.beta as { config: { theme: string } }).config.theme).toBe(
      "midnight",
    )
  })

  it("runs only pending migrations on add when section already at vN", async () => {
    const dbPath = tmpDbPath()
    cleanupPath = dbPath

    // First boot: section with one migration, runs to v1.
    {
      const { db, client } = await openSectionedDb({
        dbPath,
        sections: [betaSectionV1],
      })
      const root = client.readRoot() as Record<string, unknown>
      expect((root.beta as Record<string, unknown>).extra).toEqual({
        populated: true,
      })
      await db.close()
    }

    // Re-open without beta in the initial section list \u2014 simulating
    // "plugin was disabled at boot". The on-disk data persists.
    {
      const { db, client } = await openSectionedDb({
        dbPath,
        sections: [alphaSection],
      })

      const addSection = (db as unknown as {
        addSection: (s: SectionConfig) => Promise<void>
      }).addSection.bind(db)

      // Add beta back, same migrations as before. No work to do.
      await addSection(betaSectionV1)

      // Beta's data must be intact (not re-initialized).
      const root = client.readRoot() as Record<string, unknown>
      expect((root.beta as Record<string, unknown>).extra).toEqual({
        populated: true,
      })

      // _plugins.sectionMigrator.beta.version should still be 1.
      const pluginsState = root._plugins as
        | { sectionMigrator?: Record<string, { version?: number }> }
        | undefined
      expect(pluginsState?.sectionMigrator?.beta?.version).toBe(1)

      await db.close()
    }
  })

  it("preserves the replica's session across addSection", async () => {
    // The single most important behavioral property of this change:
    // the renderer's session id must not change. This is what was
    // broken in the close-and-recreate approach \u2014 every swap
    // invalidated the renderer's session and silently broke every
    // request-response call.
    const dbPath = tmpDbPath()
    cleanupPath = dbPath

    const { db, client, replica } = await openSectionedDb({
      dbPath,
      sections: [alphaSection],
    })

    // Trigger a request-response call to materialize the session
    // and verify it's working.
    await client.update((r) => {
      ;(r as Record<string, { count: number }>).alpha.count = 5
    })
    expect(
      (client.readRoot() as Record<string, { count: number }>).alpha.count,
    ).toBe(5)

    const addSection = (db as unknown as {
      addSection: (s: SectionConfig) => Promise<void>
    }).addSection.bind(db)

    await addSection(betaSection)

    // After the add, the same replica must still be able to write.
    // If addSection had killed sessions, this would throw
    // InvalidSessionError.
    await client.update((r) => {
      ;(r as Record<string, { count: number }>).alpha.count = 7
    })
    expect(
      (client.readRoot() as Record<string, { count: number }>).alpha.count,
    ).toBe(7)

    // And reads against the new section work too \u2014 same session.
    await client.update((r) => {
      ;(r as Record<string, { config: { theme: string } }>).beta.config.theme =
        "from-existing-session"
    })
    expect(
      (
        client.readRoot() as Record<
          string,
          { config: { theme: string } }
        >
      ).beta.config.theme,
    ).toBe("from-existing-session")
    void replica
  })

  it("rejects the reserved `_plugins` name", async () => {
    const dbPath = tmpDbPath()
    cleanupPath = dbPath
    const { db } = await openSectionedDb({
      dbPath,
      sections: [alphaSection],
    })

    const addSection = (db as unknown as {
      addSection: (s: SectionConfig) => Promise<void>
    }).addSection.bind(db)

    await expect(
      addSection({
        name: "_plugins",
        schema: betaSchema,
        migrations: [],
      }),
    ).rejects.toThrow(/_plugins|reserved/i)
  })

  it("rejects adding a section whose name collides with an existing one with a different migration shape", async () => {
    const dbPath = tmpDbPath()
    cleanupPath = dbPath

    const { db } = await openSectionedDb({
      dbPath,
      sections: [betaSection],
    })

    const addSection = (db as unknown as {
      addSection: (s: SectionConfig) => Promise<void>
    }).addSection.bind(db)

    // Same name "beta" but a migration list that differs from the
    // current one \u2014 ambiguous; reject.
    await expect(addSection(betaSectionV1)).rejects.toThrow(
      /already registered|different migrations/i,
    )
  })

  it("concurrent addSection of the same name resolves to a single install", async () => {
    const dbPath = tmpDbPath()
    cleanupPath = dbPath
    const { db, client } = await openSectionedDb({
      dbPath,
      sections: [alphaSection],
    })

    const addSection = (db as unknown as {
      addSection: (s: SectionConfig) => Promise<void>
    }).addSection.bind(db)

    await Promise.all([addSection(betaSection), addSection(betaSection)])

    const root = client.readRoot() as Record<string, unknown>
    expect((root.beta as Record<string, unknown>).config).toEqual({
      theme: "dark",
    })
  })
})

// --------------------------------------------------------------------
// removeSection

describe("Db.removeSection", () => {
  it("removes a section from the in-memory registry by default and preserves on-disk data", async () => {
    const dbPath = tmpDbPath()
    cleanupPath = dbPath
    const { db, client } = await openSectionedDb({
      dbPath,
      sections: [alphaSection, betaSection],
    })

    await client.update((r) => {
      ;(r as Record<string, { config: { theme: string } }>).beta.config.theme =
        "custom"
    })
    await db.flush()

    const removeSection = (db as unknown as {
      removeSection: (
        name: string,
        opts?: { deleteData?: boolean },
      ) => Promise<void>
    }).removeSection.bind(db)

    await removeSection("beta")

    // Re-add with same args: data + migration version preserved.
    const addSection = (db as unknown as {
      addSection: (s: SectionConfig) => Promise<void>
    }).addSection.bind(db)
    await addSection(betaSection)

    const root = client.readRoot() as Record<string, unknown>
    expect((root.beta as { config: { theme: string } }).config.theme).toBe(
      "custom",
    )
  })

  it("with deleteData: true wipes the section and rolls back migration version", async () => {
    const dbPath = tmpDbPath()
    cleanupPath = dbPath

    const { db, client } = await openSectionedDb({
      dbPath,
      sections: [betaSectionV1],
    })
    // beta is at v1, with `extra = { populated: true }`.

    const removeSection = (db as unknown as {
      removeSection: (
        name: string,
        opts?: { deleteData?: boolean },
      ) => Promise<void>
    }).removeSection.bind(db)
    const addSection = (db as unknown as {
      addSection: (s: SectionConfig) => Promise<void>
    }).addSection.bind(db)

    await removeSection("beta", { deleteData: true })
    await addSection(betaSectionV1)

    // Should be back at v1 again, but data must have been
    // re-initialized (not preserved from before).
    const root = client.readRoot() as Record<string, unknown>
    expect((root.beta as Record<string, unknown>).extra).toEqual({
      populated: true,
    })
    const pluginsState = root._plugins as
      | { sectionMigrator?: Record<string, { version?: number }> }
      | undefined
    expect(pluginsState?.sectionMigrator?.beta?.version).toBe(1)
  })

  it("removeSection of an unknown name is a no-op", async () => {
    const dbPath = tmpDbPath()
    cleanupPath = dbPath
    const { db } = await openSectionedDb({
      dbPath,
      sections: [alphaSection],
    })

    const removeSection = (db as unknown as {
      removeSection: (
        name: string,
        opts?: { deleteData?: boolean },
      ) => Promise<void>
    }).removeSection.bind(db)

    await expect(removeSection("never-existed")).resolves.toBeUndefined()
  })
})

// --------------------------------------------------------------------
// listSections (read-only introspection)

describe("Db.listSections", () => {
  it("reflects the current in-memory section registry", async () => {
    const dbPath = tmpDbPath()
    cleanupPath = dbPath
    const { db } = await openSectionedDb({
      dbPath,
      sections: [alphaSection],
    })

    const listSections = (db as unknown as {
      listSections: () => string[]
    }).listSections.bind(db)
    const addSection = (db as unknown as {
      addSection: (s: SectionConfig) => Promise<void>
    }).addSection.bind(db)
    const removeSection = (db as unknown as {
      removeSection: (name: string) => Promise<void>
    }).removeSection.bind(db)

    expect(listSections().sort()).toEqual(["alpha"])
    await addSection(betaSection)
    expect(listSections().sort()).toEqual(["alpha", "beta"])
    await removeSection("alpha")
    expect(listSections().sort()).toEqual(["beta"])
  })
})
