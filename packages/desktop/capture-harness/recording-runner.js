const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { spawnSync } = require("node:child_process");
const { loadRecordingCases } = require("./recording-cases.js");

function runRecordingCases({ cases, electron, launch = spawnSync, environment = process.env }) {
  if (!electron) throw new Error("recording harness requires the Electron executable");
  const runId = randomUUID();
  for (const entry of cases) {
    for (const phase of entry.phases) {
      const result = launch(electron, [path.join(__dirname, "main.js")], {
        stdio: "inherit",
        env: {
          ...environment,
          PASEO_CAPTURE_HARNESS_CASE: entry.name,
          PASEO_CAPTURE_HARNESS_PHASE: phase,
          PASEO_CAPTURE_HARNESS_RUN_ID: runId,
        },
      });
      if (result.error) throw result.error;
      if (result.status !== 0) {
        throw new Error(
          `recording case ${entry.name} phase ${phase} failed (${result.signal || result.status})`,
        );
      }
    }
  }
}

if (require.main === module) {
  try {
    const cases = loadRecordingCases(__dirname, process.env.PASEO_CAPTURE_HARNESS_CASE);
    runRecordingCases({ cases, electron: process.env.PASEO_CAPTURE_HARNESS_ELECTRON });
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  }
}

module.exports = { runRecordingCases };
