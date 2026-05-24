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
  version: 2,
  operations: [
    {
      "op": "add",
      "key": "shortcuts",
      "kind": "data",
      "hasDefault": true,
      "default": {}
    },
    {
      "op": "add",
      "key": "focusedView",
      "kind": "data",
      "hasDefault": true,
      "default": null
    },
    {
      "op": "alter",
      "key": "lastKnownViewRegistry",
      "changes": {
        "typeHash": {
          "from": "ff5d4435bff79bd5",
          "to": "e5ae4a80339714d8"
        }
      }
    }
  ],
  migrate(prev, { apply }) {
    const result = apply(prev)
    return result
  },
}

export default migration
