import type { PluginObj, PluginPass, NodePath } from "@babel/core"
import type * as BabelTypes from "@babel/types"

interface AdvicePluginOptions {
  root?: string
}

interface AdvicePluginState extends PluginPass {
  moduleId: string
  needsImport: boolean
  /**
   * `__zenbu_def(...)` registrations collected during traversal and
   * emitted at the TOP of the module (Program exit). Function
   * declarations hoist in plain JS — a module-scope statement may call
   * one before its source position. The wrapper declaration we emit
   * hoists too, but it dispatches through the registry, so the
   * registration itself must also run before any module-scope
   * statement or the call would find no implementation. Hoisting the
   * def is safe: it only *creates* a closure (the body doesn't run),
   * exactly like native hoisting.
   */
  hoistedDefs: BabelTypes.Statement[]
}

function isReactRefreshHelperName(name: string): boolean {
  return name === "$RefreshReg$" || name === "$RefreshSig$"
}

function isTopLevel(path: NodePath<any>): boolean {
  let current = path.parentPath
  while (current) {
    if (current.isFunction() || current.isClassBody()) return false
    if (current.isProgram()) return true
    if (current.isExportNamedDeclaration() || current.isExportDefaultDeclaration()) {
      current = current.parentPath
      continue
    }
    current = current.parentPath
  }
  return true
}

