import { describe, it, expect, beforeEach, vi } from "vitest"
import { transformSync } from "@babel/core"
import zenbuAdviceTransform from "./transform/index.js"
import { __def, __ref, replace, unreplace, advise } from "./runtime/index.js"
import { registry } from "./runtime/registry.js"

beforeEach(() => {
  registry.clear()
})

function transform(code: string, filename = "/project/test.ts"): string {
  const result = transformSync(code, {
    filename,
    plugins: [[zenbuAdviceTransform, { root: "/project" }]],
    configFile: false,
    babelrc: false,
  })
  return result?.code ?? ""
}

function evalTransformed(code: string, filename = "/project/test.ts") {
  const output = transform(code, filename)
  const stripped = output.replace(
    /import\s*\{[^}]*\}\s*from\s*["']@zenbu\/advice\/runtime["'];?/,
    ""
  )
  const names = [...stripped.matchAll(/(?:const|let|var|function)\s+(\w+)/g)].map(m => m[1])
    .filter(n => !n.startsWith("__zenbu"))
  const returnExpr = names.length > 0 ? `\nreturn { ${names.join(", ")} };` : ""
  return new Function("__zenbu_def", "__zenbu_ref", stripped + returnExpr)(__def, __ref)
}

// ─── Runtime ────────────────────────────────────────────────────────────────

describe("runtime: __def + __ref", () => {
  it("registers a function and calls it through the wrapper", () => {
    __def("m", "fn", (x: number) => x * 2)
    const fn = __ref("m", "fn") as (x: number) => number
    expect(fn(5)).toBe(10)
  })

  it("second __def replaces the implementation", () => {
    __def("m", "fn", () => "v1")
    const fn = __ref("m", "fn") as () => string
    expect(fn()).toBe("v1")
    __def("m", "fn", () => "v2")
    expect(fn()).toBe("v2")
  })

  it("__ref before __def throws descriptive error", () => {
    const fn = __ref("m", "missing") as () => void
    expect(() => fn()).toThrow("not yet defined")
  })

  it("__ref returns cached wrapper (same reference for same entry)", () => {
    __def("m", "fn", () => 1)
    const a = __ref("m", "fn")
    const b = __ref("m", "fn")
    expect(a).toBe(b)
  })

  it("__def clears wrapper cache (new reference for React Refresh)", () => {
    __def("m", "fn", () => 1)
    const before = __ref("m", "fn")
    __def("m", "fn", () => 2)
    const after = __ref("m", "fn")
    expect(before).not.toBe(after)
  })

  it("both old and new wrappers dispatch to latest impl", () => {
    __def("m", "fn", () => "v1")
    const ref1 = __ref("m", "fn") as () => string
    __def("m", "fn", () => "v2")
    const ref2 = __ref("m", "fn") as () => string
    expect(ref1()).toBe("v2")
    expect(ref2()).toBe("v2")
  })
})

describe("runtime: replace", () => {
  it("swaps the implementation, existing wrapper sees it", () => {
    __def("m", "fn", () => "original")
    const fn = __ref("m", "fn") as () => string
    replace("m", "fn", () => "replaced")
    expect(fn()).toBe("replaced")
  })

  it("works before __def", () => {
    const fn = __ref("m", "fn") as () => string
    replace("m", "fn", () => "pre")
    expect(fn()).toBe("pre")
  })

  it("survives __def (prelude scenario: replace before module loads)", () => {
    replace("m", "fn", () => "plugin-version")
    __def("m", "fn", () => "original")
    const fn = __ref("m", "fn") as () => string
    expect(fn()).toBe("plugin-version")
  })

  it("survives multiple __def calls (HMR with active replacement)", () => {
    replace("m", "fn", () => "plugin-version")
    __def("m", "fn", () => "v1")
    const fn = __ref("m", "fn") as () => string
    expect(fn()).toBe("plugin-version")
    __def("m", "fn", () => "v2")
    expect(fn()).toBe("plugin-version")
  })

  it("latest replace wins", () => {
    __def("m", "fn", () => "original")
    const fn = __ref("m", "fn") as () => string
    replace("m", "fn", () => "first")
    replace("m", "fn", () => "second")
    expect(fn()).toBe("second")
  })

  it("does not clear wrapper cache (stable identity for React Refresh)", () => {
    __def("m", "fn", () => "original")
    const before = __ref("m", "fn")
    replace("m", "fn", () => "replaced")
    const after = __ref("m", "fn")
    expect(before).toBe(after)
  })
})

