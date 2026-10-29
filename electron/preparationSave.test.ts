import { it, expect } from "vitest";
import { mkdtemp, readFile, writeFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { savePreparation } from "./preparationSave.js";

it("replaces the expected source while preserving its permissions", async () => {
  const dir = await mkdtemp(join(tmpdir(), "markpdf-save-"));
  const path = join(dir, "source.pdf");
  try {
    await writeFile(path, "old", { mode: 0o640 });
    await savePreparation(path, Buffer.from("old"), Buffer.from("new"));
    expect(await readFile(path, "utf8")).toBe("new");
    expect((await stat(path)).mode & 0o777).toBe(0o640);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
it("leaves an externally changed source untouched", async () => {
  const dir = await mkdtemp(join(tmpdir(), "markpdf-conflict-"));
  const path = join(dir, "source.pdf");
  try {
    await writeFile(path, "external");
    await expect(savePreparation(path, Buffer.from("old"), Buffer.from("new"))).rejects.toThrow("changed");
    expect(await readFile(path, "utf8")).toBe("external");
  } finally { await rm(dir, { recursive: true, force: true }); }
});
