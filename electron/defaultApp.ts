import { app } from "electron";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type DefaultAppFileTypeId = "pdf" | "markdown";

export interface DefaultAppFileTypeStatus {
  id: DefaultAppFileTypeId;
  label: string;
  description: string;
  isDefault: boolean;
  currentAppName: string | null;
  currentBundleId: string | null;
}

export interface DefaultAppStatus {
  supported: boolean;
  reason?: string;
  bundleId: string | null;
  bundlePath: string | null;
  fileTypes: DefaultAppFileTypeStatus[];
}

interface DefaultAppFileType {
  id: DefaultAppFileTypeId;
  label: string;
  description: string;
  contentTypes: string[];
}

interface HandlerReport {
  bundleId: string | null;
  handlers: { contentType: string; bundleId: string | null; appName: string | null }[];
}

const defaultAppFileTypes: DefaultAppFileType[] = [
  {
    id: "pdf",
    label: "PDF documents",
    description: ".pdf",
    contentTypes: ["com.adobe.pdf"]
  },
  {
    id: "markdown",
    label: "Markdown documents",
    description: ".md, .markdown",
    contentTypes: ["net.daringfireball.markdown"]
  }
];

// LaunchServices has no Electron binding, so the read and write both go through
// osascript's Objective-C bridge. LSSetDefaultRoleHandlerForContentType is
// deprecated but is still the only synchronous way to claim a content type; the
// non-deprecated NSWorkspace replacement needs UniformTypeIdentifiers, which the
// JXA bridge cannot import.
const handlerScript = `
function run(argv) {
  ObjC.import("AppKit");
  ObjC.bindFunction("LSCopyDefaultRoleHandlerForContentType", ["id", ["id", "unsigned int"]]);
  ObjC.bindFunction("LSSetDefaultRoleHandlerForContentType", ["int", ["id", "unsigned int", "id"]]);

  var ROLES_ALL = 0xffffffff;
  var mode = argv[0];
  var bundlePath = argv[1];
  var contentTypes = argv.slice(2);

  function toText(value) {
    if (!value) return null;
    try {
      if (typeof value.isNil === "function" && value.isNil()) return null;
    } catch (error) {
      return null;
    }
    var text = ObjC.unwrap(value);
    return typeof text === "string" && text.length > 0 ? text : null;
  }

  function appNameForBundleId(bundleId) {
    if (!bundleId) return null;
    var url = $.NSWorkspace.sharedWorkspace.URLForApplicationWithBundleIdentifier($(bundleId));
    var name = toText(url ? url.lastPathComponent : null);
    return name ? name.replace(/\\.app$/, "") : null;
  }

  var bundle = $.NSBundle.bundleWithPath(bundlePath);
  var selfBundleId = bundle ? toText(bundle.bundleIdentifier) : null;

  if (mode === "set" && selfBundleId) {
    for (var i = 0; i < contentTypes.length; i++) {
      $.LSSetDefaultRoleHandlerForContentType($(contentTypes[i]), ROLES_ALL, $(selfBundleId));
    }
  }

  var handlers = contentTypes.map(function (contentType) {
    var handlerBundleId = toText($.LSCopyDefaultRoleHandlerForContentType($(contentType), ROLES_ALL));
    return {
      contentType: contentType,
      bundleId: handlerBundleId,
      appName: appNameForBundleId(handlerBundleId)
    };
  });

  return JSON.stringify({ bundleId: selfBundleId, handlers: handlers });
}
`;

function appBundlePath() {
  const executablePath = app.getPath("exe");
  const marker = executablePath.lastIndexOf(".app/Contents/MacOS/");
  return marker === -1 ? null : executablePath.slice(0, marker + 4);
}

function unsupportedStatus(reason: string): DefaultAppStatus {
  return {
    supported: false,
    reason,
    bundleId: null,
    bundlePath: null,
    fileTypes: defaultAppFileTypes.map((fileType) => ({
      id: fileType.id,
      label: fileType.label,
      description: fileType.description,
      isDefault: false,
      currentAppName: null,
      currentBundleId: null
    }))
  };
}

async function runHandlerScript(
  mode: "status" | "set",
  bundlePath: string,
  contentTypes: string[]
): Promise<HandlerReport> {
  const { stdout } = await execFileAsync(
    "osascript",
    ["-l", "JavaScript", "-e", handlerScript, mode, bundlePath, ...contentTypes],
    { timeout: 20_000 }
  );
  return JSON.parse(stdout.trim());
}

function toStatus(bundlePath: string, report: HandlerReport): DefaultAppStatus {
  const handlerByContentType = new Map(report.handlers.map((handler) => [handler.contentType, handler]));

  return {
    supported: true,
    bundleId: report.bundleId,
    bundlePath,
    fileTypes: defaultAppFileTypes.map((fileType) => {
      const handlers = fileType.contentTypes.map((contentType) => handlerByContentType.get(contentType));
      const isDefault =
        report.bundleId !== null &&
        handlers.every((handler) => handler?.bundleId === report.bundleId);
      const current = handlers.find((handler) => handler?.bundleId) ?? handlers[0];

      return {
        id: fileType.id,
        label: fileType.label,
        description: fileType.description,
        isDefault,
        currentAppName: current?.appName ?? null,
        currentBundleId: current?.bundleId ?? null
      };
    })
  };
}

function allContentTypes() {
  return defaultAppFileTypes.flatMap((fileType) => fileType.contentTypes);
}

function unavailableReason() {
  if (process.platform !== "darwin") {
    return "Setting MarkPDF as the default application is only available on macOS.";
  }
  if (!app.isPackaged) {
    return "Run the packaged MarkPDF app to change default file handlers. In development the running bundle is Electron, not MarkPDF.";
  }
  if (!appBundlePath()) {
    return "MarkPDF is not running from an application bundle, so macOS cannot register it as a handler.";
  }
  return null;
}

export async function getDefaultAppStatus(): Promise<DefaultAppStatus> {
  const reason = unavailableReason();
  if (reason) return unsupportedStatus(reason);

  const bundlePath = appBundlePath();
  if (!bundlePath) return unsupportedStatus("MarkPDF is not running from an application bundle.");

  try {
    return toStatus(bundlePath, await runHandlerScript("status", bundlePath, allContentTypes()));
  } catch (error) {
    return unsupportedStatus(
      error instanceof Error ? error.message : "Could not read the current default applications."
    );
  }
}

export async function setAsDefaultApp(fileTypeIds: DefaultAppFileTypeId[]): Promise<DefaultAppStatus> {
  const reason = unavailableReason();
  if (reason) return unsupportedStatus(reason);

  const bundlePath = appBundlePath();
  if (!bundlePath) return unsupportedStatus("MarkPDF is not running from an application bundle.");

  const requested = defaultAppFileTypes.filter((fileType) => fileTypeIds.includes(fileType.id));
  const contentTypes = requested.flatMap((fileType) => fileType.contentTypes);
  if (contentTypes.length === 0) return getDefaultAppStatus();

  await runHandlerScript("set", bundlePath, contentTypes);

  // LaunchServices commits the change asynchronously and caches lookups per
  // process, so the confirming read has to happen in a fresh osascript run and
  // may need a moment to see the new handler.
  let status = await getDefaultAppStatus();
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const settled = requested.every(
      (fileType) => status.fileTypes.find((entry) => entry.id === fileType.id)?.isDefault
    );
    if (settled) break;
    await new Promise((resolve) => setTimeout(resolve, 250));
    status = await getDefaultAppStatus();
  }

  return status;
}
