# Third-Party Notices

This file summarizes direct package dependencies listed in package.json as
of 2026-08-23, together with the data files bundled into the application.
Review bundled transitive dependencies and generated release artifacts before
publishing installers.

## Runtime Dependencies

| Package | Version | License | Source |
| --- | --- | --- | --- |
| @firecrawl/pdf-inspector | 1.17.0 | MIT | https://github.com/firecrawl/pdf-inspector |
| @huggingface/transformers | ^4.2.0 | Apache-2.0 | https://github.com/huggingface/transformers.js |
| @napi-rs/canvas | ^0.1.100 | MIT | https://github.com/Brooooooklyn/canvas |
| @vitejs/plugin-react | ^5.1.1 | MIT | https://github.com/vitejs/vite-plugin-react |
| better-sqlite3 | 13.0.3 | MIT | https://github.com/WiseLibs/better-sqlite3 |
| electron-store | ^11.0.2 | MIT | https://github.com/sindresorhus/electron-store |
| lucide-react | ^0.556.0 | ISC | https://lucide.dev |
| mermaid | 11.17.0 | MIT | https://mermaid.js.org |
| pdf-lib | ^1.17.1 | MIT | https://pdf-lib.js.org |
| pdfjs-dist | ^5.4.394 | Apache-2.0 | https://mozilla.github.io/pdf.js/ |
| react | ^19.2.1 | MIT | https://react.dev/ |
| react-dom | ^19.2.1 | MIT | https://react.dev/ |
| react-resizable-panels | ^4.11.2 | MIT | https://react-resizable-panels.vercel.app/ |
| tesseract.js | ^7.0.0 | Apache-2.0 | https://github.com/naptha/tesseract.js |

## Development and Packaging Dependencies

| Package | Version | License | Source |
| --- | --- | --- | --- |
| @playwright/test | ^1.61.1 | Apache-2.0 | https://playwright.dev |
| @types/better-sqlite3 | ^9.6.0 | MIT | https://github.com/DefinitelyTyped/DefinitelyTyped |
| @types/node | ^25.0.0 | MIT | https://github.com/DefinitelyTyped/DefinitelyTyped |
| @types/react | ^19.2.7 | MIT | https://github.com/DefinitelyTyped/DefinitelyTyped |
| @types/react-dom | ^19.2.3 | MIT | https://github.com/DefinitelyTyped/DefinitelyTyped |
| concurrently | ^9.2.1 | MIT | https://github.com/open-cli-tools/concurrently |
| cross-env | ^10.1.0 | MIT | https://github.com/kentcdodds/cross-env |
| electron | ^39.2.7 | MIT | https://github.com/electron/electron |
| electron-builder | ^26.0.12 | MIT | https://github.com/electron-userland/electron-builder |
| typescript | ^5.9.3 | Apache-2.0 | https://www.typescriptlang.org/ |
| vite | ^7.2.6 | MIT | https://vite.dev |
| vite-plugin-static-copy | ^4.1.0 | MIT | https://github.com/sapphi-red/vite-plugin-static-copy |
| wait-on | ^9.0.3 | MIT | https://github.com/jeffbski/wait-on |

## Bundled Data Files

These ship inside the application, not only as build-time dependencies.

| File | Origin | Upstream revision | License |
| --- | --- | --- | --- |
| `assets/tokenizers/d241a60d….tokenizer.json` | `Xenova/bge-small-en-v1.5` and `Xenova/bge-base-en-v1.5` (byte-identical) | `ea104dacec62c0de699686887e3f920caeb4f3e3`, `4d6cd88e18e51a5e020c2c305726d76ada9c03cf` | MIT |
| `assets/tokenizers/da0e7993….tokenizer.json` | `Xenova/all-MiniLM-L6-v2` | `751bff37182d3f1213fa05d7196b954e230abad9` | Apache-2.0 |
| `assets/tokenizers/9261e7d7….tokenizer_config.json` | `Xenova/bge-small-en-v1.5` (byte-identical across all three) | `ea104dacec62c0de699686887e3f920caeb4f3e3` | MIT |

Bundled so that measuring a passage's length needs no network. Each file is
named by the SHA-256 of its own contents and verified against that hash at load
time. `bge-small-en-v1.5` and `bge-base-en-v1.5` are MIT; `all-MiniLM-L6-v2` is
Apache-2.0. Embedding model *weights* are not bundled — they are downloaded on
first use and cached under the application data directory.

Platform binaries: `@firecrawl/pdf-inspector` and `better-sqlite3` ship
prebuilt native modules. Only the `darwin-arm64` builds are packaged; the
release excludes every other platform's binary.

## Additional Notes

- Electron release artifacts may include additional notices from bundled
  Chromium, Node.js, and Electron components.
- PDF.js assets, Tesseract OCR assets, model files, and wasm artifacts should
  be reviewed when included in a packaged release.
- This file is informational and does not replace any third-party license text
  that must be distributed with binary releases.
