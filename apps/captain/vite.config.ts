import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const apiProxyTarget = process.env.CAPTAIN_API_PROXY_TARGET?.trim()
  || "http://127.0.0.1:8080";

export default defineConfig({
  plugins: [react()],
  server: {
    host: "127.0.0.1",
    port: 4178,
    strictPort: true,
    watch: {
      // Native FSEvents can miss edits in this environment; polling keeps HMR alive.
      usePolling: true,
      interval: 300
    },
    proxy: {
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
