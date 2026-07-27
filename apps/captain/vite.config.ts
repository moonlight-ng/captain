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
    proxy: {
      "/api": {
        target: apiProxyTarget,
        changeOrigin: true
      }
    }
  },
  preview: {
    host: "127.0.0.1",
    port: 4178,
    strictPort: true
  }
});
