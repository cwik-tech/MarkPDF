# The command line's contracts: consent, streams and exit codes

## Status

Accepted

## Context

The command line exists so an agent can index, search, outline and convert somebody's documents
without a person driving the interface. That changes the threat model rather than the feature set:
the same operations, performed by something the person is not watching, against files they did not
individually choose.

Two consequences follow, and both are contracts rather than conventions. An agent reads the exit
code before it reads anything else, and it reads stdout as data. And the set of files a program may
open on someone's behalf has to be a decision that person made, recorded somewhere they can inspect
and withdraw.

## Decision

**The consent model lives in `core/`, not in `cli/`.** The MCP server will inherit exactly the same
enforcement, and a second copy of a security rule is a second chance to get one of them wrong.

**Roots are canonical, and only the request is resolved.** `applyGrants` resolves every symbolic
link once, when a grant is made, and stores the result. The checks never resolve a stored root
again. Resolving it at check time is what lets an old grant follow its name somewhere new: delete
the granted directory, put a link to somewhere else at the same path, and the grant moves with it
without anybody granting anything. Withdrawal compares the same way, or a granted directory since
replaced by a link would escape the withdrawal entirely. Containment uses `path.relative`, never
`startsWith`, because `/Users/t/Papers2` begins with `/Users/t/Papers`.

**Read roots never imply write roots.** An agent granted a library to search must not be able to
overwrite it. `convert --out` is where that distinction does real work.

**Withdrawal reaches downwards.** Revoking a directory removes every root inside it. Consent
withdrawn from a library still granted three levels down has not been withdrawn.

**The consent record fails closed, loudly.** A missing file is the empty allowlist — the correct
starting position. A file that exists and cannot be read is not: treating it as empty would discard
grants and then overwrite them. Roots must be absolute, so the working directory cannot reinterpret
a hand-edited record. The file is `0600` and written to a sibling and renamed.

**The highest-traffic command needs no filesystem permission at all.** `search --path` resolves
against `documents.file_path` first, as a pure database query — no `stat`, no `open`, no
`realpath` — falling back to reading and hashing only on a miss. Both the given spelling and its
`path.resolve` normalisation are tried, because both are string arithmetic. Resolving links is
deliberately not done there: that is a filesystem call, and it is what this branch exists to avoid.

**Deletion is withdrawal of consent and is made real — or refused.** `secure_delete = ON`, then
`wal_checkpoint(TRUNCATE)`, `VACUUM`, and a second checkpoint, with **both checkpoint results
checked**. That check is not defensive tidiness. `PRAGMA wal_checkpoint` *reports* a busy log
rather than raising: measured against better-sqlite3 13.0.3 with a second connection holding a
read transaction, both checkpoints returned `busy: 1`, `VACUUM` succeeded anyway, and the deleted
text was still sitting in a 24 KB write-ahead log. An unchecked call is a silent no-op exactly
when it matters most.

So exclusivity is established **before anything is deleted**: `BEGIN IMMEDIATE` under
`locking_mode = EXCLUSIVE` either succeeds — in which case nothing else can attach until it is
released — or raises `SQLITE_BUSY` having changed nothing at all. Somebody whose document could
not be forgotten still has it and can try again, rather than being told a withdrawal succeeded
while the text remained readable. The command line reports that as exit 9, index busy.

The guarantee is therefore precise: **when forgetting reports success, the text is gone from the
database and its log; when it cannot guarantee that, it deletes nothing and says so.** The test
reads the database and its write-ahead log as bytes, both with and without a second real
connection attached.

**A refusal prints a runnable command.** Scoped to the resolved containing directory — or to the
named directory itself for `index --recursive`, where taking the parent would grant every sibling
of the folder somebody named. The same scope drives the interactive prompt, so what a person is
shown and what is recorded cannot disagree. Every path is single-quoted for a POSIX shell: double
quotes would let `$(…)`, a backtick or a `$VAR` inside a file name run when the suggestion was
pasted.

**Changing the record is one indivisible operation.** Every path that changes consent goes through
`updateAllowlist`, which reads, applies and writes while holding an exclusive lock taken with
`O_CREAT | O_EXCL` — there is no window between checking and claiming it. Re-reading before writing
was not enough and was rejected as a fix: it narrows the race without removing it, and the change
that gets lost to a race can be a *withdrawal*. Contention **fails closed** — the caller is told to
try again and the record is left exactly as it was — because nothing about consent may be undone by
accident, and it is reported as its own type so the advice can be "wait", never "delete your
consent record".