export default function zenbuAdviceTransform(
  { types: t }: { types: typeof BabelTypes },
  options: AdvicePluginOptions = {}
): PluginObj<AdvicePluginState> {
  const root = options.root ?? process.cwd()

  function makeModuleId(filename: string | undefined | null): string {
    if (!filename) return "unknown"
    const normalized = filename.replace(/\\/g, "/")
    const rootNormalized = root.replace(/\\/g, "/").replace(/\/$/, "")
    if (normalized.startsWith(rootNormalized + "/")) {
      return normalized.slice(rootNormalized.length + 1)
    }
    return normalized
  }

  function defCall(state: AdvicePluginState, name: string, fn: BabelTypes.Expression): BabelTypes.ExpressionStatement {
    state.needsImport = true
    return t.expressionStatement(
      t.callExpression(t.identifier("__zenbu_def"), [
        t.stringLiteral(state.moduleId),
        t.stringLiteral(name),
        fn,
      ])
    )
  }

  function refCall(state: AdvicePluginState, name: string): BabelTypes.CallExpression {
    state.needsImport = true
    return t.callExpression(t.identifier("__zenbu_ref"), [
      t.stringLiteral(state.moduleId),
      t.stringLiteral(name),
    ])
  }

  /**
   * Hoisted replacement for a top-level `function name() {}`: a
   * function DECLARATION (so the binding hoists like the original did)
   * that dispatches through the advice chain. Used for every named
   * top-level function, component or not — a `const name = __ref(...)`
   * would turn hoisting into a TDZ crash for any module that calls the
   * function above its declaration, and would report `.name` as the
   * registry wrapper's instead of the function's own.
   */
  function wrapperFnDecl(state: AdvicePluginState, name: string): BabelTypes.FunctionDeclaration {
    const wrapperFn = t.functionDeclaration(
      t.identifier(name),
      [t.restElement(t.identifier("__args"))],
      t.blockStatement([
        t.returnStatement(
          t.callExpression(
            t.memberExpression(refCall(state, name), t.identifier("apply")),
            [t.thisExpression(), t.identifier("__args")]
          )
        ),
      ])
    );
    (wrapperFn as any)._zenbuGenerated = true
    return wrapperFn
  }

  return {
    name: "zenbu-advice",
    visitor: {
      Program: {
        enter(path: NodePath<BabelTypes.Program>, state: AdvicePluginState) {
          state.moduleId = makeModuleId(state.filename)
          state.needsImport = false
          state.hoistedDefs = []
        },
        exit(path: NodePath<BabelTypes.Program>, state: AdvicePluginState) {
          if (state.hoistedDefs.length > 0) {
            path.unshiftContainer("body", state.hoistedDefs)
          }
          if (!state.needsImport) return
          const importDecl = t.importDeclaration(
            [
              t.importSpecifier(t.identifier("__zenbu_def"), t.identifier("__def")),
              t.importSpecifier(t.identifier("__zenbu_ref"), t.identifier("__ref")),
            ],
            t.stringLiteral("@zenbu/advice/runtime")
          )
          path.unshiftContainer("body", importDecl)
        },
      },

      FunctionDeclaration(path: NodePath<BabelTypes.FunctionDeclaration>, state: AdvicePluginState) {
        if (!path.node.id) return
        if (path.parentPath.isExportDefaultDeclaration()) return
        if ((path.node as any)._zenbuGenerated) return
        if (!isTopLevel(path)) return

        const name = path.node.id.name
        if (isReactRefreshHelperName(name)) return
        const fnExpr = t.functionExpression(
          null,
          path.node.params,
          path.node.body,
          path.node.generator,
          path.node.async
        )

        // Same shape for components and helpers: hoisted def + hoisted
        // wrapper declaration. Both halves of native function hoisting
        // are preserved — the binding exists early (wrapper declaration
        // hoists) AND calling it early works (def runs before any other
        // module-scope statement).
        state.hoistedDefs.push(defCall(state, name, fnExpr))
        const wrapperFn = wrapperFnDecl(state, name)

        if (path.parentPath.isExportNamedDeclaration()) {
          path.parentPath.replaceWith(t.exportNamedDeclaration(wrapperFn, []))
        } else {
          path.replaceWith(wrapperFn)
        }
      },

      ExportDefaultDeclaration(path: NodePath<BabelTypes.ExportDefaultDeclaration>, state: AdvicePluginState) {
        const decl = path.node.declaration
        if (!t.isFunctionDeclaration(decl)) return
        if ((decl as any)._zenbuGenerated) return

        const name = decl.id?.name ?? "default"
        const fnExpr = t.functionExpression(
          null,
          decl.params,
          decl.body,
          decl.generator,
          decl.async
        )

        if (decl.id) {
          // `export default function foo() {}` declares a hoisted local
          // binding `foo` alongside the default export. Keep BOTH: the
          // old non-component path here dropped the local binding
          // entirely, breaking any later in-module reference to it.
          state.hoistedDefs.push(defCall(state, name, fnExpr))
          path.replaceWith(t.exportDefaultDeclaration(wrapperFnDecl(state, name)))
        } else {
          // Anonymous default: no local binding to hoist, so the const
          // indirection is semantics-preserving (modulo circular-import
          // access before evaluation, which the original allows and we
          // don't — accepted edge).
          const def = defCall(state, name, fnExpr)
          const varDecl = t.variableDeclaration("const", [
            t.variableDeclarator(t.identifier("__zenbu_default"), refCall(state, name)),
          ])
          path.replaceWithMultiple([def, varDecl, t.exportDefaultDeclaration(t.identifier("__zenbu_default"))])
        }
      },

      VariableDeclarator(path: NodePath<BabelTypes.VariableDeclarator>, state: AdvicePluginState) {
        if (!t.isIdentifier(path.node.id)) return
        if (isReactRefreshHelperName(path.node.id.name)) return
        const init = path.node.init
        if (!init) return
        if (!t.isArrowFunctionExpression(init) && !t.isFunctionExpression(init)) return

        const parentPath = path.parentPath
        if (!parentPath.isVariableDeclaration()) return
        if (parentPath.node.declarations.length !== 1) return
        if (!isTopLevel(parentPath)) return

        const name = path.node.id.name
        const def = defCall(state, name, init)
        const newDeclarator = t.variableDeclarator(
          t.identifier(name),
          refCall(state, name)
        )

        const grandParent = parentPath.parentPath
        if (grandParent && grandParent.isExportNamedDeclaration()) {
          const newVarDecl = t.variableDeclaration(parentPath.node.kind, [newDeclarator])
          grandParent.replaceWithMultiple([
            def,
            t.exportNamedDeclaration(newVarDecl, []),
          ])
        } else {
          const newVarDecl = t.variableDeclaration(parentPath.node.kind, [newDeclarator])
          parentPath.replaceWithMultiple([def, newVarDecl])
        }
      },
    },
  }
}
