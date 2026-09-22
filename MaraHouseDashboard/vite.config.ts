// @lovable.dev/vite-tanstack-config already includes the following — do NOT add them manually
// or the app will break with duplicate plugins:
//   - TanStack devtools (dev-only, first), tanstackStart, viteReact, tailwindcss, tsConfigPaths,
//     nitro (build-only using cloudflare as a default target), VITE_* env injection, @ path alias,
//     React/TanStack dedupe, error logger plugins, and sandbox detection (port/host/strictPort).
// You can pass additional config via defineConfig({ vite: { ... }, etc... }) if needed.
import { defineConfig } from "@lovable.dev/vite-tanstack-config";

const LIVE_API = "https://f9nla14lfh.execute-api.eu-central-1.amazonaws.com";

export default defineConfig({
  // Skip Nitro so Vite emits dist/client (Vercel static). SPA still
  // prerenders; pin concurrency because os.cpus().length is 0 in some CI.
  nitro: false,
  tanstackStart: {
    spa: { enabled: true },
    server: { entry: "server" },
    prerender: { concurrency: 1 },
  },
  vite: {
    server: {
      proxy: {
        "/sales": LIVE_API,
        "/health": LIVE_API,
        "/ready": LIVE_API,
        "/version": LIVE_API,
      },
    },
  },
});
