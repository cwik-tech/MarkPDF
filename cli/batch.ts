import type { CliFailure } from "./errors.js";
import { EXIT_CODE, type ExitCode } from "./exit.js";

/**
 * What a run of several documents exits with.
 *
 * `partialFailure` exists so a caller can tell "nothing worked" from "most of it worked": the
 * first is usually a wrong invocation, the second usually one bad file in a folder, and they
 * deserve different reactions. When nothing succeeded, the first failure's own code is more
 * informative than the batch code, so that is what is returned.
 */
export function batchExitCode(succeeded: number, failures: readonly CliFailure[]): ExitCode {
  if (failures.length === 0) return EXIT_CODE.success;
  if (succeeded > 0) return EXIT_CODE.partialFailure;
  return failures[0]?.code ?? EXIT_CODE.unexpected;
}

export interface FailureReport {
  path: string;
  code: number;
  reason: string;
  remedy?: string;
}

/** Collects failures for the JSON report while reporting each one on stderr as it happens. */
export function createFailureLog(report: (failure: CliFailure) => void) {
  const failures: CliFailure[] = [];
  const reports: FailureReport[] = [];
  return {
    failures,
    reports,
    add(path: string, failure: CliFailure): void {
      failures.push(failure);
      reports.push({
        path,
        code: failure.code,
        reason: failure.message,
        ...(failure.remedy === undefined ? {} : { remedy: failure.remedy }),
      });
      report(failure);
    },
  };
}
