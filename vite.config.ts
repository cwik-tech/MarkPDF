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
          src: "node_modules/pdfjs-dist/cmaps/**/*",
          dest: "pdfjs/cmaps",
          rename: { stripBase: true }
        },
        {
          src: "node_modules/pdfjs-dist/standard_fonts/**/*",
          dest: "pdfjs/standard_fonts",
          rename: { stripBase: true }
        },
        {
          src: "node_modules/pdfjs-dist/wasm/**/*",
          dest: "pdfjs/wasm",
          rename: { stripBase: true }
        },
        {
          src: "node_modules/tesseract.js/dist/worker.min.js",
          dest: "tesseract",
          rename: { stripBase: true }
        },
        {
          src: "node_modules/tesseract.js-core/*",
          dest: "tesseract-core",
          rename: { stripBase: true }
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
