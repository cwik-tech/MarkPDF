# Shipping the command line inside the application

## Status

Accepted, with one departure from the plan recorded below.

## Context

The `markpdf` command has to run when the application is not running, index into the same database
the application uses, and work offline. It is not published to npm (D5): it ships inside
MarkPDF.app with an install action.

## Decision

**`ELECTRON_RUN_AS_NODE=1` against the bundled Electron binary.** A second Node binary would be
one more signing target and roughly 55 MB, and resolving `node` from `PATH` would make the command
depend on whichever of nvm, volta, asdf or mise won that day — a different runtime from the one the
native modules were verified against.

**Installed as a POSIX shell shim that bakes in the binary, the entry point and the data
directory.** Baked rather than looked up: a command that went searching for MarkPDF could find a
different version and write to the same index.

**The entry point is derived from the installing module's own location, not from
`app.getAppPath()`.** That call returns the directory Electron resolved its entry script from —
`app.asar` in a packaged build, but `dist-electron/` in a development launch — so a shim built from
it baked in `dist-electron/dist-cli/main.js`, which does not exist. `electron/cliInstall.ts`
compiles to `<root>/dist-electron/cliInstall.js` and `dist-cli/` is that root's sibling in both
layouts, so walking up from the module is correct in both. The version is read the same way, for
the same reason: `app.getVersion()` answers with *Electron's* version in a development launch, and
staleness is decided by comparing it. **The install journey found this by running the command it
had just installed**, which is why it does that rather than checking an executable bit.

**The shim carries a marker line** with its version, bundle, binary, entry point and data
directory. Status compares **every** field, not just the version — a shim at today's version with
yesterday's entry point runs yesterday's code, and one with a different data directory quietly
writes to a second index. Six states follow: not installed, current, stale, pointing elsewhere,
a foreign file, and shadowed on `PATH`; plus three this design added — *not on `PATH`*, *`PATH`
unknown*, and *not executable*. The last is the one that reads worst if it is missing: a shim that
is installed, is exactly ours, and has had its mode changed is indistinguishable from a working
command to anything that only reads the file, so it would have been reported as `current` with a
working indicator on a command that cannot start.

**Executability is measured on the file and answered before any `PATH` question.** Inferring it
from a `PATH` search was the first attempt and was wrong twice over: the search cannot answer at
all when the login shell's `PATH` is unknown or when the install directory is not on it, so the
same unrunnable file was reported as `path-unknown` in one case and `not-on-path` in the other —
hiding the repair button and offering advice that would not have helped. Whether a file can run is
a fact about the file.

**Writing is atomic, never through a link, and only ever over a file this application wrote.**
`lstat` first — never `stat` — so a symbolic link at the install path is seen as a link and
refused rather than written through, which would otherwise be a way to overwrite an arbitrary
file. A directory is refused. A regular file is refused unless it is **byte-for-byte what this
application would write for the identity its own marker declares**: a marker is one line, and
anything that copied it — or any edit somebody made to a shim afterwards — would otherwise be
treated as ours and overwritten or deleted. The same rule governs removal.

The script is written inside a directory created by `mkdtemp` beside the target and renamed onto
it, so the command at that path is the old one or the new one and never a truncated script a
shell would run. **A fixed staging name would have been a file somebody else could own**; the
temporary directory is created by this call, so cleanup removes only what this call made, and the
file inside it is created with `O_CREAT | O_EXCL`. The consent record is written the same way, for
the same reason.

**The shim diagnoses before it runs.** `exec` on a missing binary is a shell error — 126 or 127 —
that says nothing about which application is missing. The script tests the Electron binary and the
reachability of its entry point first and exits **69** with a sentence naming the application, so
the documented "the application is unavailable" code is actually reachable. The entry-point test
looks for the enclosing `.asar` archive rather than the path inside it, because a packaged entry
point lives inside a *file* and nothing can stat a path within one.

