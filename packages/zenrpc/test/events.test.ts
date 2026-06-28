import { describe, it, expect, vi } from "vitest";
import { createTransportPair, createMultiClientTransportPair } from "./helpers";
import { createEventListeners } from "../src/client";
import { createUnifiedEventProxy } from "../src/events";

const echoRouter = () => ({
  echo: (msg: string) => `echo: ${msg}`,
});

type ServerRouter = ReturnType<typeof echoRouter>;

type TestEvents = {
  chat: {
    messageReceived: { viewId: string; content: string };
    typing: { userId: string };
  };
  view: {
    tabChanged: { tabs: string[] };
  };
  simple: string;
};

describe("events", () => {
  it("basic emit/subscribe", async () => {
    const { server, client, events } = createTransportPair<ServerRouter, TestEvents>({
      serverRouter: echoRouter,
      version: "0",
      clientId: "c1",
    });

    await client.ready;

    const received: any[] = [];
    events.chat.messageReceived.subscribe((data) => received.push(data));

    server.emit.chat.messageReceived({ viewId: "v1", content: "hello" });

    await vi.waitFor(() => expect(received).toHaveLength(1));
    expect(received[0]).toEqual({ viewId: "v1", content: "hello" });
  });

  it("nested event paths", async () => {
    const { server, client, events } = createTransportPair<ServerRouter, TestEvents>({
      serverRouter: echoRouter,
      version: "0",
      clientId: "c1",
    });

    await client.ready;

    const received: any[] = [];
    events.view.tabChanged.subscribe((data) => received.push(data));

    server.emit.view.tabChanged({ tabs: ["a", "b"] });

    await vi.waitFor(() => expect(received).toHaveLength(1));
    expect(received[0]).toEqual({ tabs: ["a", "b"] });
  });

  it("multiple subscribers on the same event both fire", async () => {
    const { server, client, events } = createTransportPair<ServerRouter, TestEvents>({
      serverRouter: echoRouter,
      version: "0",
      clientId: "c1",
    });

    await client.ready;

    const received1: any[] = [];
    const received2: any[] = [];
    events.chat.typing.subscribe((data) => received1.push(data));
    events.chat.typing.subscribe((data) => received2.push(data));

    server.emit.chat.typing({ userId: "u1" });

    await vi.waitFor(() => {
      expect(received1).toHaveLength(1);
      expect(received2).toHaveLength(1);
    });
    expect(received1[0]).toEqual({ userId: "u1" });
    expect(received2[0]).toEqual({ userId: "u1" });
  });

  it("unsubscribe stops delivery", async () => {
    const { server, client, events } = createTransportPair<ServerRouter, TestEvents>({
      serverRouter: echoRouter,
      version: "0",
      clientId: "c1",
    });

    await client.ready;

    const received: any[] = [];
    const unsub = events.chat.messageReceived.subscribe((data) => received.push(data));

    server.emit.chat.messageReceived({ viewId: "v1", content: "first" });
    await vi.waitFor(() => expect(received).toHaveLength(1));

    unsub();

    server.emit.chat.messageReceived({ viewId: "v1", content: "second" });
    await new Promise((r) => setTimeout(r, 50));

    expect(received).toHaveLength(1);
  });

  it("unsubscribe is idempotent", async () => {
    const { client, events } = createTransportPair<ServerRouter, TestEvents>({
      serverRouter: echoRouter,
      version: "0",
      clientId: "c1",
    });

    await client.ready;

    const unsub = events.chat.messageReceived.subscribe(() => {});
    unsub();
    expect(() => unsub()).not.toThrow();
  });

  it("emitting with no subscribers does not error", async () => {
    const { server, client } = createTransportPair<ServerRouter, TestEvents>({
      serverRouter: echoRouter,
      version: "0",
      clientId: "c1",
    });

    await client.ready;

    expect(() => {
      server.emit.chat.messageReceived({ viewId: "v1", content: "nobody listening" });
    }).not.toThrow();
  });

  it("emitTo sends to only the targeted client", async () => {
    const { server, clients } = createMultiClientTransportPair<ServerRouter, TestEvents>({
      serverRouter: echoRouter,
      version: "0",
      clientIds: ["c1", "c2"],
    });

    await Promise.all(clients.map((c) => c.client.ready));

    const received1: any[] = [];
    const received2: any[] = [];
    clients[0].events.chat.messageReceived.subscribe((data) => received1.push(data));
    clients[1].events.chat.messageReceived.subscribe((data) => received2.push(data));

    server.emitTo("c1").chat.messageReceived({ viewId: "v1", content: "only c1" });

    await vi.waitFor(() => expect(received1).toHaveLength(1));
    await new Promise((r) => setTimeout(r, 50));

    expect(received1[0]).toEqual({ viewId: "v1", content: "only c1" });
    expect(received2).toHaveLength(0);
  });

  it("broadcast reaches all connected clients", async () => {
    const { server, clients } = createMultiClientTransportPair<ServerRouter, TestEvents>({
      serverRouter: echoRouter,
      version: "0",
      clientIds: ["c1", "c2", "c3"],
    });

    await Promise.all(clients.map((c) => c.client.ready));

    const allReceived: any[][] = clients.map(() => []);
    clients.forEach((c, i) => {
      c.events.view.tabChanged.subscribe((data) => allReceived[i].push(data));
    });

    server.emit.view.tabChanged({ tabs: ["x"] });

    await vi.waitFor(() => {
      for (const r of allReceived) expect(r).toHaveLength(1);
    });

    for (const r of allReceived) {
      expect(r[0]).toEqual({ tabs: ["x"] });
    }
  });

  it("emitTo a removed client is a no-op", async () => {
    const { server, client } = createTransportPair<ServerRouter, TestEvents>({
      serverRouter: echoRouter,
      version: "0",
      clientId: "c1",
    });

    await client.ready;

    server.removeClient("c1");

    expect(() => {
      server.emitTo("c1").chat.messageReceived({ viewId: "v1", content: "gone" });
    }).not.toThrow();
  });

  it("multiple event types are independent", async () => {
    const { server, client, events } = createTransportPair<ServerRouter, TestEvents>({
      serverRouter: echoRouter,
      version: "0",
      clientId: "c1",
    });

    await client.ready;

    const chatMessages: any[] = [];
    const tabChanges: any[] = [];
    events.chat.messageReceived.subscribe((data) => chatMessages.push(data));
    events.view.tabChanged.subscribe((data) => tabChanges.push(data));

    server.emit.chat.messageReceived({ viewId: "v1", content: "msg" });
    server.emit.view.tabChanged({ tabs: ["a"] });

    await vi.waitFor(() => {
      expect(chatMessages).toHaveLength(1);
      expect(tabChanges).toHaveLength(1);
    });

    expect(chatMessages[0]).toEqual({ viewId: "v1", content: "msg" });
    expect(tabChanges[0]).toEqual({ tabs: ["a"] });
  });

  it("removeClient clears state without leaks", async () => {
    const { server, client, events } = createTransportPair<ServerRouter, TestEvents>({
      serverRouter: echoRouter,
      version: "0",
      clientId: "c1",
    });

    await client.ready;

    const received: any[] = [];
    events.chat.messageReceived.subscribe((data) => received.push(data));

    server.removeClient("c1");

    server.emit.chat.messageReceived({ viewId: "v1", content: "after remove" });
    await new Promise((r) => setTimeout(r, 50));

    expect(received).toHaveLength(0);
  });

  it("events work alongside RPC calls", async () => {
    const { server, client, events } = createTransportPair<ServerRouter, TestEvents>({
      serverRouter: echoRouter,
      version: "0",
      clientId: "c1",
    });

    await client.ready;

    const rpcResult = await client.server.echo("test");
    expect(rpcResult).toBe("echo: test");

    const received: any[] = [];
    events.chat.messageReceived.subscribe((data) => received.push(data));

    server.emit.chat.messageReceived({ viewId: "v1", content: "event" });

    await vi.waitFor(() => expect(received).toHaveLength(1));
    expect(received[0]).toEqual({ viewId: "v1", content: "event" });
  });

  it("server.emit dispatches to server-side listeners (intra-process)", async () => {
    const { server, client } = createTransportPair<ServerRouter, TestEvents>({
      serverRouter: echoRouter,
      version: "0",
      clientId: "c1",
    });

    await client.ready;

    const serverReceived: any[] = [];
    server.events.chat.messageReceived.subscribe((data) => serverReceived.push(data));

    server.emit.chat.messageReceived({ viewId: "v1", content: "intra" });

    expect(serverReceived).toHaveLength(1);
    expect(serverReceived[0]).toEqual({ viewId: "v1", content: "intra" });
  });

  it("server.events is callable to emit (unified proxy)", async () => {
    const { server, client, events } = createTransportPair<ServerRouter, TestEvents>({
      serverRouter: echoRouter,
      version: "0",
      clientId: "c1",
    });

    await client.ready;

    const serverReceived: any[] = [];
    const clientReceived: any[] = [];
    server.events.chat.typing.subscribe((data) => serverReceived.push(data));
    events.chat.typing.subscribe((data) => clientReceived.push(data));

    (server.events.chat.typing as any)({ userId: "u1" });

    expect(serverReceived).toHaveLength(1);
    expect(serverReceived[0]).toEqual({ userId: "u1" });

    await vi.waitFor(() => expect(clientReceived).toHaveLength(1));
    expect(clientReceived[0]).toEqual({ userId: "u1" });
  });

  it("client can emit events (intra-client + sent to server)", async () => {
    const { server, client, events } = createTransportPair<ServerRouter, TestEvents>({
      serverRouter: echoRouter,
      version: "0",
      clientId: "c1",
    });

    await client.ready;

    const clientReceived: any[] = [];
    const serverReceived: any[] = [];
    events.chat.messageReceived.subscribe((data) => clientReceived.push(data));
    server.events.chat.messageReceived.subscribe((data) => serverReceived.push(data));

    (events.chat.messageReceived as any)({ viewId: "v1", content: "from-client" });

    expect(clientReceived).toHaveLength(1);
    expect(clientReceived[0]).toEqual({ viewId: "v1", content: "from-client" });

    await vi.waitFor(() => expect(serverReceived).toHaveLength(1));
    expect(serverReceived[0]).toEqual({ viewId: "v1", content: "from-client" });
  });

  it("client-emitted events are NOT re-broadcast to other clients", async () => {
    const { server, clients } = createMultiClientTransportPair<ServerRouter, TestEvents>({
      serverRouter: echoRouter,
      version: "0",
      clientIds: ["c1", "c2"],
    });

    await Promise.all(clients.map((c) => c.client.ready));

    const c1Received: any[] = [];
    const c2Received: any[] = [];
    const serverReceived: any[] = [];
    clients[0].events.chat.messageReceived.subscribe((data) => c1Received.push(data));
    clients[1].events.chat.messageReceived.subscribe((data) => c2Received.push(data));
    server.events.chat.messageReceived.subscribe((data) => serverReceived.push(data));

    (clients[0].events.chat.messageReceived as any)({ viewId: "v1", content: "from-c1" });

    expect(c1Received).toHaveLength(1);
    expect(c1Received[0]).toEqual({ viewId: "v1", content: "from-c1" });

    await vi.waitFor(() => expect(serverReceived).toHaveLength(1));
    expect(serverReceived[0]).toEqual({ viewId: "v1", content: "from-c1" });

    await new Promise((r) => setTimeout(r, 50));
    expect(c2Received).toHaveLength(0);
  });
});

