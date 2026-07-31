/**
 * WORKAROUND for eve@0.25.3 on Windows: the dev-host builder resolves eve's
 * internal `src/internal/authored-module-map-loader.ts` against the nearest
 * package root — which is THIS project, not the installed eve package —
 * because `resolvePackageBuildRoot()` fails to detect the `dist` build root
 * from the bundled dev-host context. Without this file, every
 * `POST /eve/v1/session` fails with ERR_MODULE_NOT_FOUND.
 *
 * This shim simply re-exports the real module from the installed package.
 * The re-exported file's own `#compiler/...` package-imports still resolve
 * against eve's package.json, so behavior is identical.
 *
 * The same shim exists in ../../knowledge-base-agent for the same reason.
 * Remove once eve fixes the resolution (try deleting this file after any
 * `eve` upgrade and re-testing `POST /eve/v1/session`).
 */
export * from "../../node_modules/eve/dist/src/internal/authored-module-map-loader.js";
