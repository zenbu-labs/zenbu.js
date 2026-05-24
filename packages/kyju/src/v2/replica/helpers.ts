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

/**
 * Counterpart to `setAtPath`: remove the leaf at `path` from `root`,
 * cloning intermediate containers so React subscribers see a fresh
 * reference all the way down (same identity contract as `setAtPath`).
 *
 * - If any intermediate segment doesn't exist, the delete is a no-op
 *   and the original `root` is returned unchanged (no spurious clones).
 * - Empty `path` is a no-op — "delete the whole root" has no sensible
 *   semantics; callers wanting that should set the root to `{}`/`[]`.
 * - Array index deletes use `splice` so we don't leave sparse holes.
 */
export const deleteAtPath = ({
  root,
  path,
}: {
  root: KyjuJSON;
  path: string[];
}): KyjuJSON => {
  if (path.length === 0) return root;
  if (typeof root !== "object" || root === null) return root;

  // Walk to check the path actually leads somewhere. If any step is
  // missing we have nothing to delete — return the original root so
  // subscribers don't see a no-op re-render.
  let cursor: KyjuJSON = root;
  for (let i = 0; i < path.length - 1; i++) {
    const seg = path[i]!;
    if (Array.isArray(cursor)) {
      const child = (cursor as KyjuJSON[])[Number(seg)];
      if (child === undefined || child === null || typeof child !== "object")
        return root;
      cursor = child;
    } else {
      const child = (cursor as Record<string, KyjuJSON>)[seg];
      if (child === undefined || child === null || typeof child !== "object")
        return root;
      cursor = child;
    }
  }
  const lastSeg = path[path.length - 1]!;
  if (Array.isArray(cursor)) {
    if (Number(lastSeg) >= (cursor as KyjuJSON[]).length) return root;
  } else if (
    !Object.prototype.hasOwnProperty.call(
      cursor as Record<string, KyjuJSON>,
      lastSeg,
    )
  ) {
    return root;
  }

  // Now clone the chain and apply the delete on the deepest clone.
  const clones: KyjuJSON[] = [];
  const topClone: KyjuJSON = Array.isArray(root)
    ? [...(root as KyjuJSON[])]
    : { ...(root as Record<string, KyjuJSON>) };
  clones.push(topClone);
  for (let i = 0; i < path.length - 1; i++) {
    const seg = path[i]!;
    const parent = clones[i]!;
    const child = Array.isArray(parent)
      ? (parent as KyjuJSON[])[Number(seg)]!
      : (parent as Record<string, KyjuJSON>)[seg]!;
    const childClone: KyjuJSON = Array.isArray(child)
      ? [...(child as KyjuJSON[])]
      : { ...(child as Record<string, KyjuJSON>) };
    clones.push(childClone);
  }
  const deepest = clones[clones.length - 1]!;
  if (Array.isArray(deepest)) {
    (deepest as KyjuJSON[]).splice(Number(lastSeg), 1);
  } else {
    delete (deepest as Record<string, KyjuJSON>)[lastSeg];
  }
  // Stitch parents to point at cloned children.
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
