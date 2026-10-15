/**
 * Lets Node load the chat kit's route files (`packages/agent-api/src/mastra`, installed from the
 * kit's registry), which import their siblings without a file extension (`'./resource'`), as a
 * bundler allows but Node's own ESM loader does not. A relative import with no extension that
 * Node can't find is tried again with `.ts`; if that fails too, the original error is thrown. The
 * hook is process-wide but only acts after a resolve has already failed. Preloaded before the
 * server:
 *   node --import ./src/extensionless.ts src/server.ts
 */
import { registerHooks } from "node:module";

registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context);
    } catch (error) {
      const relative = specifier.startsWith("./") || specifier.startsWith("../");
      const notFound = (error as { code?: string }).code === "ERR_MODULE_NOT_FOUND";
      if (!relative || !notFound || /\.[cm]?[jt]sx?$/.test(specifier)) throw error;
      try {
        return nextResolve(`${specifier}.ts`, context);
      } catch {
        throw error;
      }
    }
  },
});
