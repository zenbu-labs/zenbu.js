import { describe, it, expect, vi } from "vitest";
import {
  ServiceState,
  state,
  isServiceState,
  STATE_MARKER,
  STATE_WIRE_CHANNEL,
  stateEntryPath,
  tryRecordSelectorPath,
  ClientStateStore,
} from "../src/state";
import {
  Service,
  ServiceRuntime,
  type StateUpdateMessage,
} from "../src/runtime";

describe("ServiceState primitive", () => {
  it("get/set returns the latest value", () => {
    const cell = state(1);
    expect(cell.value).toBe(1);
    cell.set(2);
    expect(cell.get()).toBe(2);
  });

  it("update applies the callback", () => {
    const cell = state(10);
    cell.update((n) => n + 5);
    expect(cell.value).toBe(15);
  });

  it("subscribe fires on change and returns an unsubscribe", () => {
    const cell = state("a");
    const cb = vi.fn();
    const unsub = cell.subscribe(cb);
    cell.set("b");
    cell.set("c");
    expect(cb).toHaveBeenCalledTimes(2);
    expect(cb).toHaveBeenLastCalledWith("c");
    unsub();
    cell.set("d");
    expect(cb).toHaveBeenCalledTimes(2);
  });

  it("set with the same value (Object.is) is a no-op", () => {
    const cell = state(7);
    const cb = vi.fn();
    cell.subscribe(cb);
    cell.set(7);
    expect(cb).not.toHaveBeenCalled();

    const obj = { x: 1 };
    const cell2 = state(obj);
    const cb2 = vi.fn();
    cell2.subscribe(cb2);
    cell2.set(obj);
    expect(cb2).not.toHaveBeenCalled();
    cell2.set({ x: 1 });
    expect(cb2).toHaveBeenCalledTimes(1);
  });

  it("subscriber throw is logged but does not stop other subscribers", () => {
    const cell = state(0);
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const cbThrow = vi.fn(() => {
      throw new Error("boom");
    });
    const cbOk = vi.fn();
    cell.subscribe(cbThrow);
    cell.subscribe(cbOk);
    cell.set(1);
    expect(cbThrow).toHaveBeenCalled();
    expect(cbOk).toHaveBeenCalledWith(1);
    errors.mockRestore();
  });
});

describe("isServiceState / STATE_MARKER", () => {
  it("brands cells so the guard works without instanceof", () => {
    const cell = state(0);
    expect(isServiceState(cell)).toBe(true);
    expect((cell as any)[STATE_MARKER]).toBe(true);
  });

  it("rejects plain objects", () => {
    expect(isServiceState({})).toBe(false);
    expect(isServiceState(null)).toBe(false);
    expect(isServiceState(undefined)).toBe(false);
    expect(isServiceState(42)).toBe(false);
    expect(isServiceState({ [STATE_MARKER]: false })).toBe(false);
  });
});

describe("stateEntryPath", () => {
  it("dots the three segments", () => {
    expect(stateEntryPath("core", "server", "status")).toBe(
      "core.server.status",
    );
  });
});

describe("STATE_WIRE_CHANNEL", () => {
  it("is the literal 'state' — wire stays in sync with the renderer", () => {
    expect(STATE_WIRE_CHANNEL).toBe("state");
  });
});

describe("tryRecordSelectorPath", () => {
  it("records a chain of string-keyed property accesses", () => {
    expect(tryRecordSelectorPath((s) => s.core["server-status"].status)).toBe(
      "core.server-status.status",
    );
    expect(tryRecordSelectorPath((s) => s.a.b.c.d)).toBe("a.b.c.d");
  });

  it("returns null when the selector calls a method (e.g. `.find`)", () => {
    expect(
      tryRecordSelectorPath((s) =>
        s.core["view-registry"].registry.find(() => true),
      ),
    ).toBeNull();
  });

  it("returns null when the selector returns a non-proxy leaf", () => {
    expect(tryRecordSelectorPath(() => 42)).toBeNull();
    expect(tryRecordSelectorPath(() => "hello")).toBeNull();
    expect(tryRecordSelectorPath(() => null)).toBeNull();
  });

  it("returns null on `in` checks and thenable probes", () => {
    expect(tryRecordSelectorPath((s) => "x" in s)).toBeNull();
    // `then` access is a common library/React probe — must bail so the
    // hook does not subscribe to a fake `then` path.
    expect(tryRecordSelectorPath((s) => s.then)).toBeNull();
  });

  it("returns null when the selector throws", () => {
    expect(
      tryRecordSelectorPath(() => {
        throw new Error("nope");
      }),
    ).toBeNull();
  });
});

