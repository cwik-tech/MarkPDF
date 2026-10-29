import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { watch } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { requirePreparationPath, parsePreparationReply, type PreparationReply } from "./preparation.js";

export const preparationConcurrency = 1;
export const preparationDeadlineMs = 600_000;
export function preparationDirectory(dataDir: string): string { return join(dataDir, "session", "preparations"); }
export async function prepareDesktopDocument(input: { path: string; dataDir: string; signal: AbortSignal }): Promise<PreparationReply> {
  const targetPath = requirePreparationPath(resolve(input.path));
  const id = randomUUID();
  const directory = preparationDirectory(input.dataDir);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const requestFile = join(directory, `${id}.request.json`);
  const resultFile = join(directory, `${id}.result.json`);
  await writeFile(requestFile, JSON.stringify({ path: targetPath }), { mode: 0o600, flag: "wx" });
  return await new Promise<PreparationReply>((resolveReply, reject) => {
    let finished = false;
    const finish = (reply: PreparationReply, acknowledged = true): void => {
      if (finished) return;
      finished = true;
      clearTimeout(timer); watcher.close(); input.signal.removeEventListener("abort", cancel);
      if (!acknowledged) { resolveReply(reply); return; }
      void Promise.all([rm(requestFile, { force: true }), rm(resultFile, { force: true }), rm(join(directory, `${id}.cancel`), { force: true })]).then(() => resolveReply(reply), reject);
    };
    const check = async (): Promise<void> => {
      try { const value: unknown = JSON.parse(await readFile(resultFile, "utf8")); const reply = parsePreparationReply(value); if (reply.requestId !== id) throw new Error("Mismatched preparation result"); finish(reply); }
      catch (error) {
        if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return;
        cancel(); finish({ status: "failed", save: "unknown", reason: "Invalid desktop preparation result; cancellation requested" }, false);
      }
    };
    const cancel = (): void => { void writeFile(join(directory, `${id}.cancel`), "cancel", { mode: 0o600 }).catch(() => finish({ status: "failed", save: "unknown", reason: "Could not record cancellation; inspect the document before retrying" }, false)); };
    const watcher = watch(directory, () => { void check(); });
    watcher.on("error", () => { cancel(); finish({ status: "failed", save: "unknown", reason: "Preparation watcher failed; cancellation requested, save outcome unknown" }, false); });
    const timer = setTimeout(() => { cancel(); finish({ status: "failed", save: "unknown", reason: "Preparation timed out; cancellation requested, save outcome unknown" }, false); }, preparationDeadlineMs);
    input.signal.addEventListener("abort", cancel, { once: true });
    const args = process.execPath.includes("node_modules/electron/") ? [fileURLToPath(new URL("../../dist-electron/bootstrap.js", import.meta.url))] : [];
    const { ELECTRON_RUN_AS_NODE: _nodeMode, ...environment } = process.env;
    const child = spawn(process.execPath, [...args, `--markpdf-prepare=${id}`], { env: { ...environment, MARKPDF_DATA_DIR: input.dataDir }, detached: true, stdio: "ignore" });
    child.once("error", () => finish({ status: "failed", save: "failed", reason: "Could not launch MarkPDF" }));
    child.unref();
    if (input.signal.aborted) cancel();
    void check();
  });
}
