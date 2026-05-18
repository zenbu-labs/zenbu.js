import zod from "zod";
import { createSchema, f, type InferSchemaRoot } from "@zenbu/kyju/schema";

/**
 * Window-positioning prefs are the only thing that genuinely belongs on
 * disk: they need to survive a process crash so the next launch reopens
 * windows where the user left them. Transient service state (view
 * registry, server status, etc.) lives in service in-memory `state(...)`
 * cells — see `@zenbujs/core/runtime`'s `state` primitive.
 */
const windowBoundsSchema = zod.object({
  x: zod.number(),
  y: zod.number(),
  width: zod.number(),
  height: zod.number(),
});

const windowPrefsSchema = zod.object({
  lastKnownBounds: windowBoundsSchema.optional(),
});

const schema = createSchema({
  windowPrefs: f.record(zod.string(), windowPrefsSchema).default({}),
});

export default schema;
export { schema };

export type WindowBounds = zod.infer<typeof windowBoundsSchema>;
export type WindowPrefs = zod.infer<typeof windowPrefsSchema>;
export type SchemaRoot = InferSchemaRoot<typeof schema>;
export type CoreSchema = typeof schema.shape;
