import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import type { Ack, ClientState, KyjuJSON } from "../shared";

type PendingRequest = {
  requestId: string;
  resolve: (ack: Ack<any, any>) => void;
};

export const makeRequestAwaiter = () => {
  const pending = new Map<string, PendingRequest>();

  return {
    resolve: (ack: Ack<any, any>) => {
      const entry = pending.get(ack.requestId);
      if (entry) {
        pending.delete(ack.requestId);
        entry.resolve(ack);
      }
    },
    await: <T extends Ack<any, any>>(requestId: string): Promise<T> =>
      new Promise<T>((resolve) => {
        pending.set(requestId, {
          requestId,
          resolve: resolve as (ack: Ack<any, any>) => void,
        });
      }),
  };
};

const isIndexKey = (s: string | undefined): boolean =>
  typeof s === "string" && s.length > 0 && /^\d+$/.test(s);


export const setAtPath = ({
  root,
  path,
  value,
}: {
  root: KyjuJSON;
  path: string[];
  value: KyjuJSON;
}): KyjuJSON => {
  if (path.length === 0) return value;

  // Coerce the top-level container to match the first segment if
  // needed (same as the old behavior).
  let topSource: KyjuJSON = root;
  const firstIsIndex = isIndexKey(path[0]);
  if (typeof topSource !== "object" || topSource === null) {
    topSource = firstIsIndex ? [] : {};
  }

  // Build the chain of cloned containers as we descend.
  const clones: KyjuJSON[] = [];
  const topClone: KyjuJSON = Array.isArray(topSource)
    ? [...(topSource as KyjuJSON[])]
    : { ...(topSource as Record<string, KyjuJSON>) };
  clones.push(topClone);

  for (let i = 0; i < path.length - 1; i++) {
    const seg = path[i]!;
    const nextSeg = path[i + 1]!;
    const nextIsIndex = isIndexKey(nextSeg);
    const parent = clones[i]!;

    let child: KyjuJSON | undefined;
    if (Array.isArray(parent)) {
      child = (parent as KyjuJSON[])[Number(seg)];
    } else {
      child = (parent as Record<string, KyjuJSON>)[seg];
    }
    if (child === undefined || child === null || typeof child !== "object") {
      child = nextIsIndex ? [] : {};
    }
    const childClone: KyjuJSON = Array.isArray(child)
      ? [...(child as KyjuJSON[])]
      : { ...(child as Record<string, KyjuJSON>) };
    clones.push(childClone);
  }

  // Write the leaf into the deepest clone.
  const lastSeg = path[path.length - 1]!;
  const deepest = clones[clones.length - 1]!;
  if (Array.isArray(deepest)) {
    (deepest as KyjuJSON[])[Number(lastSeg)] = value;
  } else {
    (deepest as Record<string, KyjuJSON>)[lastSeg] = value;
  }

  // Stitch parents to point at the cloned children.
  for (let i = clones.length - 2; i >= 0; i--) {
    const parent = clones[i]!;
    const child = clones[i + 1]!;
    const seg = path[i]!;
    if (Array.isArray(parent)) {
      (parent as KyjuJSON[])[Number(seg)] = child;
    } else {
      (parent as Record<string, KyjuJSON>)[seg] = child;
    }
  }

  return topClone;
};

export type ConnectedState = Extract<ClientState, { kind: "connected" }>;

export const requireConnected = ({ ref }: { ref: Ref.Ref<ClientState> }) =>
  Effect.gen(function* () {
    const state = yield* Ref.get(ref);
    if (state.kind === "disconnected") {
      return yield* Effect.die("Cannot process event: not connected");
    }
    return state;
  });

export const applyState = ({
  ref,
  fn,
}: {
  ref: Ref.Ref<ClientState>;
  fn: (state: ConnectedState) => ConnectedState;
}) =>
  Ref.update(ref, (current) => {
    if (current.kind === "disconnected") return current;
    return fn(current);
  });
