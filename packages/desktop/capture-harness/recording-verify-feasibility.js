const fs = require("node:fs");
const path = require("node:path");

const report = path.resolve(
  __dirname,
  `../../../.loop-design/browser-recording/feasibility-${process.platform}.json`,
);
const required = [
  "request and response bodies",
  "missing body evidence",
  "oversized body eviction",
  "redirect, binary, and failure evidence",
  "WebSocket and EventSource events",
  "cross-origin and nested frames",
  "reload continuity",
  "cross-origin navigation continuity",
  "popup early debugger attachment",
  "parked tab video with screenshot",
  "parked tab media video",
  "parked tab audio",
  "never-shown popup media video",
  "audio-denial video-only fallback",
  "audio",
  "automation and DevTools coexistence",
  "forced debugger detach and recovery",
  "guest replacement lifecycle",
];

function verifyObservations(data, platform, runId) {
  if (data.platform !== platform || !Array.isArray(data.records)) {
    throw new Error("feasibility report does not match the current platform");
  }
  if (!runId || data.runId !== runId)
    throw new Error("feasibility report is stale or has no run identifier");
  for (const name of required) {
    const matches = data.records.filter((entry) => entry.name === name);
    const audioUnavailable =
      ["audio", "parked tab audio"].includes(name) &&
      ["unavailable", "denied"].includes(matches[0]?.status) &&
      Boolean(matches[0]?.detail?.trim());
    if (matches.length !== 1 || (matches[0].status !== "pass" && !audioUnavailable)) {
      throw new Error(`${name}: ${matches[0]?.status || "missing"}; inspect ${report}`);
    }
  }
}

function verifyFixture(fixture) {
  const methods = new Set((fixture.events || []).map((entry) => entry.method));
  for (const method of [
    "Network.requestWillBeSent",
    "Network.responseReceived",
    "Target.attachedToTarget",
  ]) {
    if (!methods.has(method)) throw new Error(`captured CDP fixture lacks ${method}`);
  }
  if (
    !fixture.popupFixtures?.some(
      (entry) =>
        entry.events?.some((event) => event.method === "Network.requestWillBeSent") &&
        entry.events?.some((event) => event.method === "Network.responseReceived") &&
        entry.body?.body,
    )
  )
    throw new Error("captured popup request, response or body fixture is missing");
  if (
    !fixture.bodyFixtures?.some((entry) => entry.case === "missing-response" && entry.error) ||
    !fixture.bodyFixtures?.some((entry) => entry.case === "post-response" && entry.result?.body) ||
    !fixture.bodyFixtures?.some(
      (entry) =>
        entry.case === "oversized-response" &&
        (entry.error || entry.capturedLength < entry.received),
    )
  )
    throw new Error("captured body and missing-body evidence is missing");
}

function verifyFeasibility(
  data,
  platform,
  readFixture = (file) => fs.readFileSync(file, "utf8"),
  runId,
) {
  verifyObservations(data, platform, runId);
  verifyFixture(JSON.parse(readFixture(data.fixturePath)));
}

module.exports = { report, required, verifyFeasibility };
