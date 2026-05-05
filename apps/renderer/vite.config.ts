import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5174,
    /**
     * SPA fallback for /d/{slug} URLs — Vite serves index.html for any
     * non-asset path so the in-page router (spec-source.ts) can read the slug.
     */
    middlewareMode: false,
  },
  preview: {
    port: 5174,
  },
});
