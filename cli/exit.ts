/**
 * What the process tells its caller.
 *
 * An agent invoking this reads the number before it reads anything else, so each code means one
 * thing and nothing else means it. **Zero includes an empty search result**: finding nothing is
 * an answer, and reporting it as a failure would make "no evidence for that claim" indistinguishable
 * from "the command broke".
 */
export const EXIT_CODE = {
  success: 0,
  /**
   * Something went wrong that none of the meanings below describes — a bug, not a condition.
   *
   * Not from the plan's table, which assigns meanings from 2 upward. One is the conventional
   * code a Node process exits with when it throws, and leaving it unnamed would have meant
   * borrowing a code that already means something specific.
   */
  unexpected: 1,
  /** The command line itself was wrong: an unknown command, a missing argument, a bad value. */
  usage: 2,
  /** A path given on the command line is not there. */
  notFound: 3,
  /** The document exists but has never been indexed, so there is nothing to search. */
  notIndexed: 4,
  /** The allowlist does not cover a path this run had to touch. */
  accessDenied: 5,
  /** The document is there and could not be read as a PDF. */
  parseFailed: 6,
  /** Several documents were given, some succeeded and some did not. */
  partialFailure: 7,
  /** A native module or bundled asset the command needs is missing from this installation. */
  missingDependency: 8,
  /** Another writer holds the index and did not release it in time. */
  indexBusy: 9,
  /** The installed application this command belongs to could not be found or run. */
  appUnavailable: 69,
  /** Interrupted, by convention 128 plus SIGINT. */
  interrupted: 130,
} as const;

export type ExitCode = (typeof EXIT_CODE)[keyof typeof EXIT_CODE];