**`PATH` is read from an interactive login shell, or not claimed at all.** An application launched from
Finder inherits `launchd`'s minimal environment, so `process.env.PATH` cannot say which `markpdf` a
terminal would run. The interactive flag matters for zsh because a fresh Terminal loads `.zshrc`,
while a non-interactive login shell does not. The shell is asked with a fixed argument list —
nothing built from user input. On macOS, `/usr/bin/script` supplies a pseudo-terminal because some
interactive plugins wait indefinitely when started through plain pipes. The shell runs in a
detached process group with a three-second hard timeout, so the shell and any plugin children are
killed together if startup still does not finish. When that fails the status is `path-unknown` and
the settings screen says so rather than guessing.

**Installing into the user-local directory also completes the shell setup.** If that directory is
missing from `PATH`, or another `markpdf` is found first, MarkPDF adds a marked block to the active
zsh, bash, or POSIX sh profile. The directory is shell-quoted, the profile is replaced atomically,
an existing profile symlink remains a symlink, and an edited or partial MarkPDF block is refused.
Uninstall removes only the exact block MarkPDF generated. A successful profile change opens a new
macOS Terminal window so the command is immediately available there; the settings state turns
green and confirms completion with a toast.

**Asked asynchronously, and split across the boundary.** The settings screen asks for the status
the moment it opens, from the process that draws the window, so `execFileSync` stopped the
interface for as long as somebody's shell profile took — and plenty take a second.
`electron/defaultApp.ts` had already reached the same conclusion about `osascript`. The subprocess
stays in `electron/`, which is where this repository puts privileged input and output;
`core/install/loginShellPath.ts` takes an injected runner — typed `Promise<unknown>`, so the
runtime check on its output is a real boundary rather than a restatement of a type — and owns only
the decisions: which shell names are worth asking about, and what an empty, failed or non-string
answer means. A relative `SHELL` is refused without running anything.

The fixed command frames `PATH` between markers. Pseudo-terminals and interactive plugins may print
their own text, so only the framed value is used. Its contents are kept byte for byte; leading and
trailing spaces belong to a directory name, and trimming would return a different `PATH`.

**The OCR assets are bundled and the engine is pointed at them.** `@tesseract.js-data/eng` pinned
at `1.0.0`, using the `4.0.0_best_int` variant: 2.8 MB against 10 MB, and the only one the
LSTM-only engine needs — the same engine the reader already uses (`src/pdf/ocr.ts:57`), so a scan
indexed from the command line is recognised the same way as one indexed in the application. The
10 MB variant is excluded from the package.

**`asarUnpack` gains** `tesseract.js/src/worker-script/**`, `tesseract.js-core/**` and
`@tesseract.js-data/eng/**`. The recognition engine runs in a `worker_threads.Worker`
(`tesseract.js/src/worker/node/spawnWorker.js`) whose script must be a real file on disk.

**`outline` derives its headings from the extracted Markdown, not from PDF bookmarks.** The
argument is no longer that `core/` has no PDF library — Phase 3 brought `pdfjs-dist` in for
rasterising scanned pages, so that constraint is gone. It is that the heading tree is the case
that actually needs serving: a document with no bookmarks still has headings, a document whose
bookmarks disagree with its headings is rare, and reading the outline dictionary would add a
second source of truth for the same question. The cost is stated plainly under Consequences.

## The departure from the plan

The plan's ADR list names "elevation" as part of this decision. **Elevation is not implemented**,
and the destination differs from what the plan implied. Measured on macOS 25.5:

| Directory | On the default `PATH`? | Writable without elevation? |
| --- | --- | --- |
| `/usr/local/bin` | Yes — first line of `/etc/paths` | No. `root:wheel`, mode 755 |
| `~/.local/bin` | No — absent from this account's login `PATH` | Yes |

So the command installs to `/usr/local/bin` **when this user can already write there**, and to
`~/.local/bin` otherwise. Writing to a root-owned directory from a document reader means an
administrator password prompt and a privileged shell command; that is a security surface worth
designing on its own rather than adding at the end of a phase.