describe("unified event proxy (standalone)", () => {
  it("emit fires local subscribers synchronously", () => {
    const listeners = createEventListeners();
    const emitted: Array<{ path: string[]; data: unknown }> = [];
    const proxy = createUnifiedEventProxy<TestEvents>(
      listeners,
      (path, data) => {
        listeners.dispatch(path.join("."), data);
        emitted.push({ path, data });
      },
    );

    const received: any[] = [];
    proxy.chat.messageReceived.subscribe((data: any) => received.push(data));

    proxy.chat.messageReceived({ viewId: "v1", content: "hello" });

    expect(received).toHaveLength(1);
    expect(received[0]).toEqual({ viewId: "v1", content: "hello" });
    expect(emitted).toHaveLength(1);
  });

  it("subscribe without emit works", () => {
    const listeners = createEventListeners();
    const proxy = createUnifiedEventProxy<TestEvents>(
      listeners,
      () => {},
    );

    const received: any[] = [];
    proxy.view.tabChanged.subscribe((data: any) => received.push(data));

    listeners.dispatch("view.tabChanged", { tabs: ["x"] });

    expect(received).toHaveLength(1);
    expect(received[0]).toEqual({ tabs: ["x"] });
  });

  it("unsubscribe stops delivery", () => {
    const listeners = createEventListeners();
    const proxy = createUnifiedEventProxy<TestEvents>(
      listeners,
      (path, data) => listeners.dispatch(path.join("."), data),
    );

    const received: any[] = [];
    const unsub = proxy.chat.typing.subscribe((data: any) => received.push(data));

    proxy.chat.typing({ userId: "u1" });
    expect(received).toHaveLength(1);

    unsub();

    proxy.chat.typing({ userId: "u2" });
    expect(received).toHaveLength(1);
  });
});
