import react from "@vitejs/plugin-react";
import { viteStaticCopy } from "vite-plugin-static-copy";
import { defineConfig } from "vite";

export default defineConfig({
  base: "./",
  plugins: [
    react(),
    viteStaticCopy({
      targets: [
        {
          src: "node_modules/pdfjs-dist/cmaps",
          dest: "pdfjs"
        },
        {
          src: "node_modules/pdfjs-dist/standard_fonts",
          dest: "pdfjs"
        },
        {
          src: "node_modules/pdfjs-dist/wasm",
          dest: "pdfjs"
        }
      ]
    })
  ],
  server: {
    host: "127.0.0.1",
    port: 5173,
    strictPort: true
  },
  build: {
    outDir: "dist",
    emptyOutDir: true
  }
});
