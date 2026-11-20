import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Served from https://superphant.github.io/bell/
export default defineConfig({
  base: process.env.BELL_BASE ?? "/bell/",
  plugins: [react()],
  server: { fs: { allow: [".."] } },
  build: { target: "es2022", chunkSizeWarningLimit: 1500 },
});