**An existing lock is never taken over.** Two designs for automatic cleanup were written and both
removed. An age-based takeover removes the lock of a process that was merely paused — at a
breakpoint, or by the scheduler — which is the lost update the lock exists to prevent. Identifying
the owner by process id and removing only a dead one is no better: removing a lock and creating
another is two operations, so two processes reading the same abandoned lock can each delete the
*other's* fresh lock and both proceed. Liveness is not a compare-and-delete, and no amount of care
about *which* lock to remove makes deleting one atomic.

So the lock records its holder's process id, and that id chooses the **message** and nothing else.
A running owner will finish and release, so the answer is to wait, with nothing to remove. A dead,
malformed or unidentifiable owner needs a person, and the only file they are ever pointed at is
`allowlist.json.lock` — never the record, whose removal would discard every grant and free nothing.

The cost is stated plainly: a process that dies between claiming and releasing leaves a lock
somebody has to delete. That is rare, visible, and a one-line repair the message spells out. A
silently lost withdrawal is none of those things.

**A file name never reaches the terminal as itself, and an argument that would need escaping is
refused.** Paths appear in refusals, remedies and prompts, and a name is somebody else's text: one
containing a newline ends the line and writes another, so a refusal can be made to read as its own
opposite or as a different program's output.

Escaping alone would have been the wrong answer, because it collides with the promise that a
printed remedy can be pasted and will work: the escaped spelling names a file that does not exist.
So the two are separated. **An argument carrying a control character is refused at the boundary**
as a usage error, before anything is resolved or printed — tab excepted, since it cannot forge a
line. Every remedy that is ever printed is therefore for a path somebody can type. And every line
bound for stderr still passes through `safeForTerminal` as a second net, which turns C0 controls,
DEL and C1 controls into visible escapes and touches nothing else — accented letters, other
scripts and emoji are names, not commands. Shell quoting is a separate concern and stays where it
was; JSON on stdout escapes control characters itself.

**Stopping is an outcome, not a fault.** A cancelled page render reports as interrupted rather than
as an unexpected failure, and a search that was cancelled prints nothing at all: `runCli` would
return 130 either way, but a caller reading stdout would otherwise have taken an answer from a run
it had already stopped. `--pages` also bounds the recognition rather than filtering after it, so
asking for one page of a scanned book does not rasterise the whole book first.

**Interactive runs offer a one-keystroke grant; non-interactive runs never prompt.** Raw mode is
what makes Ctrl-C worth handling explicitly: with it on the terminal stops turning Ctrl-C into
SIGINT, so the byte arrives on the stream and a prompt that treated it as "not y" would report a
refused path — exit 5, with a remedy — when the person had cancelled. It raises the run's own
cancellation instead, and the run ends at 130.

**Results on stdout, everything else on stderr.** One function writes to stdout, and `convert`
writes exactly once however many documents it was given.

**Exit codes** are `0` success — *including an empty search result, because finding nothing is an
answer* — `2` usage, `3` not found, `4` not indexed, `5` access denied, `6` parse failed, `7`
partial batch failure, `8` missing dependency, `9` index busy, `69` app unavailable, `130`
interrupted. `1` is added for an unexpected failure: the plan's table starts at 2, and leaving 1
unnamed would have meant borrowing a code that already means something.

**`parseFailed` is claimed only for errors that came out of the parse boundary.**
`extractPagesFromPdf` gives everything its native call raises the type `PdfInspectorError` —
verified against the installed 1.17.0 binding, which answers `classify_pdf: Not a PDF: file appears
to be plain text` as a plain `Error` with `code: "GenericFailure"`. Anything else stays
`unexpected`, because telling somebody their PDF is corrupt when a model failed to load sends them
to look at the wrong thing.

**Arguments come from `node:util.parseArgs` plus a hand-written command table.** The table
validates argv, generates `--help`, and carries the kinds, ranges, choices and descriptions an MCP
tool's JSON Schema will need. No schema generator is written here: Phase 4 needs it and Phase 3
does not.

**The command line reads the application's own settings.** `<userData>/config.json`, key
`semanticSearch` — verified against the live install. Chunk identity carries the chunking profile
and vectors are keyed by model, so a command line assuming its own defaults would re-chunk and
re-embed every document the application had done, and the application would undo it.

## Consequences

- Someone who indexes a library and then withdraws the grant can still search it. That is the
  intended shape, and it is the property V8 exists to prove.
- A document reached through a link that was never granted falls to the permission-requiring
  branch even though the same file is in the index under another spelling.
- A damaged consent record stops the command entirely, reported as exit 5 with the file named.
  Access genuinely cannot be established, and the record is left exactly as found.

## Verification

