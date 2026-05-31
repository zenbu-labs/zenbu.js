import type { DbPlugin } from "../db/handlers/plugins";
import type { KyjuMigration, MigrationOp, SectionConfig } from "../migrations";
import { applyOperations } from "../migrations";

export const migrationPlugin = (migrations: KyjuMigration[]): DbPlugin => ({
  name: "kyjuMigrator",
  onBeforeStart: async ({ client, pluginPath }) => {
    const targetVersion = migrations.length;

    const root = (client.readRoot() as Record<string, any>) ?? {};
    const pluginState = root?._plugins?.kyjuMigrator ?? {};
    const currentVersion: number =
      typeof pluginState === "object" && pluginState !== null
        ? (pluginState as Record<string, any>).version ?? 0
        : 0;

    if (currentVersion >= targetVersion) return;

    for (let v = currentVersion; v < targetVersion; v++) {
      const migration = migrations[v]!;
      const ops: MigrationOp[] = migration.operations ?? [];

      const removeOps = ops.filter(
        (o) =>
          o.op === "remove" && (o.kind === "collection" || o.kind === "blob"),
      );
      for (const op of removeOps) {
        await (client as any)[op.key]?.delete?.();
      }

      const currentRoot = client.readRoot() as Record<string, any>;

      const apply = (data: Record<string, any>) => applyOperations(data, ops);

      let newRoot: Record<string, any>;
      if (migration.migrate) {
        newRoot = migration.migrate(currentRoot, { apply });
      } else {
        newRoot = apply(currentRoot);
      }

      await client.update(() => newRoot as any);

      const addCollectionOps = ops.filter(
        (o): o is Extract<MigrationOp, { op: "add"; kind: "collection" }> =>
          o.op === "add" && o.kind === "collection",
      );
      for (const op of addCollectionOps) {
        await (client as any)[op.key]?.create?.();
      }

      const addBlobOps = ops.filter(
        (o): o is Extract<MigrationOp, { op: "add"; kind: "blob" }> =>
          o.op === "add" && o.kind === "blob",
      );
      for (const op of addBlobOps) {
        await (client as any)[op.key]?.create?.(new Uint8Array(0));
      }

      if (migration.afterMigrate) {
        await migration.afterMigrate({ client });
      }

      await client.update((r: any) => {
        let target = r;
        for (const segment of pluginPath) {
          if (!target[segment]) target[segment] = {};
          target = target[segment];
        }
        target.version = v + 1;
      });
    }
  },
});


export const runSectionMigrations = async (args: {
  section: SectionConfig;
  client: any;

  pluginPath: string[];
}): Promise<void> => {
  const { section, client, pluginPath } = args;
  const { name, migrations } = section;
  const targetVersion = migrations.length;

  const root = (client.readRoot() as Record<string, any>) ?? {};
  const pluginState = root?._plugins?.sectionMigrator?.[name] ?? {};
  const currentVersion: number =
    typeof pluginState === "object" && pluginState !== null
      ? (pluginState as Record<string, any>).version ?? 0
      : 0;

  if (currentVersion >= targetVersion) return;

  for (let v = currentVersion; v < targetVersion; v++) {
    const migration = migrations[v]!;
    const ops: MigrationOp[] = migration.operations ?? [];

    const removeOps = ops.filter(
      (o) =>
        o.op === "remove" && (o.kind === "collection" || o.kind === "blob"),
    );
    for (const op of removeOps) {
      await (client as any)[name]?.[op.key]?.delete?.();
    }

    const currentRoot = client.readRoot() as Record<string, any>;
    const sectionData = currentRoot?.[name] ?? {};

    const apply = (data: Record<string, any>) => applyOperations(data, ops);

    let newSectionData: Record<string, any>;
    if (migration.migrate) {
      newSectionData = migration.migrate(sectionData, { apply });
    } else {
      newSectionData = apply(sectionData);
    }

    await client.update((r: any) => {
      r[name] = newSectionData;
    });

    const addCollectionOps = ops.filter(
      (o): o is Extract<MigrationOp, { op: "add"; kind: "collection" }> =>
        o.op === "add" && o.kind === "collection",
    );
    for (const op of addCollectionOps) {
      await (client as any)[name]?.[op.key]?.create?.();
    }

    const addBlobOps = ops.filter(
      (o): o is Extract<MigrationOp, { op: "add"; kind: "blob" }> =>
        o.op === "add" && o.kind === "blob",
    );
    for (const op of addBlobOps) {
      await (client as any)[name]?.[op.key]?.create?.(new Uint8Array(0));
    }

    if (migration.afterMigrate) {
      const sectionClient = (client as any)[name];
      await migration.afterMigrate({ client: sectionClient });
    }

    await client.update((r: any) => {
      let target = r;
      for (const segment of [...pluginPath, name]) {
        if (!target[segment]) target[segment] = {};
        target = target[segment];
      }
      target.version = v + 1;
    });
  }
};

export const sectionMigrationPlugin = (
  sections: SectionConfig[],
): DbPlugin => ({
  name: "sectionMigrator",
  onBeforeStart: async ({ client, pluginPath }) => {
    for (const section of sections) {
      await runSectionMigrations({ section, client, pluginPath });
    }
  },
});