describe("ClientStateStore path subscriptions", () => {
  it("subscribePath fires only when the specific path changes", () => {
    const store = new ClientStateStore();
    store.apply({
      t: "snapshot",
      values: { "core.a.x": 1, "core.a.y": 2 },
    });
    const cbX = vi.fn();
    const cbY = vi.fn();
    const unsubX = store.subscribePath("core.a.x", cbX);
    const unsubY = store.subscribePath("core.a.y", cbY);

    store.apply({ t: "update", path: "core.a.x", value: 99 });
    expect(cbX).toHaveBeenCalledTimes(1);
    expect(cbY).not.toHaveBeenCalled();

    store.apply({ t: "update", path: "core.a.y", value: 99 });
    expect(cbX).toHaveBeenCalledTimes(1);
    expect(cbY).toHaveBeenCalledTimes(1);

    unsubX();
    unsubY();
    store.apply({ t: "update", path: "core.a.x", value: 100 });
    expect(cbX).toHaveBeenCalledTimes(1);
  });

  it("dedups updates that do not change the value (Object.is)", () => {
    const store = new ClientStateStore();
    store.apply({ t: "snapshot", values: { "core.a.x": 1 } });
    const cb = vi.fn();
    store.subscribePath("core.a.x", cb);
    store.apply({ t: "update", path: "core.a.x", value: 1 });
    expect(cb).not.toHaveBeenCalled();
    store.apply({ t: "update", path: "core.a.x", value: 2 });
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it("snapshot fires path listeners only for paths that actually changed", () => {
    const store = new ClientStateStore();
    store.apply({
      t: "snapshot",
      values: { "core.a.x": 1, "core.a.y": 2 },
    });
    const cbX = vi.fn();
    const cbY = vi.fn();
    store.subscribePath("core.a.x", cbX);
    store.subscribePath("core.a.y", cbY);
    // New snapshot keeps y, changes x, adds z.
    store.apply({
      t: "snapshot",
      values: { "core.a.x": 99, "core.a.y": 2, "core.a.z": 3 },
    });
    expect(cbX).toHaveBeenCalledTimes(1);
    expect(cbY).not.toHaveBeenCalled();
  });

  it("getValueAt reads by exact wire path", () => {
    const store = new ClientStateStore();
    store.apply({ t: "snapshot", values: { "core.a.x": 1 } });
    expect(store.getValueAt("core.a.x")).toBe(1);
    expect(store.getValueAt("core.a.missing")).toBeUndefined();
  });
});

describe("ClientStateStore", () => {
  it("snapshot replaces values; getTree builds the nested view", () => {
    const store = new ClientStateStore();
    store.apply({
      t: "snapshot",
      values: {
        "core.server.status": "running",
        "core.server.port": 4000,
        "myplugin.foo.count": 3,
      },
    });
    expect(store.getEntries()).toEqual({
      "core.server.status": "running",
      "core.server.port": 4000,
      "myplugin.foo.count": 3,
    });
    expect(store.getTree()).toEqual({
      core: { server: { status: "running", port: 4000 } },
      myplugin: { foo: { count: 3 } },
    });
  });

  it("update patches a single path without disturbing the others", () => {
    const store = new ClientStateStore();
    store.apply({
      t: "snapshot",
      values: { "core.a.x": 1, "core.a.y": 2 },
    });
    store.apply({ t: "update", path: "core.a.x", value: 99 });
    expect(store.getTree()).toEqual({ core: { a: { x: 99, y: 2 } } });
  });

  it("update with undefined removes the path", () => {
    const store = new ClientStateStore();
    store.apply({
      t: "snapshot",
      values: { "core.a.x": 1, "core.a.y": 2 },
    });
    store.apply({ t: "update", path: "core.a.x", value: undefined });
    expect(store.getEntries()).toEqual({ "core.a.y": 2 });
    expect(store.getTree()).toEqual({ core: { a: { y: 2 } } });
  });

  it("subscribe fires on every apply; unsubscribe stops notifications", () => {
    const store = new ClientStateStore();
    const cb = vi.fn();
    const unsub = store.subscribe(cb);
    store.apply({ t: "snapshot", values: { "core.a.x": 1 } });
    store.apply({ t: "update", path: "core.a.x", value: 2 });
    expect(cb).toHaveBeenCalledTimes(2);
    unsub();
    store.apply({ t: "update", path: "core.a.x", value: 3 });
    expect(cb).toHaveBeenCalledTimes(2);
  });

  it("getTree returns a stable reference between applies", () => {
    const store = new ClientStateStore();
    store.apply({ t: "snapshot", values: { "core.a.x": 1 } });
    const tree1 = store.getTree();
    expect(store.getTree()).toBe(tree1);
    store.apply({ t: "update", path: "core.a.x", value: 2 });
    expect(store.getTree()).not.toBe(tree1);
  });
});

// --------------------------------------------------------------------------
// Runtime integration: a freshly-constructed ServiceRuntime, not the
// global one, so tests don't trip over each other or over services that
// register at module-import time elsewhere in the package.
// --------------------------------------------------------------------------

describe("ServiceRuntime — state registry", () => {
  it("registers state fields after evaluate; getStateEntries returns the snapshot", async () => {
    const rt = new ServiceRuntime();

    class Counter extends Service.create({ key: "counter-1" }) {
      count = state(0);
      label = state("hello");
      // Underscore-prefixed fields are intentionally skipped so services
      // can keep private reactive cells out of the wire surface.
      _hidden = state("private");
    }

    rt.register(Counter as any);
    await rt.whenIdle();

    const entries = rt.getStateEntries();
    expect(entries["core.counter-1.count"]).toBe(0);
    expect(entries["core.counter-1.label"]).toBe("hello");
    expect(entries["core.counter-1._hidden"]).toBeUndefined();
    expect(entries["core.counter-1.hidden"]).toBeUndefined();
  });

  it("broadcasts an initial value at registration and on every set()", async () => {
    const rt = new ServiceRuntime();
    const messages: StateUpdateMessage[] = [];
    rt.subscribeStateChanges((m) => messages.push(m));

    class Counter extends Service.create({ key: "counter-2" }) {
      count = state(0);
    }

    rt.register(Counter as any);
    await rt.whenIdle();

    // Initial broadcast on registration.
    expect(
      messages.find(
        (m) => m.path === "core.counter-2.count" && m.value === 0,
      ),
    ).toBeDefined();

    const slot = rt.getSlot("counter-2");
    const inst = slot!.instance as unknown as { count: ServiceState<number> };
    inst.count.set(1);
    inst.count.set(2);

    const recent = messages.filter((m) => m.path === "core.counter-2.count");
    expect(recent.map((m) => m.value)).toEqual([0, 1, 2]);
  });

  it("teardown unregisters cells and broadcasts undefined for each", async () => {
    const rt = new ServiceRuntime();
    const messages: StateUpdateMessage[] = [];
    rt.subscribeStateChanges((m) => messages.push(m));

    class Counter extends Service.create({ key: "counter-3" }) {
      count = state(42);
    }

    rt.register(Counter as any);
    await rt.whenIdle();
    expect(rt.getStateEntries()["core.counter-3.count"]).toBe(42);

    await rt.shutdown();

    expect(rt.getStateEntries()["core.counter-3.count"]).toBeUndefined();
    const tombstone = messages.find(
      (m) => m.path === "core.counter-3.count" && m.value === undefined,
    );
    expect(tombstone).toBeDefined();
  });

  it("freezes the state slot so reassignment fails (footgun: meant `.set()`)", async () => {
    const rt = new ServiceRuntime();

    class Frozen extends Service.create({ key: "frozen" }) {
      count = state(0);
    }

    rt.register(Frozen as any);
    await rt.whenIdle();

    const inst = rt.getSlot("frozen")!.instance as unknown as {
      count: ServiceState<number>;
    };
    const originalCell = inst.count;

    // Reassigning the slot must throw — author should have done
    // `.set(...)`. The cell underneath stays untouched.
    expect(() => {
      (inst as any).count = state(999);
    }).toThrow();
    expect(inst.count).toBe(originalCell);
    expect(rt.getStateEntries()["core.frozen.count"]).toBe(0);
  });

  it("broadcasts updates fired during evaluate() (registration is pre-evaluate)", async () => {
    const rt = new ServiceRuntime();
    const messages: StateUpdateMessage[] = [];
    rt.subscribeStateChanges((m) => messages.push(m));

    class EagerSetter extends Service.create({ key: "eager" }) {
      status = state<"a" | "b">("a");
      evaluate() {
        // This .set() runs inside evaluate(). With pre-evaluate
        // registration the broadcast reaches subscribers; without it,
        // they'd miss the change and start at "a".
        this.status.set("b");
      }
    }

    rt.register(EagerSetter as any);
    await rt.whenIdle();

    const status = messages.filter((m) => m.path === "core.eager.status");
    expect(status.map((m) => m.value)).toContain("a"); // initial
    expect(status.map((m) => m.value)).toContain("b"); // evaluate's set
    expect(rt.getStateEntries()["core.eager.status"]).toBe("b");
  });

  it("end-to-end: a server-side change flows through a ClientStateStore", async () => {
    const rt = new ServiceRuntime();
    const client = new ClientStateStore();

    // Hook the dispatcher up to the client store, mimicking what
    // StateService does over the WebSocket.
    rt.subscribeStateChanges((msg) => client.apply(msg));

    class Server extends Service.create({ key: "srv" }) {
      status = state<"idle" | "running">("idle");
      port = state<number | null>(null);
    }

    rt.register(Server as any);
    await rt.whenIdle();

    // Initial broadcasts populated the client store via per-cell updates.
    expect(client.getTree()).toEqual({
      core: { srv: { status: "idle", port: null } },
    });

    const inst = rt.getSlot("srv")!.instance as unknown as {
      status: ServiceState<string>;
      port: ServiceState<number | null>;
    };
    inst.status.set("running");
    inst.port.set(4000);

    expect(client.getTree()).toEqual({
      core: { srv: { status: "running", port: 4000 } },
    });

    // Snapshot from the runtime matches the client view.
    const snapshot = rt.getStateEntries();
    const fresh = new ClientStateStore();
    fresh.apply({ t: "snapshot", values: snapshot });
    expect(fresh.getTree()).toEqual(client.getTree());
  });
});
