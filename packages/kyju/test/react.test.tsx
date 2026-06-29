// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import zod from "zod";
import { createKyjuReact } from "../src/v2/react/index";
import { createSchema, f, type InferSchema } from "../src/v2/db/schema";
import { setup, setupMultiClient, delay, type TestSchema } from "./helpers";

const { KyjuProvider, useDb, useCollection } = createKyjuReact<TestSchema>();

function makeWrapper(ctx: { client: any; replica: any }) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return createElement(KyjuProvider, {
      client: ctx.client,
      replica: ctx.replica,
      children,
    });
  };
}

let cleanup: () => void;
afterEach(() => cleanup?.());

describe("useDb", () => {
  it("returns full root without selector", async () => {
    const ctx = await setup();
    cleanup = ctx.cleanup;

    const { result } = renderHook(() => useDb(), {
      wrapper: makeWrapper(ctx),
    });

    expect(result.current).toBeDefined();
    expect((result.current as any).title).toBe("untitled");
  });

  it("returns selected field with selector", async () => {
    const ctx = await setup();
    cleanup = ctx.cleanup;

    const { result } = renderHook(() => useDb((root) => root.title), {
      wrapper: makeWrapper(ctx),
    });

    expect(result.current).toBe("untitled");
  });

  it("re-renders when selected field changes", async () => {
    const ctx = await setup();
    cleanup = ctx.cleanup;

    let renderCount = 0;
    const { result } = renderHook(
      () => {
        renderCount++;
        return useDb((root) => root.title);
      },
      { wrapper: makeWrapper(ctx) },
    );

    expect(result.current).toBe("untitled");
    const initialRenders = renderCount;

    await act(async () => {
      await ctx.client.title.set("changed");
      await delay(20);
    });

    expect(result.current).toBe("changed");
    expect(renderCount).toBeGreaterThan(initialRenders);
  });

  it("does NOT re-render when unrelated field changes", async () => {
    const ctx = await setup();
    cleanup = ctx.cleanup;

    let renderCount = 0;
    const { result } = renderHook(
      () => {
        renderCount++;
        return useDb((root) => root.title);
      },
      { wrapper: makeWrapper(ctx) },
    );

    expect(result.current).toBe("untitled");
    await delay(20);
    const afterInitialRenders = renderCount;

    await act(async () => {
      await ctx.replica.postMessage({
        kind: "write",
        op: { type: "root.set", path: ["unrelated"], value: "noise" },
      });
      await delay(20);
    });

    expect(result.current).toBe("untitled");
    expect(renderCount).toBe(afterInitialRenders);
  });

  it("full root re-renders on any field change", async () => {
    const ctx = await setup();
    cleanup = ctx.cleanup;

    let renderCount = 0;
    const { result } = renderHook(
      () => {
        renderCount++;
        return useDb();
      },
      { wrapper: makeWrapper(ctx) },
    );

    await delay(20);
    const afterInitialRenders = renderCount;

    await act(async () => {
      await ctx.client.title.set("changed");
      await delay(20);
    });

    expect((result.current as any).title).toBe("changed");
    expect(renderCount).toBeGreaterThan(afterInitialRenders);
  });
});

