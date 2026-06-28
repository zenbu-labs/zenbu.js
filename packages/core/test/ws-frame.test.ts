import { describe, it, expect } from "vitest";
import { encodeFrame, decodeFrame } from "../src/transport/ws-frame";

/** Round-trip a message the way the WS adapter does (encode → frame → decode). */
function roundTrip(msg: { ch: string; data: unknown }) {
  const wire = encodeFrame(msg);
  const isBinary = typeof wire !== "string";
  return { wire, isBinary, decoded: decodeFrame(wire, isBinary) };
}

describe("ws-frame codec", () => {
  it("sends a text frame (string) when there is no binary", () => {
    const msg = { ch: "db", data: { type: "op", path: ["app", "title"], value: "hi" } };
    const { wire, isBinary, decoded } = roundTrip(msg);
    expect(isBinary).toBe(false);
    expect(typeof wire).toBe("string");
    expect(decoded).toEqual(msg);
  });

  it("sends a binary frame and restores a Uint8Array byte-exactly", () => {
    const bytes = new Uint8Array(5000);
    for (let i = 0; i < bytes.length; i++) bytes[i] = i & 0xff;
    const msg = { ch: "db", data: { type: "ack", requestId: "r1", data: { data: bytes } } };

    const { wire, isBinary, decoded } = roundTrip(msg);
    expect(isBinary).toBe(true);
    expect(wire).toBeInstanceOf(Uint8Array);
    expect(decoded.ch).toBe("db");
    expect(decoded.data.data.data).toBeInstanceOf(Uint8Array);
    expect(Array.from(decoded.data.data.data as Uint8Array)).toEqual(Array.from(bytes));
  });

  it("carries a Node Buffer as raw bytes, never the {type:'Buffer'} form", () => {
    const buf = Buffer.alloc(4096);
    for (let i = 0; i < buf.length; i++) buf[i] = i & 0xff;
    const msg = { ch: "db", data: { type: "ack", data: { data: buf } } };

    const wire = encodeFrame(msg);
    expect(wire).toBeInstanceOf(Uint8Array);
    // The bug we're killing: a Buffer must not serialize as a per-byte array.
    const asText = Buffer.from(wire as Uint8Array).toString("latin1");
    expect(asText.includes('"type":"Buffer"')).toBe(false);

    const decoded = decodeFrame(wire, true);
    expect(decoded.data.data.data).toBeInstanceOf(Uint8Array);
    expect(Array.from(decoded.data.data.data as Uint8Array)).toEqual(Array.from(buf));
  });

  it("wire stays ~1x the byte size (no base64, no numeric array)", () => {
    const buf = Buffer.alloc(8192, 0xab);
    const wire = encodeFrame({ ch: "db", data: { data: buf } }) as Uint8Array;
    // header is a few dozen bytes; the rest is the raw payload.
    expect(wire.length).toBeLessThan(buf.length + 256);
  });

  it("handles multiple, nested, and zero-length binaries", () => {
    const a = new Uint8Array([1, 2, 3]);
    const b = new Uint8Array([]); // empty
    const c = new Uint8Array([255, 254, 253, 252]);
    const msg = {
      ch: "db",
      data: { blobs: [{ id: "a", bytes: a }, { id: "b", bytes: b }], extra: { c } },
    };

    const { decoded } = roundTrip(msg);
    expect(Array.from(decoded.data.blobs[0].bytes as Uint8Array)).toEqual([1, 2, 3]);
    expect((decoded.data.blobs[1].bytes as Uint8Array).length).toBe(0);
    expect(Array.from(decoded.data.extra.c as Uint8Array)).toEqual([255, 254, 253, 252]);
  });

  it("decodes a Node Buffer-backed binary frame (server receive path)", () => {
    const bytes = new Uint8Array([10, 20, 30, 40, 50]);
    const wire = encodeFrame({ ch: "db", data: { data: bytes } }) as Uint8Array;
    // On the server, `ws` delivers binary frames as a Buffer with isBinary=true.
    const asNodeBuffer = Buffer.from(wire);
    const decoded = decodeFrame(asNodeBuffer, true);
    expect(Array.from(decoded.data.data as Uint8Array)).toEqual([10, 20, 30, 40, 50]);
  });

  it("preserves the channel tag for filtering", () => {
    expect(decodeFrame(encodeFrame({ ch: "db", data: 1 }), false).ch).toBe("db");
    const wire = encodeFrame({ ch: "db", data: { x: new Uint8Array([9]) } });
    expect(decodeFrame(wire, typeof wire !== "string").ch).toBe("db");
  });
});
