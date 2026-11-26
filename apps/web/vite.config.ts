import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath } from "node:url";

export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  plugins: [vue(), tailwindcss()],
  build: { outDir: "../../dist/web", emptyOutDir: true },
  server: { proxy: { "/api": "http://localhost:8787" } },
});