describe("useCollection", () => {
  it("returns initial collection data after subscribe", async () => {
    const ctx = await setup();
    cleanup = ctx.cleanup;

    await ctx.client.messages.concat([{ text: "welcome", author: "system" }]);

    const { result } = renderHook(() => {
      const messagesRef = useDb((root) => root.messages);
      return useCollection(messagesRef);
    }, {
      wrapper: makeWrapper(ctx),
    });

    await act(async () => {
      await delay(50);
    });

    expect(result.current.items.length).toBe(1);
    expect(result.current.items[0]).toEqual({
      text: "welcome",
      author: "system",
    });
    expect(result.current.collection).not.toBeNull();
    expect(typeof result.current.concat).toBe("function");
  });

  it("updates when local concat fires", async () => {
    const ctx = await setup();
    cleanup = ctx.cleanup;

    await ctx.client.messages.concat([{ text: "seed", author: "system" }]);

    const { result } = renderHook(() => {
      const messagesRef = useDb((root) => root.messages);
      return useCollection(messagesRef);
    }, {
      wrapper: makeWrapper(ctx),
    });

    await act(async () => {
      await delay(50);
    });

    expect(result.current.items.length).toBe(1);

    await act(async () => {
      await result.current.concat([{ text: "hello", author: "me" }]);
      await delay(20);
    });

    expect(result.current.items.length).toBe(2);
    expect(result.current.items[1]).toEqual({ text: "hello", author: "me" });
  });

  it("updates when remote replica concats", async () => {
    const ctx = await setupMultiClient(2);
    cleanup = ctx.cleanup;

    const { result } = renderHook(() => {
      const messagesRef = useDb((root) => root.messages);
      return useCollection(messagesRef);
    }, {
      wrapper: makeWrapper({ client: ctx.clients[0], replica: ctx.replicas[0] }),
    });

    await act(async () => {
      await delay(50);
    });

    const initialCount = result.current.items.length;

    await act(async () => {
      await ctx.clients[1].messages.concat([{ text: "remote", author: "other" }]);
      await delay(50);
    });

    expect(result.current.items.length).toBe(initialCount + 1);
    expect(result.current.items[result.current.items.length - 1]).toEqual({
      text: "remote",
      author: "other",
    });
  });

  it("cleans up subscription on unmount", async () => {
    const ctx = await setup();
    cleanup = ctx.cleanup;

    const { unmount } = renderHook(() => {
      const messagesRef = useDb((root) => root.messages);
      return useCollection(messagesRef);
    }, {
      wrapper: makeWrapper(ctx),
    });

    await act(async () => {
      await delay(50);
    });

    unmount();
    await delay(20);

    const state = ctx.replica.getState();
    if (state.kind === "connected") {
      const collectionId = (state.root as any).messages.collectionId;
      const col = state.collections.find((c) => c.id === collectionId);
      expect(col).toBeUndefined();
    }
  });

  // Regression: when two `useCollection` hooks point at the same
  // collectionId (e.g. the same chat shown in two split panes), the
  // first hook to unmount used to send `unsubscribe-collection` to
  // the replica, which unconditionally dropped the collection from
  // local state — leaving the still-mounted hook reading empty items
  // until something else triggered a resubscribe. The fix routes
  // through the client's refcounted `subscribeCollection`, so the
  // replica only drops the collection when the last consumer leaves.
  it(
    "keeps data alive when one of two consumers on the same collection unmounts",
    async () => {
      const ctx = await setup();
      cleanup = ctx.cleanup;

      await ctx.client.messages.concat([
        { text: "shared", author: "system" },
      ]);

      // First consumer mounts and waits for the initial data to land.
      const first = renderHook(
        () => {
          const messagesRef = useDb((root) => root.messages);
          return useCollection(messagesRef);
        },
        { wrapper: makeWrapper(ctx) },
      );
      await act(async () => {
        await delay(50);
      });
      expect(first.result.current.items.length).toBe(1);

      // Second consumer mounts on the same collection — simulating
      // a split pane showing the same chat.
      const second = renderHook(
        () => {
          const messagesRef = useDb((root) => root.messages);
          return useCollection(messagesRef);
        },
        { wrapper: makeWrapper(ctx) },
      );
      await act(async () => {
        await delay(50);
      });
      expect(second.result.current.items.length).toBe(1);

      // Close the second pane.
      second.unmount();
      await act(async () => {
        await delay(50);
      });

      // First pane MUST still see the data. Previously this came back
      // as 0 because the replica had dropped the collection.
      expect(first.result.current.items.length).toBe(1);
      expect(first.result.current.items[0]).toEqual({
        text: "shared",
        author: "system",
      });

      // And new writes still flow through to the surviving consumer.
      await act(async () => {
        await ctx.client.messages.concat([
          { text: "after-close", author: "system" },
        ]);
        await delay(50);
      });
      expect(first.result.current.items.length).toBe(2);

      first.unmount();
      await delay(20);

      // After the last consumer leaves, the collection IS dropped.
      const state = ctx.replica.getState();
      if (state.kind === "connected") {
        const collectionId = (state.root as any).messages.collectionId;
        const col = state.collections.find((c) => c.id === collectionId);
        expect(col).toBeUndefined();
      }
    },
  );
});

