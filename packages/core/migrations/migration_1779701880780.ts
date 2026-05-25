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
  version: 4,
  operations: [
    {
      "op": "add",
      "key": "lastKnownFunctionRegistry",
      "kind": "data",
      "hasDefault": true,
      "default": []
    },
    {
      "op": "alter",
      "key": "lastKnownViewRegistry",
      "changes": {
        "typeHash": {
          "from": "e5ae4a80339714d8",
          "to": "a27b1ecfa82c0be8"
        }
      }
    }
  ],
  migrate(prev, { apply }) {
    const result = apply(prev)
    // customize transformation here
    return result
  },
}

export default migration
