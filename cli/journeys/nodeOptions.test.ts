import { expect, it } from "vitest";
import { spawn } from "node:child_process";
import { OFFLINE_NODE_OPTIONS } from "./runCli.test-support.js";

it("loads the network block from a checkout whose path contains spaces", async () => {
  const result = await new Promise<{ code: number | null; stderr: string }>((resolve, reject) => {
    const child = spawn(process.execPath, ["-e", "fetch('data:text/plain,local').then(() => { process.exitCode = 1; }, error => { process.stderr.write(String(error)); })"], { env: { PATH: process.env.PATH ?? "", NODE_OPTIONS: OFFLINE_NODE_OPTIONS }, stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code) => resolve({ code, stderr }));
  });
  expect(result.stderr).toContain("NETWORK BLOCKED");
  expect(result.code).not.toBe(0);
});