const arraySchema = createSchema({
  items: f
    .array(
      zod.object({
        id: zod.string(),
        status: zod.string(),
      }),
    )
    .default([{ id: "a", status: "idle" }]),
});

type ArraySchema = InferSchema<typeof arraySchema>;

const arrayReact = createKyjuReact<ArraySchema>();

function makeArrayWrapper(ctx: { client: any; replica: any }) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return createElement(arrayReact.KyjuProvider, {
      client: ctx.client,
      replica: ctx.replica,
      children,
    });
  };
}

describe("useDb projecting selector (issue #11)", () => {
  it("does not infinite-loop when the selector returns fresh literals", async () => {
    const ctx = await setup();
    cleanup = ctx.cleanup;

    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    let renderCount = 0;
    const { result } = renderHook(
      () => {
        renderCount++;
        // Projects into a fresh array of fresh objects every call — the
        // shape the default shallowEqual can't see through. Before the
        // fix this looped with "Maximum update depth exceeded".
        return useDb((root) => [{ label: root.title }]);
      },
      { wrapper: makeWrapper(ctx) },
    );

    await act(async () => {
      await delay(20);
    });

    expect(result.current).toEqual([{ label: "untitled" }]);
    // Must settle instead of looping; hundreds of renders means the guard
    // failed.
    expect(renderCount).toBeLessThan(10);
    // And it warns the developer once (dev mode), rather than just crashing.
    expect(errSpy).toHaveBeenCalled();

    const before = renderCount;
    await act(async () => {
      await ctx.client.title.set("changed");
      await delay(20);
    });

    // A real db change still flows through.
    expect(result.current).toEqual([{ label: "changed" }]);
    expect(renderCount).toBeGreaterThan(before);

    errSpy.mockRestore();
  });

  it("still reflects prop-driven selector changes without a db write", async () => {
    const ctx = await setup();
    cleanup = ctx.cleanup;

    // Selector closes over a prop. Changing the prop (no db write) must
    // still re-select — the loop guard must not freeze deterministic
    // prop-dependent selectors, and must not warn for them.
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const { result, rerender } = renderHook(
      ({ suffix }: { suffix: string }) =>
        useDb((root) => `${root.title}-${suffix}`),
      { wrapper: makeWrapper(ctx), initialProps: { suffix: "a" } },
    );

    expect(result.current).toBe("untitled-a");
    rerender({ suffix: "b" });
    expect(result.current).toBe("untitled-b");
    expect(errSpy).not.toHaveBeenCalled();

    errSpy.mockRestore();
  });
});

describe("useDb nested array reactivity", () => {
  it("re-renders when a nested field in an array element changes via update()", async () => {
    const ctx = await setup({ schema: arraySchema });
    cleanup = ctx.cleanup;

    let renderCount = 0;
    const { result } = renderHook(
      () => {
        renderCount++;
        return arrayReact.useDb((root) => root.items);
      },
      { wrapper: makeArrayWrapper(ctx) },
    );

    await act(async () => { await delay(20); });

    expect(result.current).toHaveLength(1);
    expect(result.current[0].status).toBe("idle");
    const afterInitial = renderCount;

    await act(async () => {
      await ctx.client.update((root: any) => {
        root.items[0].status = "streaming";
      });
      await delay(20);
    });

    expect(result.current[0].status).toBe("streaming");
    expect(renderCount).toBeGreaterThan(afterInitial);
  });
});