describe("runtime: unreplace", () => {
  it("restores original implementation", () => {
    __def("m", "fn", () => "original")
    const fn = __ref("m", "fn") as () => string
    replace("m", "fn", () => "replaced")
    expect(fn()).toBe("replaced")
    unreplace("m", "fn")
    expect(fn()).toBe("original")
  })

  it("no-op when no replacement is set", () => {
    __def("m", "fn", () => "original")
    const fn = __ref("m", "fn") as () => string
    unreplace("m", "fn")
    expect(fn()).toBe("original")
  })

  it("no-op on nonexistent entry", () => {
    expect(() => unreplace("m", "nonexistent")).not.toThrow()
  })
})

describe("runtime: advise", () => {
  it("before: runs before original with same args", () => {
    const log: string[] = []
    __def("m", "fn", (x: string) => { log.push(`original:${x}`) })
    const fn = __ref("m", "fn") as (x: string) => void
    advise("m", "fn", "before", (x: string) => { log.push(`before:${x}`) })
    fn("a")
    expect(log).toEqual(["before:a", "original:a"])
  })

  it("after: receives and can transform return value", () => {
    __def("m", "fn", () => 10)
    const fn = __ref("m", "fn") as () => number
    advise("m", "fn", "after", (r: number) => r * 2)
    expect(fn()).toBe(20)
  })

  it("around: receives original, controls invocation", () => {
    __def("m", "fn", (x: number) => x + 1)
    const fn = __ref("m", "fn") as (x: number) => number
    advise("m", "fn", "around", (orig: Function, x: number) => orig(x) * 10)
    expect(fn(5)).toBe(60)
  })

  it("around: can skip calling original", () => {
    __def("m", "fn", () => "original")
    const fn = __ref("m", "fn") as () => string
    advise("m", "fn", "around", () => "intercepted")
    expect(fn()).toBe("intercepted")
  })

  it("around: passes a stable `next` identity across calls (React-Refresh-safe)", () => {
    // Regression: the previous implementation rebuilt the closure
    // stack on every invocation, so `next` was a fresh function
    // identity each call. For around-advice on React components that
    // caused React to unmount + remount the advised subtree on every
    // parent re-render (every keystroke against a CodeMirror Composer
    // rebuilt the EditorView). The chain is now memoized per entry.
    const seen: Function[] = []
    __def("m", "fn", () => 0)
    const fn = __ref("m", "fn") as () => number
    advise("m", "fn", "around", (next: Function) => {
      seen.push(next)
      return next()
    })
    fn(); fn(); fn()
    expect(seen).toHaveLength(3)
    expect(seen[0]).toBe(seen[1])
    expect(seen[1]).toBe(seen[2])
  })

  it("around: `next` identity stays stable across impl swaps (HMR)", () => {
    // impl/replacement changes must NOT bust the chain identity —
    // the chain reads them live via entry.replacement ?? entry.impl.
    const seen: Function[] = []
    __def("m", "fn", () => "v1")
    const fn = __ref("m", "fn") as () => string
    advise("m", "fn", "around", (next: Function) => {
      seen.push(next)
      return next()
    })
    expect(fn()).toBe("v1")
    __def("m", "fn", () => "v2")
    expect(fn()).toBe("v2")
    replace("m", "fn", () => "r1")
    expect(fn()).toBe("r1")
    unreplace("m", "fn")
    expect(fn()).toBe("v2")
    expect(seen).toHaveLength(4)
    expect(new Set(seen).size).toBe(1)
  })

  it("around: `next` identity changes when advice is added or removed", () => {
    // Structural advice changes MUST invalidate the cache, otherwise
    // a newly added before/after/around would never participate.
    const seen: Function[] = []
    __def("m", "fn", () => 0)
    const fn = __ref("m", "fn") as () => number
    advise("m", "fn", "around", (next: Function) => { seen.push(next); return next() })
    fn()
    const remove = advise("m", "fn", "before", () => {})
    fn()
    expect(seen[0]).not.toBe(seen[1])
    remove()
    fn()
    expect(seen[1]).not.toBe(seen[2])
  })

  it("removal function removes just that advice", () => {
    const log: string[] = []
    __def("m", "fn", () => { log.push("orig") })
    const fn = __ref("m", "fn") as () => void
    advise("m", "fn", "before", () => { log.push("a") })
    const remove = advise("m", "fn", "before", () => { log.push("b") })
    fn(); expect(log).toEqual(["a", "b", "orig"])
    log.length = 0
    remove()
    fn(); expect(log).toEqual(["a", "orig"])
  })

  it("advice persists when __def is called again (HMR scenario)", () => {
    __def("m", "fn", () => "v1")
    const fn = __ref("m", "fn") as () => string
    advise("m", "fn", "around", (orig: Function) => `advised(${orig()})`)
    expect(fn()).toBe("advised(v1)")
    __def("m", "fn", () => "v2")
    expect(fn()).toBe("advised(v2)")
  })

  it("mixed: before + after + around compose correctly", () => {
    const log: string[] = []
    __def("m", "fn", () => { log.push("original"); return "result" })
    const fn = __ref("m", "fn") as () => string
    advise("m", "fn", "before", () => { log.push("before") })
    advise("m", "fn", "after", (r: string) => { log.push(`after:${r}`) })
    advise("m", "fn", "around", (orig: Function) => {
      log.push("around-pre"); const r = orig(); log.push("around-post"); return r
    })
    fn()
    expect(log).toEqual(["around-pre", "before", "original", "after:result", "around-post"])
  })

  it("advice wraps replacement when both are active", () => {
    __def("m", "fn", () => "original")
    const fn = __ref("m", "fn") as () => string
    replace("m", "fn", () => "replaced")
    advise("m", "fn", "around", (next: Function) => `advised(${next()})`)
    expect(fn()).toBe("advised(replaced)")
  })

  it("advice on replacement survives __def (prelude + HMR)", () => {
    replace("m", "fn", () => "plugin")
    advise("m", "fn", "around", (next: Function) => `wrapped(${next()})`)
    __def("m", "fn", () => "v1")
    const fn = __ref("m", "fn") as () => string
    expect(fn()).toBe("wrapped(plugin)")
    __def("m", "fn", () => "v2")
    expect(fn()).toBe("wrapped(plugin)")
  })

  it("after unreplace, advice wraps original impl", () => {
    __def("m", "fn", () => "original")
    const fn = __ref("m", "fn") as () => string
    replace("m", "fn", () => "replaced")
    advise("m", "fn", "around", (next: Function) => `advised(${next()})`)
    expect(fn()).toBe("advised(replaced)")
    unreplace("m", "fn")
    expect(fn()).toBe("advised(original)")
  })
})

