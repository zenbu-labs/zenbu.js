export type {
  AdviceSpec,
  ContentScriptSpec,
  ComponentViewSpec,
  ComponentViewEntry,
  FunctionSourceSpec,
  FunctionSourceEntry,
  ViewAdviceEntry,
} from "./services/advice-config";

export {
  getAdvice,
  getAllAdviceTypes,
  getContentScripts,
  getAllContentScriptPaths,
  getComponentViews,
  getAllComponentViewPaths,
  getFunctionSources,
  getAllFunctionSourcePaths,
  getAllTypes,
} from "./services/advice-config";
