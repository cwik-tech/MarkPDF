import type { CliInstallStatus } from "./global";

export type CliInstallAction = "install" | "update" | "reinstall" | "remove" | "none";

export interface CliInstallCopy {
  /** One line saying what the state of the command is. */
  summary: string;
  /** What, if anything, the button should offer to do. */
  action: CliInstallAction;
  /** The button's label, when there is one. */
  actionLabel: string | null;
  /** Something the person has to do themselves, when there is such a thing. */
  instruction: string | null;
  /** Whether the command would work if typed right now. */
  working: boolean;
}

/**
 * What the settings screen says about the `markpdf` command.
 *
 * A pure rule, so every state has an assertion rather than a screenshot. The distinctions are the
 * point: "installed" and "the command you type is ours" are different claims, and a person whose
 * shell finds a different `markpdf` first needs to be told that rather than reassured.
 */
export function describeCliInstall(status: CliInstallStatus): CliInstallCopy {
  if (!status.supported) {
    return {
      summary: status.reason ?? "The command line is not available on this system.",
      action: "none",
      actionLabel: null,
      instruction: null,
      working: false,
    };
  }

  const state = status.state;
  switch (state.state) {
    case "not-installed":
      return {
        summary: `The ${status.command} command is not installed.`,
        action: "install",
        actionLabel: "Install command",
        instruction: null,
        working: false,
      };
    case "current":
      return {
        summary: `The ${status.command} command is installed and up to date.`,
        action: "remove",
        actionLabel: "Remove command",
        instruction: null,
        working: true,
      };
    case "stale": {
      // Version is the difference people expect, so it is named when it is one. The others —
      // a moved entry point, a different data directory — need saying too, because a command
      // that looks current and writes to a second index is the quietest way to be wrong.
      const versionChanged = state.differences.includes("version");
      const summary = versionChanged
        ? `The installed ${status.command} command is from version ${state.installedVersion}; this is ${status.version}.`
        : `The installed ${status.command} command was written for a different setup (${state.differences.join(", ")}).`;
      // Not claimed to work. `describeInstallation` answers this before it looks at PATH at all,
      // so there is no evidence the name reaches anything — and a green indicator on no evidence
      // is exactly the reassurance that stops somebody investigating.
      return { summary, action: "update", actionLabel: "Update command", instruction: null, working: false };
    }
    case "points-elsewhere":
      return {
        summary: `The installed ${status.command} command runs a different copy of MarkPDF, at ${state.installedAppPath}.`,
        action: "reinstall",
        actionLabel: "Point it at this copy",
        instruction: null,
        // Same reason as `stale`: this answer is reached before PATH is consulted.
        working: false,
      };
    case "foreign":
      // Refused rather than offered. Somebody installed that on purpose, and replacing it is not
      // this application's decision to take.
      return {
        summary: `Something else is already installed at ${state.path}.`,
        action: "none",
        actionLabel: null,
        instruction: `Remove ${state.path} yourself if you want MarkPDF's command there.`,
        working: false,
      };
    // The three states below are all "ours is installed, and typing the name may not reach it".
    // Removal is still offered, because a command that is installed is a command somebody may
    // want gone; the instruction is what actually fixes the problem.
    case "shadowed":
      return {
        summary: `Another ${status.command} at ${state.shadowedBy} is found first, so that is the one that runs.`,
        action: "remove",
        actionLabel: "Remove command",
        instruction: `Put ${status.installDirectory} earlier in your PATH, or remove ${state.shadowedBy}.`,
        working: false,
      };
    case "not-on-path":
      return {
        summary: `The ${status.command} command is installed, but ${status.installDirectory} is not on your PATH.`,
        action: "remove",
        actionLabel: "Remove command",
        instruction: `Add this line to your shell profile: ${status.pathHint}`,
        working: false,
      };
    case "not-executable":
      // Installed, ours, and unable to start. Reinstalling rewrites it with the right mode, so
      // there is a button rather than an instruction.
      return {
        summary: `The ${status.command} command is installed at ${state.path}, but your shell cannot run it.`,
        action: "reinstall",
        actionLabel: "Repair command",
        instruction: null,
        working: false,
      };
    case "path-unknown":
      // Said plainly rather than guessed. An application launched from Finder inherits a minimal
      // PATH, so when the login shell could not be asked there is nothing to conclude.
      return {
        summary: `The ${status.command} command is installed at ${state.path}.`,
        action: "remove",
        actionLabel: "Remove command",
        instruction: status.onDefaultPath
          ? null
          : `MarkPDF could not read your shell's PATH, so it cannot tell whether typing ${status.command} reaches it. If it does not: ${status.pathHint}`,
        working: false,
      };
  }
}