The user-local destination no longer leaves setup to the user. MarkPDF updates the active shell
profile with its own removable block. If the profile cannot be identified or updated safely, the
installation reports that failure instead of claiming completion. Implementing elevation remains
open, but it is no longer required for a one-click installation.

## Consequences

- Roughly 2.9 MB added to the installed application: the language data plus `dist-cli`.
  `tesseract.js-core` already shipped for the reader's own OCR; it moves out of the archive rather
  than being added.
- A person on a machine without a writable `/usr/local/bin` gets a user-local command and a managed
  shell-profile entry without entering an administrator password.
- `outline` shows the heading tree of the text as extracted. Native PDF bookmarks are not read, so
  a document whose bookmarks differ from its headings shows the headings. Heading *level* is the
  extractor's judgement from font statistics — measured against the test fixture, it reports both a
  20pt title and a 16pt section heading as level 1.
- The command line always attempts OCR on a page the extractor cannot read. There is no flag to
  turn that off, so a large scanned document is slow.

## Two findings that changed the implementation

**The plan's OCR configuration does not work.** It called for
`createWorker([{ code: "eng", data }])` so no path handling was involved. In the installed
`tesseract.js` 7.0.0, `src/worker-script/index.js:101` reads `_lang.code` when loading the file but
`:238` reads `_lang.data` when naming the language to initialise, so the engine is asked to open a
data file named after the entire byte array and reports
`Error opening data file ./31,139,8,...`. The string form with a local `langPath` reaches the same
file with none of that. `cacheMethod: "none"` is then required, because `:181` otherwise writes
`eng.traineddata` into `cachePath || '.'` — the directory the person happened to be standing in.

**A shell expansion that looked right was not.** The shim first assigned its data directory with
`: "${MARKPDF_DATA_DIR:=<quoted path>}"`. Inside `${VAR:=word}` the word is not re-parsed as shell
syntax, so the single quotes survived as literal bytes and the variable was set to a path complete
with quotation marks. The live check caught it by leaving a directory literally named `'` in the
repository root. It is now a plain assignment inside an `if`, and four tests execute the shim
through `/bin/sh` rather than reading it.

## A dependency that throws where nothing can catch it

`tesseract.js` 7.0.0 has two faults on the failure path, and only one of them can be closed from
outside. When a worker job is rejected and no `errorHandler` was supplied, `createWorker.js:216-219`
does `throw Error(data)` from inside its own `worker.on("message")` handler — an uncaught exception
on the main thread. Supplying a handler closes that. It then posts a *resolve* for the job it just
rejected and dereferences the already-deleted promise (`createWorker.js:208`), which no option
prevents.

Three things follow. The language data is checked for its gzip magic bytes before the engine is
started, so the common cause never reaches it. `errorHandler` is always supplied, and that is
asserted on the options object rather than through a run, because it is a property of the options.
And `cli/main.ts` installs an `uncaughtException` backstop, so whatever a dependency throws out of
band the run still ends with a code from the table and one sentence on stderr rather than a stack
trace and an empty stdout. The backstop cannot attribute what it catches, so that path exits `1`;
the journey asserts exactly that, and no more.

## Verification

`core/install/cliShim.test.ts` covers the script, the marker, and every status rule — including
four tests that run the rendered shim through a real `/bin/sh` with spaces and a `$` in the path,
with the variable unset and with it explicitly overridden.
`core/install/installShimFile.test.ts` works against real temporary directories: a symbolic link at
the install path is refused and its target left untouched, a directory is refused, a foreign file
is refused unchanged, and no staging file is left behind.
`core/install/pathLookup.test.ts` covers the `PATH` search order, the empty-entry rule, and
whether a real file on disk can be executed. `core/install/loginShellPath.test.ts` covers the
interactive question asked, every way the answer is refused, and — with a runner the test resolves
by hand and no timers at all — that the call hands back a pending promise rather than blocking
until the shell replies. It also covers framed extraction through terminal and plugin chatter.
`core/install/shellProfile.test.ts` covers marked-block installation and removal, idempotency,
shell quoting, preservation of existing content and modes, profile symlinks, and unsupported shells
against real temporary files.
`src/cliInstallCopy.test.ts` fixes the sentence shown for every state.

