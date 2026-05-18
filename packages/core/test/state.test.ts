import { describe, it, expect, vi } from "vitest";
import {
  ServiceState,
  state,
  isServiceState,
  STATE_MARKER,
  stateEntryPath,
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
