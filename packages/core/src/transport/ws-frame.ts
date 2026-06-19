/**
 * WebSocket adapter framing for the DB channel.
 *
 * The replica core is medium-agnostic: it deals in structured events that may
 * contain `Uint8Array` values (blob bytes). A WebSocket message, however, is
 * either text *or* binary — it can't be "JSON structure wrapped around raw
 * bytes". So this module is the one place that composes the two, and it lives
 * with the WebSocket adapter rather than in the shared replica layer. Other
 * transports (in-process router, future Electron IPC) carry binary natively
 * and don't use this.
 *
 * Wire format, chosen per message:
 *
 *   - No binary anywhere  → a TEXT frame: plain `JSON.stringify(msg)`.
 *   - Any `Uint8Array`    → a BINARY frame:
 *
 *       [ver:u8=1]
 *       [segCount:u32]
 *       [segLen:u32] × segCount
 *       [headerLen:u32]
 *       [header JSON utf8]          // the message, each Uint8Array replaced
 *                                   // by { "__$bin": i }
 *       [seg0 ++ seg1 ++ … raw]     // the bytes, in order
 *
 * On decode only the small header is `JSON.parse`d; the bytes are sliced out
 * of the tail and never parsed. Crucially, the binary scan inspects live
 * values *before* `JSON.stringify` runs, so a Node `Buffer` (a `Uint8Array`
 * subclass whose `toJSON` would otherwise expand it into a per-byte number
 * array) is captured as raw bytes like any other view.
 */

const BIN_TAG = "__$bin";
const VERSION = 1;

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

const hasOwn = (o: object, k: string) =>
  Object.prototype.hasOwnProperty.call(o, k);

/** True if `value` contains a `Uint8Array` anywhere (short-circuits). */
function containsBinary(value: unknown): boolean {
  if (value instanceof Uint8Array) return true;
  if (Array.isArray(value)) {
    for (const item of value) if (containsBinary(item)) return true;
    return false;
  }
  if (value !== null && typeof value === "object") {
    for (const k in value as Record<string, unknown>) {
      if (hasOwn(value as object, k) && containsBinary((value as any)[k]))
        return true;
    }
    return false;
  }
  return false;
}

/**
 * Deep-clone `value`, pulling every `Uint8Array` into `segments` and leaving a
 * `{ [BIN_TAG]: index }` placeholder in its place. Only used once we know
 * there is binary present.
 */
function extractBinary(value: unknown, segments: Uint8Array[]): unknown {
  if (value instanceof Uint8Array) {
    segments.push(value);
    return { [BIN_TAG]: segments.length - 1 };
  }
  if (Array.isArray(value)) {
    return value.map((item) => extractBinary(item, segments));
  }
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const k in value as Record<string, unknown>) {
      if (hasOwn(value as object, k))
        out[k] = extractBinary((value as any)[k], segments);
    }
    return out;
  }
  return value;
}

/** Inverse of `extractBinary`: replace placeholders with byte-range views. */
function restoreBinary(
  value: unknown,
  buf: Uint8Array,
  offsets: number[],
  lengths: number[],
): unknown {
  if (value !== null && typeof value === "object") {
    const idx = (value as Record<string, unknown>)[BIN_TAG];
    if (typeof idx === "number") {
      return buf.subarray(offsets[idx], offsets[idx] + lengths[idx]);
    }
    if (Array.isArray(value)) {
      return value.map((item) => restoreBinary(item, buf, offsets, lengths));
    }
    const out: Record<string, unknown> = {};
    for (const k in value as Record<string, unknown>) {
      if (hasOwn(value as object, k))
        out[k] = restoreBinary((value as any)[k], buf, offsets, lengths);
    }
    return out;
  }
  return value;
}

const toU8 = (data: ArrayBuffer | Uint8Array): Uint8Array =>
  data instanceof Uint8Array ? data : new Uint8Array(data);

/**
 * Encode a channel message. Returns a `string` (text frame) when there is no
 * binary, or a `Uint8Array` (binary frame) when there is. `ws.send` accepts
 * both and frames them accordingly.
 */
export function encodeFrame(msg: { ch: string; data: unknown }): string | Uint8Array {
  if (!containsBinary(msg)) return JSON.stringify(msg);

  const segments: Uint8Array[] = [];
  const header = extractBinary(msg, segments) as object;
  const headerBytes = textEncoder.encode(JSON.stringify(header));

  const bytesTotal = segments.reduce((n, s) => n + s.length, 0);
  const out = new Uint8Array(
    1 + 4 + segments.length * 4 + 4 + headerBytes.length + bytesTotal,
  );
  const view = new DataView(out.buffer);
  let p = 0;
  out[p] = VERSION;
  p += 1;
  view.setUint32(p, segments.length, true);
  p += 4;
  for (const s of segments) {
    view.setUint32(p, s.length, true);
    p += 4;
  }
  view.setUint32(p, headerBytes.length, true);
  p += 4;
  out.set(headerBytes, p);
  p += headerBytes.length;
  for (const s of segments) {
    out.set(s, p);
    p += s.length;
  }
  return out;
}

/**
 * Decode a frame back into `{ ch, data }`. `isBinary` distinguishes the two
 * frame types (on Node a text frame still arrives as a `Buffer`, so the caller
 * passes the `ws` `isBinary` flag; in the browser callers pass
 * `typeof data !== "string"`). Binary placeholders are restored as
 * `Uint8Array` views over the received frame.
 */
export function decodeFrame(
  data: string | ArrayBuffer | Uint8Array,
  isBinary: boolean,
): any {
  if (!isBinary) {
    return JSON.parse(typeof data === "string" ? data : textDecoder.decode(toU8(data)));
  }
  const buf = toU8(data as ArrayBuffer | Uint8Array);
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let p = 1; // skip version
  const segCount = view.getUint32(p, true);
  p += 4;
  const lengths: number[] = [];
  for (let i = 0; i < segCount; i++) {
    lengths.push(view.getUint32(p, true));
    p += 4;
  }
  const headerLen = view.getUint32(p, true);
  p += 4;
  const header = JSON.parse(textDecoder.decode(buf.subarray(p, p + headerLen)));
  p += headerLen;
  const offsets: number[] = [];
  for (const len of lengths) {
    offsets.push(p);
    p += len;
  }
  return restoreBinary(header, buf, offsets, lengths);
}