`core/consent/allowlist.test.ts` and `core/consent/allowlistFile.test.ts` cover containment,
resolution, the read/write asymmetry, withdrawal, and the record's own failure modes.
`core/index/documentLookup.test.ts` proves the database-first order with a filesystem spy that
records every read. `core/store/forget.test.ts` reads the file as bytes, and covers the two-connection case with a
second real `better-sqlite3` connection holding a read transaction: forgetting refuses, the
document is still there, and clearing refuses too.
`cli/parse.test.ts`, `cli/help.test.ts`, `cli/exit.test.ts` and `cli/errors.test.ts` cover the
table, the generated help, the code table and the classifier. `cli/run.test.ts` and
`cli/commands.test.ts` cover the stream discipline and each command. `cli/prompt.test.ts` covers
the terminal prompt, including Ctrl-C and a stream that ends. `core/text/safeForTerminal.test.ts`
covers what a name may and may not do to a display, and which arguments are refused outright.
`core/consent/allowlistFile.test.ts` covers the exclusive update: that a change is applied to the
record as it is rather than to an earlier read, that contention refuses without overwriting, that
a withdrawal cannot be lost to a grant, that the lock is released on both success and failure, that
a lock is never taken over — not even one whose owner has exited — and that the advice differs by
ownership: a running owner offers only waiting, while a dead or unrecognisable one names the lock
file and leaves it in place.

**The contention test runs a second real process.** `holdAllowlistLock.test-support.mjs` takes the
same lock through the same exported function and holds it until its input closes, so the refusal
the parent observes is genuine contention between two processes rather than an assertion about a
planted file. A CLI-level test then checks the advice: exit 9, "try again", and no suggestion that
the consent record be removed.

**Withdrawing a subdirectory says what is true.** Roots are a union with no deny rule, so a
subdirectory of a granted folder cannot be withdrawn on its own. Reporting that as "nothing was
held" would tell somebody auditing their own exposure that a folder was unreachable when it is
not, so the effect `covered-by-ancestor` names the broader grant that still reaches it and says
which folder to withdraw instead. The operation still changes nothing; only the sentence differs,
and the sentence was the defect.

**V7** (`cli/journeys/consent.test.ts`) runs `markpdf index` on a path nobody granted, checks it
exits 5 and that the data directory is untouched, extracts the printed remedy, and **runs it
through a real shell** with `markpdf` on `PATH` — against a library directory whose name contains
a space, so the quoting is under test rather than the wording.

**V8** proves an already-indexed document stays searchable after its folder is withdrawn, and that
the answer came without the filesystem. Mutation-proved as the plan requires: making the lookup
hash the file unconditionally turns V8 red.

Mutation-proved elsewhere: a consent update performed without the lock; a lock never released; a
dead owner's lock removed and taken rather than refused; an unidentifiable lock taken over; a live
owner's lock reported as something to delete; a withdrawal covered by a broader grant reported as
never granted; a shim the shell cannot run reported as current; the crash backstop printing raw
text; control characters accepted as arguments; a grant applied to the start-up snapshot instead of
the current record; stderr written without sanitising; a search that emits after a cancel;
recognition unbounded by `--pages`; resolving the stored root in `isAllowed` and in `requireAccess`;
containment by string prefix; the request left unresolved; read roots merged with write roots;
withdrawal resolving the stored root; relative roots accepted from the record; a damaged record
read as no consent; the consent file left world-readable; the store opened before access is
checked; the remedy printed unquoted.

Reported rather than smoothed over, four mutations survive and are kept anyway:

- **The cleanup when writing the owner into a newly created lock fails.** The file has just been
  created by this call and nothing else can hold it, so removing it there is undoing a claim that
  never completed rather than the takeover refused above — but no in-process test can make a write
  to a freshly opened descriptor fail, so the guard is reasoned rather than proven.

- **The atomic write of the consent record.** No in-process test can interrupt a write, so
  atomicity is a design property here, not a proven one. What *is* proven is that the staging
  artifact is owned: a bystander file or a link at the old fixed name is left untouched.
- **The checkpoint-result check.** Now that exclusivity is taken before anything is deleted, no
  scenario this suite can build makes a checkpoint busy — removing exclusivity is what turns the
  concurrency test red. The check stays as the second net behind it, because a future change that
  weakened the lock would otherwise regress silently.
- **Reporting a failed release of the exclusive lock.** Nothing here can make `locking_mode =
  NORMAL` fail. What is proven is that another connection can attach again after both a refusal
  and a success.

## Alternatives considered

- **The allowlist in `cli/`.** Rejected: the MCP server would need its own copy.
- **Resolving stored roots at check time.** Rejected with a regression test: it lets a replaced
  directory carry an old grant somewhere nobody granted.
- **Treating an unreadable consent record as empty.** Rejected: it discards a decision somebody
  made and then overwrites the evidence.
- **A third-party argument parser.** Rejected: it owns its own schema format, and the reuse the
  table exists for would be lost.
- **`parseFailed` as the catch-all for per-document errors.** Rejected after review: it labels
  model, network and runtime faults as bad PDFs.
