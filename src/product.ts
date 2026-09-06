/** Independent Product Cordis row and terminal-owning lifecycle surface. */
export {
  apply,
  consumeProductTask,
  createDshTuiProductEnvironment,
  inject,
  mountDshTuiProduct,
  name,
  provide,
} from './composition/product-plugin.ts'
export type {
  DshTuiProductEnvironment,
  DshTuiProductEnvironmentOverrides,
  DshTuiProductMount,
  DshTuiProductMountDependencies,
  DshTuiProductMountOptions,
  DshTuiProductTerminalOptions,
  ProductCmdlineArgs,
} from './composition/product-plugin.ts'
export {
  DshTuiProductRunner,
  sanitizeDshTuiProductError,
} from './app/runner.ts'
export type {
  DshTuiControllerPort,
  DshTuiOpenRequest,
  DshTuiProductRunnerOptions,
  DshTuiStartupRequest,
} from './app/runner.ts'
