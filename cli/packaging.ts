import { sep } from "node:path";

/**
 * Is this copy of the command line running from inside an installed application?
 *
 * It matters for one thing only: the deterministic embedder must be unreachable in a shipped
 * build, and the guard that decides that takes `isPackaged`. The application asks Electron; this
 * has no Electron to ask, so it asks where its own file is.
 *
 * Both spellings are checked because a `.node` file is unpacked beside the archive rather than
 * inside it, so a module loaded from `app.asar.unpacked` is every bit as packaged.
 */
export function isPackagedModulePath(modulePath: string): boolean {
  return (
    modulePath.includes(`${sep}app.asar${sep}`) ||
    modulePath.includes(`${sep}app.asar.unpacked${sep}`) ||
    modulePath.includes(`.app${sep}Contents${sep}Resources${sep}`)
  );
}
