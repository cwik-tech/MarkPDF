import type {
  MessageBoxOptions,
  MessageBoxReturnValue,
  OpenDialogOptions,
  OpenDialogReturnValue,
} from "electron";
import {
  AllowlistFileError,
  AllowlistLockedError,
  readAllowlist,
} from "../dist-core/consent/allowlistFile.js";
import {
  changeFolderAccess,
  FolderMissingError,
  FolderMovedError,
  FolderNotListedError,
  FolderUnreadableError,
  listFolders,
  previewFolderChange,
  type FolderChangeResult,
  type FolderRow,
  type SettableLevel,
} from "../dist-core/consent/folderAccess.js";

export type FolderAccessReason =
  | "damaged" | "busy" | "lock-abandoned" | "changed"
  | "missing" | "moved" | "unreadable" | "invalid" | "untrusted";
export type FolderAccessReply =
  | ({ ok: true; cancelled?: true; withdrawn?: string[] } & Omit<FolderChangeResult, "withdrawn">)
  | {
      ok: false;
      reason: FolderAccessReason;
      message: string;
      folders?: FolderRow[];
      recoverCommand?: string;
    };

interface Frame {
  url: string;
  detached: boolean;
  isDestroyed(): boolean;
}
interface SenderEvent {
  senderFrame: Frame | null;
  sender: { mainFrame: Frame; isDestroyed(): boolean };
}
interface WindowState {
  isDestroyed(): boolean;
}

/**
 * Trust only the application main frame in a live window. Compare the complete
 * normalized URL, ignoring its hash but refusing queries: file origins are all
 * "null", and an origin or prefix comparison would admit unrelated pages.
 * Main supplies the real BrowserWindow lookup. This does not prove a human click.
 */
export function isApplicationSender(
  event: SenderEvent,
  entryUrl: string,
  window: WindowState | null,
): boolean {
  try {
    const frame = event.senderFrame;
    if (
      frame === null || frame.isDestroyed() || frame.detached ||
      event.sender.isDestroyed() || frame !== event.sender.mainFrame ||
      window === null || window.isDestroyed()
    ) return false;
    const actual = new URL(frame.url);
    if (actual.search !== "") return false;
    actual.hash = "";
    return actual.href === entryUrl;
  } catch {
    // Detached frames can throw while their URL is being read; refuse them.
    return false;
  }
}

interface Dependencies<Event extends SenderEvent, Window extends WindowState> {
  dataDir: () => string;
  entryUrl: string;
  ipc: {
    handle(
      channel: string,
      handler: (event: Event, input?: unknown) => Promise<FolderAccessReply>,
    ): void;
  };
  windowFor: (event: Event) => Window | null;
  dialog: {
    showOpenDialog(window: Window, options: OpenDialogOptions): Promise<OpenDialogReturnValue>;
    showMessageBox(window: Window, options: MessageBoxOptions): Promise<MessageBoxReturnValue>;
  };
}

function isRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === "object" && input !== null && !Array.isArray(input);
}

function parsePath(input: unknown): string | undefined {
  return isRecord(input) && typeof input.path === "string" ? input.path : undefined;
}

function parseLevel(input: unknown): { path: string; level: SettableLevel } | undefined {
  if (
    !isRecord(input) || typeof input.path !== "string" ||
    (input.level !== "read" && input.level !== "read-write")
  ) return undefined;
  return { path: input.path, level: input.level };
}

function failure(error: unknown): FolderAccessReply {
  if (error instanceof AllowlistFileError) {
    return { ok: false, reason: "damaged", message: error.message };
  }
  if (error instanceof AllowlistLockedError) {
    return error.recoverCommand === undefined
      ? {
          ok: false,
          reason: "busy",
          message: "Another MarkPDF process is changing permissions. Try again.",
        }
      : {
          ok: false,
          reason: "lock-abandoned",
          message: error.message,
          recoverCommand: error.recoverCommand,
        };
  }
  if (error instanceof FolderNotListedError) {
    return { ok: false, reason: "changed", message: error.message, folders: error.folders };
  }
  if (error instanceof FolderMissingError) {
    return { ok: false, reason: "missing", message: error.message };
  }
  if (error instanceof FolderMovedError) {
    return { ok: false, reason: "moved", message: error.message };
  }
  if (error instanceof FolderUnreadableError) {
    return { ok: false, reason: "unreadable", message: error.message };
  }
  throw new Error("Folder access request failed unexpectedly", { cause: error });
}

const invalid: FolderAccessReply = {
  ok: false,
  reason: "invalid",
  message: "Invalid folder access request.",
};

export function registerFolderAccess<Event extends SenderEvent, Window extends WindowState>(
  deps: Dependencies<Event, Window>,
): void {
  const current = (cancelled = false): FolderAccessReply => ({
    ok: true,
    folders: listFolders(readAllowlist(deps.dataDir())),
    changed: false,
    withdrawn: [],
    ...(cancelled ? { cancelled: true } : {}),
  });
  const register = (
    name: string,
    handle: (window: Window, input: unknown) => Promise<FolderAccessReply>,
  ) => {
    deps.ipc.handle(`folder-access:${name}`, async (event, input) => {
      // No input or consent record is touched before this boundary accepts the sender.
      const window = deps.windowFor(event);
      if (!isApplicationSender(event, deps.entryUrl, window) || window === null) {
        return {
          ok: false,
          reason: "untrusted",
          message: "Only the MarkPDF application page can manage folder access.",
        };
      }
      try {
        return await handle(window, input);
      } catch (error) {
        return failure(error);
      }
    });
  };
  const confirm = async (
    window: Window,
    path: string,
    withdrawn: string[],
    remove: boolean,
  ): Promise<boolean> => {
    const affected = withdrawn.length === 0
      ? "" : `\n\nAlso withdraws access from:\n${withdrawn.join("\n")}`;
    const result = await deps.dialog.showMessageBox(window, {
      type: "warning",
      buttons: [remove ? "Remove folder" : "Change access", "Cancel"],
      defaultId: 1,
      cancelId: 1,
      message: remove ? "Remove folder access?" : "Withdraw write access?",
      detail: `${path}${affected}\n\nDocuments already indexed stay searchable and readable.`,
    });
    return result.response === 0;
  };

  register("list", async () => current());
  register("add", async window => {
    const picked = await deps.dialog.showOpenDialog(window, {
      properties: ["openDirectory", "createDirectory"],
    });
    if (picked.canceled) return current(true);
    const path = picked.filePaths[0];
    if (path === undefined) return invalid;
    return { ok: true, ...changeFolderAccess(deps.dataDir(), { kind: "add", path }, []) };
  });
  register("set-level", async (window, input) => {
    const parsed = parseLevel(input);
    if (parsed === undefined) return invalid;
    const change = {
      kind: "set-level", ...parsed,
    } satisfies Parameters<typeof previewFolderChange>[1];
    const preview = previewFolderChange(deps.dataDir(), change);
    if (preview.withdrawn.length > 0 && !(await confirm(window, parsed.path, preview.withdrawn, false))) {
      return current(true);
    }
    return { ok: true, ...changeFolderAccess(deps.dataDir(), change, preview.withdrawn) };
  });
  register("remove", async (window, input) => {
    const path = parsePath(input);
    if (path === undefined) return invalid;
    const change = { kind: "remove", path } satisfies Parameters<typeof previewFolderChange>[1];
    const preview = previewFolderChange(deps.dataDir(), change);
    if (!(await confirm(window, path, preview.withdrawn, true))) return current(true);
    return { ok: true, ...changeFolderAccess(deps.dataDir(), change, preview.withdrawn) };
  });
}
