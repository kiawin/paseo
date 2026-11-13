import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
const { loadRecordingCases, validateRecordingPhase, validateRecordingResults } =
  require("../../capture-harness/recording-cases.js") as {
    loadRecordingCases: (
      directory: string,
      selection?: string,
    ) => Array<{ name: string; phases: string[] }>;
    validateRecordingResults: (name: string, results: unknown) => void;
    validateRecordingPhase: (entry: { name: string; phases: string[] }, phase: string) => void;
  };
const { runRecordingCases } = require("../../capture-harness/recording-runner.js") as {
  runRecordingCases: (options: {
    cases: Array<{ name: string; phases: string[] }>;
    electron: string;
    launch: (...args: unknown[]) => { status: number | null; signal?: string };
    environment: Record<string, string>;
  }) => void;
};

const temporaryDirectories: string[] = [];

function makeDirectory(): string {
  const directory = mkdtempSync(path.join(tmpdir(), "paseo-recording-cases-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("recording capture harness cases", () => {
  it("rejects an empty group and invalid selections", () => {
    const directory = makeDirectory();
    expect(() => loadRecordingCases(directory)).toThrow("recording group has no cases");
    expect(() => loadRecordingCases(directory, "")).toThrow("recording case selection is empty");
    expect(() => loadRecordingCases(directory, "unknown")).toThrow("unknown recording case");
  });

  it("discovers individual and two-process cases and selects exactly one", () => {
    const directory = makeDirectory();
    writeFileSync(
      path.join(directory, "recording-one-case.js"),
      'module.exports = { name: "one", phases: ["single"], run() {} };',
    );
    writeFileSync(
      path.join(directory, "recording-restart-case.js"),
      'module.exports = { name: "restart", phases: ["write", "read"], run() {} };',
    );
    expect(loadRecordingCases(directory).map((entry) => entry.name)).toEqual(["one", "restart"]);
    expect(loadRecordingCases(directory, "restart")[0]?.phases).toEqual(["write", "read"]);
  });

  it("rejects a case whose metadata does not match its filename", () => {
    const directory = makeDirectory();
    writeFileSync(
      path.join(directory, "recording-bad-case.js"),
      'module.exports = { name: "different", phases: ["read"], run() {} };',
    );
    expect(() => loadRecordingCases(directory)).toThrow("invalid recording case");
  });

  it("does not load unrelated broken cases when selecting one case", () => {
    const directory = makeDirectory();
    writeFileSync(path.join(directory, "recording-broken-case.js"), 'throw new Error("broken");');
    writeFileSync(
      path.join(directory, "recording-good-case.js"),
      'module.exports = { name: "good", phases: ["single"], run() {} };',
    );
    expect(loadRecordingCases(directory, "good").map((entry) => entry.name)).toEqual(["good"]);
    expect(() => loadRecordingCases(directory)).toThrow("broken");
  });

  it("accepts an explicit feasibility limitation and rejects behavioral failures", () => {
    expect(() =>
      validateRecordingResults("probe", [{ pass: true, limitation: "not supported" }]),
    ).not.toThrow();
    expect(() => validateRecordingResults("probe", [{ pass: false }])).toThrow("failed result");
    expect(() => validateRecordingResults("probe", [{ pass: true, limitation: "" }])).toThrow(
      "invalid limitation",
    );
    expect(() => validateRecordingResults("probe", [])).toThrow("no results");
  });

  it("rejects phases that do not belong to a selected case", () => {
    const entry = { name: "smoke", phases: ["single"] };
    expect(() => validateRecordingPhase(entry, "single")).not.toThrow();
    expect(() => validateRecordingPhase(entry, "read")).toThrow("invalid phase read");
  });

  it("runs write and read in order with one run identifier and stops on failure", () => {
    const launch = vi.fn(() => ({ status: 0 }));
    const cases = [{ name: "restart", phases: ["write", "read"] }];
    runRecordingCases({ cases, electron: "/electron", launch, environment: {} });
    const first = launch.mock.calls[0]?.[2] as { env: Record<string, string> };
    const second = launch.mock.calls[1]?.[2] as { env: Record<string, string> };
    expect([first.env.PASEO_CAPTURE_HARNESS_PHASE, second.env.PASEO_CAPTURE_HARNESS_PHASE]).toEqual(
      ["write", "read"],
    );
    expect(first.env.PASEO_CAPTURE_HARNESS_RUN_ID).toBe(second.env.PASEO_CAPTURE_HARNESS_RUN_ID);

    const failLaunch = vi.fn(() => ({ status: 1 }));
    expect(() =>
      runRecordingCases({ cases, electron: "/electron", launch: failLaunch, environment: {} }),
    ).toThrow("phase write failed");
    expect(failLaunch).toHaveBeenCalledTimes(1);
  });
});
