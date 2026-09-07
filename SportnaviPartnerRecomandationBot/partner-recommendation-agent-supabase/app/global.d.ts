// Ambient module declaration for plain CSS side-effect imports (e.g.
// `import "./globals.css"` in app/layout.tsx). tsc and Next.js need this to
// resolve global (non-module) CSS side-effect imports; Next's own shipped
// types only cover `*.module.css`.
declare module "*.css";
