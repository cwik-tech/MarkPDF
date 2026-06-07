const { spawn } = require("node:child_process");
const { mkdtemp, rm, stat } = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const SUBMIT_TIMEOUT = process.env.MARKPDF_NOTARY_TIMEOUT || "60m";
const HARD_TIMEOUT_MS = Number(process.env.MARKPDF_NOTARY_HARD_TIMEOUT_MS || 65 * 60 * 1000);

module.exports = async function notarizeMacos(context) {
  if (context.electronPlatformName !== "darwin") {
    return;
  }

  const credentials = {
    appleId: process.env.APPLE_ID,
    password: process.env.APPLE_APP_SPECIFIC_PASSWORD,
    teamId: process.env.APPLE_TEAM_ID,
  };
  const provided = Object.values(credentials).filter(Boolean).length;

  if (provided === 0) {
    console.log("Skipping macOS notarization because Apple credentials are not set.");
    return;
  }

  for (const [name, value] of Object.entries(credentials)) {
    if (!value) {
      throw new Error(`Missing Apple notarization credential: ${name}`);
    }
  }

  const appName = `${context.packager.appInfo.productFilename}.app`;
  const appPath = path.join(context.appOutDir, appName);
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "markpdf-notary-"));
  const zipPath = path.join(tempDir, `${context.packager.appInfo.productFilename}.zip`);

  try {
    console.log(`Preparing ${appName} for Apple notarization.`);
    await run("ditto", ["-c", "-k", "--sequesterRsrc", "--keepParent", appName, zipPath], {
      cwd: context.appOutDir,
      timeoutMs: 5 * 60 * 1000,
    });

    const { size } = await stat(zipPath);
    console.log(`Submitting ${Math.round(size / 1024 / 1024)} MB notarization archive with S3 acceleration disabled.`);

    const submit = await run(
      "xcrun",
      [
        "notarytool",
        "submit",
        zipPath,
        "--apple-id",
        credentials.appleId,
        "--password",
        credentials.password,
        "--team-id",
        credentials.teamId,
        "--wait",
        "--timeout",
        SUBMIT_TIMEOUT,
        "--no-s3-acceleration",
        "--output-format",
        "json",
      ],
      {
        allowFailure: true,
        timeoutMs: HARD_TIMEOUT_MS,
      }
    );

    const result = parseJsonOutput(submit.stdout || submit.stderr);
    const submissionId = result && result.id;

    if (submit.code !== 0 || !result || result.status !== "Accepted") {
      let logOutput = "";
      if (submissionId) {
        const log = await run(
          "xcrun",
          [
            "notarytool",
            "log",
            submissionId,
            "--apple-id",
            credentials.appleId,
            "--password",
            credentials.password,
            "--team-id",
            credentials.teamId,
          ],
          {
            allowFailure: true,
            timeoutMs: 5 * 60 * 1000,
          }
        );
        logOutput = `\n\nNotary log:\n${log.stdout || log.stderr}`.trimEnd();
      }

      throw new Error(`Apple notarization failed:\n${submit.stdout || submit.stderr}${logOutput}`);
    }

    console.log(`Apple notarization accepted: ${submissionId}`);
    await run("xcrun", ["stapler", "staple", appPath], { timeoutMs: 10 * 60 * 1000 });
    await run("xcrun", ["stapler", "validate", appPath], { timeoutMs: 5 * 60 * 1000 });
    console.log(`Stapled Apple notarization ticket to ${appName}.`);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
};

function parseJsonOutput(output) {
  const text = output.trim();
  if (!text) {
    return null;
  }

  try {
    return JSON.parse(text);
  } catch {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start === -1 || end === -1 || end <= start) {
      return null;
    }

    return JSON.parse(text.slice(start, end + 1));
  }
}

function run(command, args, options = {}) {
  const { allowFailure = false, timeoutMs = 10 * 60 * 1000, ...spawnOptions } = options;

  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      ...spawnOptions,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let killedForTimeout = false;

    const timer = setTimeout(() => {
      killedForTimeout = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 5000).unref();
    }, timeoutMs);

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
      process.stdout.write(chunk);
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
      process.stderr.write(chunk);
    });

    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });

    child.on("close", (code) => {
      clearTimeout(timer);

      if (killedForTimeout) {
        reject(new Error(`${command} timed out after ${Math.round(timeoutMs / 1000)} seconds.`));
        return;
      }

      const result = { code, stdout, stderr };
      if (code !== 0 && !allowFailure) {
        reject(new Error(`${command} exited with code ${code}.\n${stdout}${stderr}`));
        return;
      }

      resolve(result);
    });
  });
}
