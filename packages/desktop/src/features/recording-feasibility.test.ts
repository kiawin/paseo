import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const { required, verifyFeasibility } =
  require("../../capture-harness/recording-verify-feasibility.js") as {
    required: string[];
    verifyFeasibility: (
      data: {
        platform: string;
        records: Array<{ name: string; status: string; detail?: string }>;
        fixturePath: string;
        runId: string;
      },
      platform: string,
      readFixture: (path: string) => string,
      runId: string,
    ) => void;
  };

function report() {
  return {
    platform: "linux",
    records: required.map((name) => ({ name, status: "pass" })),
    fixturePath: "/synthetic/fixture.json",
    runId: "fresh-run",
  };
}

const validFixture = () =>
  JSON.stringify({
    events: [
      "Network.requestWillBeSent",
      "Network.responseReceived",
      "Target.attachedToTarget",
    ].map((method) => ({ method })),
    popupFixtures: [
      {
        events: [{ method: "Network.requestWillBeSent" }, { method: "Network.responseReceived" }],
        body: { body: "synthetic" },
      },
    ],
    bodyFixtures: [
      { case: "missing-response", error: "missing" },
      { case: "post-response", result: { body: "synthetic" } },
      { case: "oversized-response", error: "evicted" },
    ],
  });
const emptyFixture = () => "[]";
const noPopupFixture = () => {
  const fixture = JSON.parse(validFixture());
  fixture.popupFixtures = [];
  return JSON.stringify(fixture);
};
const noBodyFixture = () => {
  const fixture = JSON.parse(validFixture());
  fixture.bodyFixtures = [];
  return JSON.stringify(fixture);
};

describe("recording feasibility gate", () => {
  it("accepts complete observations for the current platform", () => {
    expect(() => verifyFeasibility(report(), "linux", validFixture, "fresh-run")).not.toThrow();
  });

  it("rejects missing, duplicate and unverified required observations", () => {
    const missing = report();
    missing.records.pop();
    expect(() => verifyFeasibility(missing, "linux", validFixture, "fresh-run")).toThrow("missing");
    const duplicate = report();
    duplicate.records.push({ ...duplicate.records[0]! });
    expect(() => verifyFeasibility(duplicate, "linux", validFixture, "fresh-run")).toThrow();
    const unverified = report();
    unverified.records[0]!.status = "unverified";
    expect(() => verifyFeasibility(unverified, "linux", validFixture, "fresh-run")).toThrow(
      "unverified",
    );
    unverified.records[0]!.status = "partial";
    expect(() => verifyFeasibility(unverified, "linux", validFixture, "fresh-run")).toThrow(
      "partial",
    );
    unverified.records[0]!.status = "limitation";
    expect(() => verifyFeasibility(unverified, "linux", validFixture, "fresh-run")).toThrow(
      "limitation",
    );
  });

  it("rejects a wrong platform, stale report and empty fixture", () => {
    expect(() => verifyFeasibility(report(), "darwin", validFixture, "fresh-run")).toThrow(
      "current platform",
    );
    expect(() => verifyFeasibility(report(), "linux", validFixture, "other-run")).toThrow("stale");
    expect(() => verifyFeasibility(report(), "linux", emptyFixture, "fresh-run")).toThrow(
      "fixture lacks",
    );
    expect(() => verifyFeasibility(report(), "linux", noPopupFixture, "fresh-run")).toThrow(
      "popup request",
    );
    expect(() => verifyFeasibility(report(), "linux", noBodyFixture, "fresh-run")).toThrow(
      "body and missing-body",
    );
  });

  it("permits an explicit optional-audio denial but not an unverified result", () => {
    const data = report();
    const audio = data.records.find((entry) => entry.name === "audio")! as {
      name: string;
      status: string;
      detail?: string;
    };
    audio.status = "denied";
    audio.detail = "permission denied";
    expect(() => verifyFeasibility(data, "linux", validFixture, "fresh-run")).not.toThrow();
    audio.detail = "";
    expect(() => verifyFeasibility(data, "linux", validFixture, "fresh-run")).toThrow("denied");
    audio.status = "unverified";
    expect(() => verifyFeasibility(data, "linux", validFixture, "fresh-run")).toThrow("unverified");
  });
});
