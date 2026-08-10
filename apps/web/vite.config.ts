import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const webRoot = dirname(fileURLToPath(import.meta.url));
const apiProxyTarget = process.env.CAPTAIN_API_PROXY_TARGET?.trim()
  || "http://127.0.0.1:8080";

export default defineConfig({
  root: webRoot,
  plugins: [react()],
  // Surfaced to the client so mock-mode can avoid forcing `#access=design`
  // when this Vite process is proxying `/api` at a remote Captain.
  define: {
    "import.meta.env.VITE_CAPTAIN_API_PROXY_TARGET": JSON.stringify(apiProxyTarget)
  },
  // Captain serves static assets from apps/captain/dist at runtime.
  build: {
    outDir: resolve(webRoot, "../captain/dist"),
    emptyOutDir: true
  },
  server: {
    host: "127.0.0.1",
    port: 4178,
    strictPort: true,
    watch: {
      // Native FSEvents can miss edits in this environment; polling keeps HMR alive.
      usePolling: true,
      interval: 300,
      ignored: ["**/node_modules/**"]
    },
    proxy: {
      // /auth/link exchanges one-time login tokens for the session cookie.
      "/auth": {
        target: apiProxyTarget,
        changeOrigin: true
      },
      "/api": {
        target: apiProxyTarget,
        changeOrigin: true,
        // Prod mutations require Origin === CAPTAIN_PUBLIC_URL. When the UI is on
        // localhost and /api is proxied to prod, rewrite Origin so refresh/etc work.
        configure: (proxy) => {
          proxy.on("proxyReq", (proxyReq) => {
            try {
              proxyReq.setHeader("origin", new URL(apiProxyTarget).origin);
            } catch {
              // leave Origin unchanged if the proxy target is not a valid URL
            }
          });
        }
      }
    }
  },
  preview: {
    host: "127.0.0.1",
    port: 4178,
    strictPort: true
  }
});
