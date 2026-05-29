type MigrationOp =
  | { op: "add"; key: string; kind: "data"; hasDefault: boolean; default?: any }
  | { op: "add"; key: string; kind: "collection"; debugName?: string }
  | { op: "add"; key: string; kind: "blob"; debugName?: string }
  | { op: "remove"; key: string; kind: "collection" | "blob" | "data" }
  | { op: "alter"; key: string; changes: Record<string, any> };

type KyjuMigration = {
  version: number;
  operations?: MigrationOp[];
  migrate?: (prev: any, ctx: { apply: (data: any) => any }) => any;
};

const migration: KyjuMigration = {
  version: 8,
  operations: [
    {
      "op": "alter",
      "key": "focus",
      "changes": {
        "typeHash": {
          "from": "009e035028c96a15",
          "to": "5e239aa0398a7422"
        },
        "default": {
          "from": {
            "iframes": [],
            "contexts": []
          },
          "to": {
            "contexts": []
          }
        }
      }
    }
  ],
  migrate(prev, { apply }) {
    const result = apply(prev)
    // Drop the legacy `focus.iframes` array — iframes are gone, the
    // chain is meaningless in one-DOM mode. `focus.contexts` is
    // preserved as-is.
    if (result?.focus && "iframes" in result.focus) {
      delete result.focus.iframes
    }
    return result
  },
}

export default migration
