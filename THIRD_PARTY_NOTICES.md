# Third-Party Notices

This file summarizes direct package dependencies listed in package.json as
of 2026-08-22. Review bundled transitive dependencies and generated release
artifacts before publishing installers.

## Runtime Dependencies

| Package | Version | License | Source |
| --- | --- | --- | --- |
| @huggingface/transformers | ^4.2.0 | Apache-2.0 | https://github.com/huggingface/transformers.js |
| @vitejs/plugin-react | ^5.1.1 | MIT | https://github.com/vitejs/vite-plugin-react |
| electron-store | ^11.0.2 | MIT | https://github.com/sindresorhus/electron-store |
| lucide-react | ^0.556.0 | ISC | https://lucide.dev |
| mermaid | 11.17.0 | MIT | https://mermaid.js.org |
| pdf-lib | ^1.17.1 | MIT | https://pdf-lib.js.org |
| pdfjs-dist | ^5.4.394 | Apache-2.0 | https://mozilla.github.io/pdf.js/ |
| react | ^19.2.1 | MIT | https://react.dev/ |
| react-dom | ^19.2.1 | MIT | https://react.dev/ |
| react-resizable-panels | ^4.11.2 | MIT | https://react-resizable-panels.vercel.app/ |
| sql.js | ^1.14.1 | MIT | https://github.com/sql-js/sql.js |
| tesseract.js | ^7.0.0 | Apache-2.0 | https://github.com/naptha/tesseract.js |

## Development and Packaging Dependencies

| Package | Version | License | Source |
| --- | --- | --- | --- |
| @types/node | ^25.0.0 | MIT | https://github.com/DefinitelyTyped/DefinitelyTyped |
| @types/react | ^19.2.7 | MIT | https://github.com/DefinitelyTyped/DefinitelyTyped |
| @types/react-dom | ^19.2.3 | MIT | https://github.com/DefinitelyTyped/DefinitelyTyped |
| @types/sql.js | ^1.4.11 | MIT | https://github.com/DefinitelyTyped/DefinitelyTyped |
| concurrently | ^9.2.1 | MIT | https://github.com/open-cli-tools/concurrently |
| cross-env | ^10.1.0 | MIT | https://github.com/kentcdodds/cross-env |
| electron | ^39.2.7 | MIT | https://github.com/electron/electron |
| electron-builder | ^26.0.12 | MIT | https://github.com/electron-userland/electron-builder |
| playwright | ^1.60.0 | Apache-2.0 | https://playwright.dev |
| typescript | ^5.9.3 | Apache-2.0 | https://www.typescriptlang.org/ |
| vite | ^7.2.6 | MIT | https://vite.dev |
| vite-plugin-static-copy | ^4.1.0 | MIT | https://github.com/sapphi-red/vite-plugin-static-copy |
| wait-on | ^9.0.3 | MIT | https://github.com/jeffbski/wait-on |

## Additional Notes

- Electron release artifacts may include additional notices from bundled
  Chromium, Node.js, and Electron components.
- PDF.js assets, Tesseract OCR assets, model files, and wasm artifacts should
  be reviewed when included in a packaged release.
- This file is informational and does not replace any third-party license text
  that must be distributed with binary releases.
