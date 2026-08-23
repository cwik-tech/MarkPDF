import { describe, expect, it } from "vitest";
import { TEST_INSTALL_DIRECTORY_TOKEN, testInstallDirectory } from "./installDirectorySelection.js";

/**
 * The seam that lets an Electron journey click the real Install button without writing into a
 * real `bin` directory.
 *
 * Every case below is a way the guard could be too permissive, because the consequence of that is
 * a shipped application putting a command somewhere nobody chose.
 */

const HERE = "/tmp/test-bin";
const allowing = {
  isPackaged: false,
  env: {
    MARKPDF_E2E_CLI_INSTALL: TEST_INSTALL_DIRECTORY_TOKEN,
    MARKPDF_TEST_USER_DATA: "/tmp/test-user-data",
    MARKPDF_TEST_CLI_INSTALL_DIR: HERE,
  },
};

describe("the only configuration that selects a test directory", () => {
  it("takes it when the build is unpackaged, opted in by the exact token, and isolated", () => {
    expect(testInstallDirectory(allowing)).toBe(HERE);
  });
});

describe("every way it must refuse", () => {
  it("refuses in a packaged build, whatever the environment says", () => {
    expect(testInstallDirectory({ ...allowing, isPackaged: true })).toBeNull();
  });

  it("refuses a truthy value that is not the token", () => {
    for (const value of ["1", "true", "yes", "test-install-directory "]) {
      expect(testInstallDirectory({ ...allowing, env: { ...allowing.env, MARKPDF_E2E_CLI_INSTALL: value } })).toBeNull();
    }
  });

  it("refuses when the flag is absent", () => {
    const { MARKPDF_E2E_CLI_INSTALL: _absent, ...env } = allowing.env;
    expect(testInstallDirectory({ ...allowing, env })).toBeNull();
  });

  it("refuses unless the run is already pointed at a test profile", () => {
    expect(testInstallDirectory({ ...allowing, env: { ...allowing.env, MARKPDF_TEST_USER_DATA: "" } })).toBeNull();
  });

  it("refuses a relative directory, which would mean wherever the process was launched from", () => {
    expect(testInstallDirectory({ ...allowing, env: { ...allowing.env, MARKPDF_TEST_CLI_INSTALL_DIR: "bin" } })).toBeNull();
  });

  it("refuses an empty directory", () => {
    expect(testInstallDirectory({ ...allowing, env: { ...allowing.env, MARKPDF_TEST_CLI_INSTALL_DIR: "" } })).toBeNull();
  });

  it("refuses when no directory is named at all", () => {
    const { MARKPDF_TEST_CLI_INSTALL_DIR: _absent, ...env } = allowing.env;
    expect(testInstallDirectory({ ...allowing, env })).toBeNull();
  });
});