**`tests/e2e/cli-install.spec.ts` is the journey that proves the button is wired to all of it**:
it opens Settings › General, clicks Install, observes a green current state and completion toast,
confirms that no manual profile instruction remains, starts a fresh isolated zsh that resolves the
command, and then **runs the installed command** — `markpdf --version` through the shim, on the real
Electron binary under `ELECTRON_RUN_AS_NODE=1` — before clicking Remove and confirming both the
command and MarkPDF's profile block are gone. An executable bit is not a working command, and the
difference is exactly what this caught. Its isolated `.zshrc` also reproduces a plugin that waits
forever without a TTY, proving the status check completes without leaking a shell process.
`npm run test:e2e` and
`npm run electron:dev` build `dist-cli` so the entry point the shim names is really there. It runs against the
real preload bridge and the real IPC handlers. The destination is a temporary directory, chosen
through a seam that refuses unless the build is unpackaged, opted in by an exact token, and
already pointed at a test profile — `core/install/installDirectorySelection.ts`, whose own tests
enumerate every way it must refuse, so a released build can never reach it.

**Verified against a signed, unpacked arm64 build on 2026-08-23** (`electron-builder --dir`), with
the command run through an installed shim and the network blocked in the process and its worker
threads: the command starts from inside `app.asar`; it writes its consent record to the baked data
directory; `outline` opens `better-sqlite3` and `@firecrawl/pdf-inspector`; `convert` rasterises a
scan with pdf.js and `@napi-rs/canvas` and recognises it with `tesseract.js`, offline; and nothing
is written into the working directory. `codesign --verify --deep --strict` reports the bundle valid
and satisfying its designated requirement, with the hardened runtime on (`flags=0x10000`).

`cli/journeys/electronRuntime.live.test.ts` is the opt-in equivalent against a checkout, run with
`npm run test:live`. It observes the shim, the baked data directory, `better-sqlite3` and
`@firecrawl/pdf-inspector` under `ELECTRON_RUN_AS_NODE=1` — and nothing about ONNX Runtime or the
real model, because it selects the offline embedder like the rest of the suite.

**Not verified.** Production embedding from the installed command, packaged or not: every check
here selects the offline stand-in, and a packaged build refuses even that by design, so proving
`index` and `search` end to end there needs a 133 MB model download. Notarizing
a distributable is also unverified — credentials are not set here, and notarization is currently
failing on Apple's side for this account.

## Alternatives considered

- **Bundling a Node binary.** Rejected: another signing target and about 55 MB.
- **A symlink into the bundle.** Rejected: it cannot set `ELECTRON_RUN_AS_NODE` or the data
  directory, and it breaks when the application moves.
- **Publishing to npm.** Rejected by D5: it would mean shipping and signing native modules on a
  second cadence.
- **Elevating to write `/usr/local/bin`.** Deferred, with the trade-off recorded above rather than
  hidden in a comment.
- **PDF Inspector's own `processPdfWithOcr`.** Rejected: its README states the native package
  embeds no OCR models, PDFium or ONNX Runtime, and that routed OCR needs compatible PDFium and
  ONNX Runtime shared libraries on the platform library search path plus a model set downloaded and
  checksum-verified on first use. That is a new native artifact on the notarised release path,
  outside the approved dependency set.
- **Reading PDF bookmarks for `outline`.** Deferred: `pdfjs-dist` is now in `core/` for
  rasterising, so it is available — the reason is that it would add a second answer to the same
  question for a case the heading tree already covers, not that the library is out of reach.
