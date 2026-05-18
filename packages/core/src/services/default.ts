/**
 * parallelize? i forgor is it serial no matter what?
 */
export async function defaultServices(): Promise<void> {
  await import("./server");
  await import("./reloader");
  await import("./renderer-host");
  await import("./http");
  await import("./db");
  await import("./base-window");
  await import("./rpc");
  await import("./state");
  await import("./view-registry");
  await import("./window");
  await import("./advice-config");
  await import("./updater");
}
