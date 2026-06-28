import { defineConfig } from "tsup";

// Bundle the workspace protocol into the daemon so the built dist runs under plain Node ESM
// (the protocol's compiled output uses extensionless imports meant for a bundler). libp2p and
// other npm deps stay external and load from node_modules as usual.
export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  target: "node20",
  clean: true,
  // bundle everything (libp2p, the protocol, all deps) into one self contained file, so the packaged
  // desktop app can run the core without a node_modules folder beside it. Exclude the optional native
  // engine, which stays external and is dynamically imported at runtime.
  noExternal: [/^(?!node-llama-cpp).+/],
  // the inference engine is optional and installed only by miners; keep it external so the dynamic
  // import resolves at runtime (and is caught when absent) rather than failing the bundle.
  external: ["node-llama-cpp"],
  splitting: false,
  sourcemap: false,
  platform: "node",
  // some bundled dependencies use CommonJS require() internally. In an ESM bundle, provide a real
  // require via createRequire so those dynamic requires (of Node builtins, etc.) work at runtime.
  banner: { js: "import { createRequire as __cr } from 'module'; const require = __cr(import.meta.url);" },
  // mark the bundle as ESM with a package.json so it runs as a module even when copied out of the
  // workspace (for example into the packaged desktop app's resources/core, which has no parent).
  onSuccess: async () => {
    const { writeFileSync } = await import("node:fs");
    writeFileSync("dist/package.json", JSON.stringify({ type: "module" }) + "\n");
  },
});
