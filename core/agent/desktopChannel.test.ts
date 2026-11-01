import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { desktopRequestsDir } from "../paths.js";
import {
  removeExpiredDesktopFiles,
  sendDesktopRequest,
  takeDesktopRequest,
  writeDesktopAck,
  writeDesktopResult,
} from "./desktopChannel.js";
import type { DesktopRequest } from "./desktopRequests.js";

const ID = "12345678-1234-4234-8234-123456789012";
const OTHER = "87654321-4321-4321-8321-210987654321";

let dataDir: string;

function request(overrides: Partial<DesktopRequest> = {}): DesktopRequest {
  return {
    version: 1,
    id: ID,
    kind: "reveal",
    deadline: Date.now() + 10_000,
    target: { ref: "4242-1:tab-a" },
    page: 2,
    quote: "notice",
    agent: "claude-code",
    ...overrides,
  } as DesktopRequest;
}

beforeEach(() => {
  dataDir = realpathSync(mkdtempSync(join(tmpdir(), "markpdf-channel-")));
});

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

describe("a request from an agent to the desktop", () => {
  it("travels to the desktop once and comes back answered, leaving nothing behind", async () => {
    const result = await sendDesktopRequest({
      dataDir,
      request: request(),
      signal: new AbortController().signal,
      startDesktop: (id) => {
        const taken = takeDesktopRequest(dataDir, id, Date.now());
        if (!taken.ok) throw new Error(taken.message);
        writeDesktopAck(dataDir, id);
        writeDesktopResult(dataDir, id, { requestId: id, status: "shown", page: taken.request.page, occurrences: 1 });
        // A second delivery of the same id finds nothing to act on.
        expect(takeDesktopRequest(dataDir, id, Date.now())).toMatchObject({ ok: false, reason: "invalid_request" });
      },
    });

    expect(result).toMatchObject({ status: "shown", page: 2, occurrences: 1 });
    expect(readdirSync(desktopRequestsDir(dataDir))).toEqual([]);
  });

  it("keeps the request directory private", async () => {
    await sendDesktopRequest({
      dataDir,
      request: request(),
      signal: new AbortController().signal,
      ackTimeoutMs: 50,
      startDesktop: () => undefined,
    });
    expect(statSync(desktopRequestsDir(dataDir)).mode & 0o777).toBe(0o700);
  });

  it("answers at once when no desktop acknowledges, and withdraws the request", async () => {
    const result = await sendDesktopRequest({
      dataDir,
      request: request(),
      signal: new AbortController().signal,
      ackTimeoutMs: 100,
      startDesktop: () => undefined,
    });
    expect(result).toMatchObject({ status: "failed", reason: "no_answer" });
    expect(result.message).toContain("Restart MarkPDF");
    expect(readdirSync(desktopRequestsDir(dataDir))).toEqual([]);
  });

  it("refuses an answer to another request, and an oversized answer", async () => {
    for (const answer of [
      JSON.stringify({ requestId: OTHER, status: "shown" }),
      JSON.stringify({ requestId: ID, status: "shown", message: "x".repeat(20_000) }),
    ]) {
      const result = await sendDesktopRequest({
        dataDir,
        request: request(),
        signal: new AbortController().signal,
        startDesktop: (id) => {
          takeDesktopRequest(dataDir, id, Date.now());
          writeDesktopAck(dataDir, id);
          writeFileSync(join(desktopRequestsDir(dataDir), `${id}.result.json`), answer, { mode: 0o600 });
        },
      });
      expect(result).toMatchObject({ status: "failed" });
    }
  });

  it("stops waiting at the request's own deadline", async () => {
    const result = await sendDesktopRequest({
      dataDir,
      request: request({ deadline: Date.now() + 300 }),
      signal: new AbortController().signal,
      startDesktop: (id) => {
        takeDesktopRequest(dataDir, id, Date.now());
        writeDesktopAck(dataDir, id);
      },
    });
    expect(result).toMatchObject({ status: "failed", reason: "timeout" });
  });
});

describe("the desktop reading a request file", () => {
  function directory(): string {
    const path = desktopRequestsDir(dataDir);
    mkdirSync(path, { recursive: true, mode: 0o700 });
    return path;
  }

  it("refuses a link put in a request's place, and leaves what it points at alone", () => {
    const target = join(dataDir, "elsewhere.json");
    const content = JSON.stringify(request());
    writeFileSync(target, content);
    symlinkSync(target, join(directory(), `${ID}.request.json`));

    expect(takeDesktopRequest(dataDir, ID, Date.now())).toMatchObject({ ok: false, reason: "invalid_request" });
    expect(readFileSync(target, "utf8")).toBe(content);
  });

  it("refuses a request larger than the limit", () => {
    writeFileSync(join(directory(), `${ID}.request.json`), JSON.stringify({ ...request(), padding: "x".repeat(20_000) }));
    expect(takeDesktopRequest(dataDir, ID, Date.now())).toMatchObject({ ok: false, reason: "invalid_request" });
  });

  it("refuses a request id that is not one, before it builds any path", () => {
    expect(takeDesktopRequest(dataDir, "../../etc/passwd", Date.now())).toMatchObject({ ok: false, reason: "invalid_request" });
  });

  it("refuses an expired request by name", () => {
    writeFileSync(join(directory(), `${ID}.request.json`), JSON.stringify(request({ deadline: Date.now() - 1 })));
    expect(takeDesktopRequest(dataDir, ID, Date.now())).toMatchObject({ ok: false, reason: "expired" });
  });

  it("clears away old files it recognises, and nothing else", () => {
    const path = directory();
    const old = join(path, `${ID}.request.json`);
    const fresh = join(path, `${OTHER}.result.json`);
    const foreign = join(path, "notes.txt");
    for (const file of [old, fresh, foreign]) writeFileSync(file, "{}");
    const hourAgo = (Date.now() - 2 * 3_600_000) / 1000;
    utimesSync(old, hourAgo, hourAgo);
    utimesSync(foreign, hourAgo, hourAgo);

    removeExpiredDesktopFiles(dataDir, Date.now());

    expect(existsSync(old)).toBe(false);
    expect(existsSync(fresh)).toBe(true);
    expect(existsSync(foreign)).toBe(true);
  });
});