// ─── Transform snapshots ────────────────────────────────────────────────────

describe("transform: snapshots", () => {
  it("function declaration", () => {
    const out = transform(`function foo() { return 1 }`)
    expect(out).toMatchSnapshot()
    expect(out).toContain('__zenbu_def("test.ts", "foo"')
  })

  it("async function", () => {
    expect(transform(`async function fetchData() { return 1 }`)).toMatchSnapshot()
  })

  it("generator function", () => {
    expect(transform(`function* gen() { yield 1 }`)).toMatchSnapshot()
  })

  it("const arrow", () => {
    const out = transform(`const foo = () => 42`)
    expect(out).toMatchSnapshot()
    expect(out).toContain("__zenbu_def")
  })

  it("let arrow", () => {
    expect(transform(`let foo = () => "hello"`)).toContain("let foo")
  })

  it("function expression", () => {
    expect(transform(`const foo = function() { return 1 }`)).toContain("__zenbu_def")
  })

  it("export named function", () => {
    const out = transform(`export function foo() { return 1 }`)
    expect(out).toContain("export")
    expect(out).toContain("__zenbu_def")
  })

  it("export default function (named)", () => {
    expect(transform(`export default function Foo() { return 1 }`)).toContain("export default")
  })

  it("export default function (anonymous)", () => {
    expect(transform(`export default function() { return 1 }`)).toContain("export default")
  })

  it("export const arrow", () => {
    expect(transform(`export const foo = () => 42`)).toContain("export")
  })

  it("file with no functions: no transform", () => {
    const out = transform(`const x = 42`)
    expect(out).not.toContain("__zenbu_def")
    expect(out).not.toContain("@zenbu/advice")
  })

  it("module ID is relative to root", () => {
    expect(transform(`function f() {}`, "/project/src/lib/auth.ts")).toContain('"src/lib/auth.ts"')
  })

  it("PascalCase function emits function declaration (not const) for React Refresh", () => {
    const out = transform(`function App() { return 1 }`)
    expect(out).toMatch(/function App\(/)
    expect(out).not.toMatch(/const App\s*=/)
  })

  it("lowercase function emits const assignment", () => {
    const out = transform(`function helper() { return 1 }`)
    expect(out).toMatch(/const helper\s*=/)
  })

  it("nested functions are NOT transformed (only top-level)", () => {
    const out = transform(`
function outer() {
  const inner = () => 42
  function nested() { return 1 }
  return inner() + nested()
}
`)
    expect(out).toContain('__zenbu_def("test.ts", "outer"')
    expect(out).not.toContain('"inner"')
    expect(out).not.toContain('"nested"')
  })

  it("does not transform $-prefixed or _-prefixed variables (React Refresh internals)", () => {
    const out = transform(`
const $RefreshReg$ = (type, id) => {}
const $RefreshSig$ = () => (type) => type
const _c = Component
var _s = $RefreshSig$()
`)
    expect(out).not.toContain('__zenbu_def')
    expect(out).not.toContain('__zenbu_ref')
  })

  it("simulated React plugin output: $RefreshReg$/$RefreshSig$ at bottom are not transformed", () => {
    // Guard the variant where refresh helpers exist as const function expressions.
    // Our transform must not touch them either.
    const reactPluginOutput = `
import { jsxDEV } from "react/jsx-dev-runtime";
var _s = $RefreshSig$();
function TitleBar() {
  _s();
  return jsxDEV("div", {}, void 0, false, {}, this);
}
_s(TitleBar, "abc123");
var _c;
_c = TitleBar;
$RefreshReg$(_c, "TitleBar");
import * as RefreshRuntime from "/@react-refresh";
const $RefreshReg$ = function(type, id) {
  return RefreshRuntime.register(type, "TitleBar.tsx " + id);
};
const $RefreshSig$ = function() {
  return RefreshRuntime.createSignatureFunctionForTransform();
};
`
    const out = transform(reactPluginOutput)
    // $RefreshReg$ and $RefreshSig$ must NOT be wrapped in __zenbu_def/__zenbu_ref
    expect(out).not.toContain('__zenbu_def("test.ts", "$RefreshReg$"')
    expect(out).not.toContain('__zenbu_def("test.ts", "$RefreshSig$"')
    // But TitleBar SHOULD be transformed (it's a real component)
    expect(out).toContain('__zenbu_def("test.ts", "TitleBar"')
  })

  it("does not transform React Refresh helper function declarations", () => {
    const reactPluginOutput = `
import { jsxDEV } from "react/jsx-dev-runtime";
var _s = $RefreshSig$();
function TitleBar() {
  _s();
  return jsxDEV("div", {}, void 0, false, {}, this);
}
_s(TitleBar, "abc123");
var _c;
_c = TitleBar;
$RefreshReg$(_c, "TitleBar");
import * as RefreshRuntime from "/@react-refresh";
function $RefreshReg$(type, id) {
  return RefreshRuntime.register(type, "TitleBar.tsx " + id);
}
function $RefreshSig$() {
  return RefreshRuntime.createSignatureFunctionForTransform();
}
`
    const out = transform(reactPluginOutput)
    expect(out).not.toContain('__zenbu_def("test.ts", "$RefreshReg$"')
    expect(out).not.toContain('__zenbu_def("test.ts", "$RefreshSig$"')
    expect(out).not.toContain('const $RefreshReg$ = __zenbu_ref')
    expect(out).not.toContain('const $RefreshSig$ = __zenbu_ref')
    expect(out).toContain("function $RefreshReg$(")
    expect(out).toContain("function $RefreshSig$(")
    expect(out).toContain('__zenbu_def("test.ts", "TitleBar"')
  })

  it("same-name variables in different scopes dont collide", () => {
    const out = transform(`
function setup() {
  const handler = (e) => e.data
  const handler2 = (e) => e.type
  return { handler, handler2 }
}
`)
    expect(out).toContain('__zenbu_def("test.ts", "setup"')
    expect(out).not.toContain('__zenbu_def("test.ts", "handler"')
  })
})

// ─── Transform execution ────────────────────────────────────────────────────

describe("transform: execution", () => {
  it("transformed function works", () => {
    const { add } = evalTransformed(`function add(a, b) { return a + b }`)
    expect(add(2, 3)).toBe(5)
  })

  it("replace works on transformed function", () => {
    const { greet } = evalTransformed(`function greet(name) { return "hello " + name }`)
    expect(greet("world")).toBe("hello world")
    replace("test.ts", "greet", (name: string) => `bye ${name}`)
    expect(greet("world")).toBe("bye world")
  })

  it("advise works on transformed function", () => {
    const { compute } = evalTransformed(`function compute(x) { return x * 2 }`)
    advise("test.ts", "compute", "around", (orig: Function, x: number) => orig(x) + 100)
    expect(compute(5)).toBe(110)
  })

  it("async function works after transform", async () => {
    const { fetchValue } = evalTransformed(`async function fetchValue() { return 42 }`)
    expect(await fetchValue()).toBe(42)
  })

  it("multiple PascalCase functions in one file: no infinite recursion", () => {
    const result = evalTransformed(`
function Inner() { return "inner" }
function Outer() { return Inner() }
`)
    expect(result.Outer()).toBe("inner")
  })

  it("function calling another transformed function: no stack overflow", () => {
    const result = evalTransformed(`
function helper(x) { return x * 2 }
function compute(x) { return helper(x) + 1 }
`)
    expect(result.compute(5)).toBe(11)
  })

  it("nested functions inside a top-level function are left untransformed", () => {
    const out = transform(`
function createStuff() {
  function Inner() { return "inner" }
  const handler = () => 42
  return { Inner, handler }
}
`)
    expect(out).toContain('__zenbu_def("test.ts", "createStuff"')
    expect(out).not.toContain('"Inner"')
    expect(out).not.toContain('"handler"')
  })

  it("self-referencing function (recursive): terminates correctly", () => {
    const result = evalTransformed(`
function factorial(n) { return n <= 1 ? 1 : n * factorial(n - 1) }
`)
    expect(result.factorial(5)).toBe(120)
  })

  it("HMR simulation: re-eval updates impl, advice persists", () => {
    evalTransformed(`function greet() { return "v1" }`, "/project/mod.ts")
    const greet1 = __ref("mod.ts", "greet") as () => string
    advise("mod.ts", "greet", "around", (orig: Function) => `advised(${orig()})`)
    expect(greet1()).toBe("advised(v1)")

    evalTransformed(`function greet() { return "v2" }`, "/project/mod.ts")
    expect(greet1()).toBe("advised(v2)")
  })

  it("prelude simulation: replace before transform, replacement survives module eval", () => {
    replace("mod.ts", "greet", (name: string) => `plugin hello ${name}`)
    evalTransformed(`function greet(name) { return "hello " + name }`, "/project/mod.ts")
    const greet = __ref("mod.ts", "greet") as (name: string) => string
    expect(greet("world")).toBe("plugin hello world")
  })

  it("prelude simulation: replace survives HMR after module eval", () => {
    replace("mod.ts", "Header", () => "PluginHeader")
    evalTransformed(`function Header() { return "OriginalHeader" }`, "/project/mod.ts")
    const Header = __ref("mod.ts", "Header") as () => string
    expect(Header()).toBe("PluginHeader")

    evalTransformed(`function Header() { return "OriginalHeaderV2" }`, "/project/mod.ts")
    expect(Header()).toBe("PluginHeader")
  })

  it("prelude simulation: unreplace after module eval restores original", () => {
    replace("mod.ts", "render", () => "plugin-render")
    evalTransformed(`function render() { return "original-render" }`, "/project/mod.ts")
    const render = __ref("mod.ts", "render") as () => string
    expect(render()).toBe("plugin-render")
    unreplace("mod.ts", "render")
    expect(render()).toBe("original-render")
  })
})

// ─── short moduleId detection ───────────────────────────────────────────────

describe("runtime: short moduleId detection", () => {
  it("short moduleId does NOT match full path — advice stays on the short key", () => {
    replace("home.tsx", "Home", () => "replaced")
    __def("components/home.tsx", "Home", () => "original")
    const fn = __ref("components/home.tsx", "Home") as () => string
    expect(fn()).toBe("original")
  })

  it("short moduleId: logs an error pointing at the full path", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {})
    replace("home.tsx", "Home", () => "replaced")
    __def("components/home.tsx", "Home", () => "original")
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining('short moduleId "home.tsx"'),
    )
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining('"components/home.tsx"'),
    )
    error.mockRestore()
  })

  it("full-path moduleId: no error", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {})
    replace("components/home.tsx", "Home", () => "replaced")
    __def("components/home.tsx", "Home", () => "original")
    const fn = __ref("components/home.tsx", "Home") as () => string
    expect(fn()).toBe("replaced")
    expect(error).not.toHaveBeenCalled()
    error.mockRestore()
  })

  it("short moduleId matching two files: errors on each registration", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {})
    replace("home.tsx", "Home", () => "replaced")
    __def("components/home.tsx", "Home", () => "from-components")
    __def("views/home.tsx", "Home", () => "from-views")
    expect(error).toHaveBeenCalledWith(expect.stringContaining("components/home.tsx"))
    expect(error).toHaveBeenCalledWith(expect.stringContaining("views/home.tsx"))
    error.mockRestore()
  })
})
