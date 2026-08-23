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
