/** The index was written by a newer MarkPDF. Migrating downward would corrupt meaning. */
export class SchemaTooNewError extends Error {
  constructor(readonly found: number, readonly supported: number) {
    super(
      `This index was created by a newer version of MarkPDF (schema ${found}, this build supports ${supported}). ` +
        `Update MarkPDF to use it.`,
    );
    this.name = "SchemaTooNewError";
  }
}

/**
 * A row read back from SQLite, or a file behind it, did not have the shape the code requires.
 *
 * Accepts a `cause` so the original failure survives. Rewriting an ELOOP or EACCES into a
 * sentence and discarding the error loses the code a caller would act on.
 */
export class StoreDataError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "StoreDataError";
  }
}

/**
 * The index needs a schema upgrade, and another connection has it open.
 *
 * The upgrade adds rules — the exact-word index and how forgetting erases it — that a process
 * opened under the old schema does not know and would keep breaking. So the upgrade runs only with
 * no other connection attached, and refuses, having changed nothing, when one is.
 */
export class StoreUpgradeBusyError extends Error {
  constructor(readonly found: number, readonly target: number, options?: { cause?: unknown }) {
    super(
      `MarkPDF must upgrade its index (schema ${found} to ${target}), but another MarkPDF window, command or agent session has it open. ` +
        `Close them and try again.`,
      options,
    );
    this.name = "StoreUpgradeBusyError";
  }
}
