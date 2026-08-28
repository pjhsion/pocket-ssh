import { defineConfig } from "vite";

export default defineConfig({
  root: ".",
  build: {
    outDir: "dist-web",
  },
  server: {
    proxy: {
      "/api": {
        target: "http://127.0.0.1:8790",
        changeOrigin: true,
      },
      "/ws": {
        target: "http://127.0.0.1:8790",
        ws: true,
      },
    },
  },
});
