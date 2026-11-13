const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { report, verifyFeasibility } = require("./recording-verify-feasibility.js");

const runId = crypto.randomUUID();
const markdownReport = path.join(path.dirname(report), "feasibility.md");
const environment = {
  ...process.env,
  PASEO_CAPTURE_HARNESS_GROUP: "recording",
  PASEO_RECORDING_FEASIBILITY_RUN_ID: runId,
};
delete environment.PASEO_CAPTURE_HARNESS_CASE;
delete environment.PASEO_CAPTURE_HARNESS_PHASE;
fs.mkdirSync(path.dirname(markdownReport), { recursive: true });
fs.appendFileSync(
  markdownReport,
  `\n## Latest feasibility run\n\nRun ${runId}: in progress; earlier results are not current.\n`,
);
const result = spawnSync(
  process.platform === "win32" ? "npm.cmd" : "npm",
  ["run", "capture-harness", "--workspace=@getpaseo/desktop"],
  {
    stdio: "inherit",
    shell: process.platform === "win32",
    env: environment,
  },
);
let observations;
try {
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(`recording harness failed: ${result.signal || result.status}`);
  observations = JSON.parse(fs.readFileSync(report, "utf8"));
  verifyFeasibility(observations, process.platform, undefined, runId);
  const message = `Required feasibility probes passed for ${process.platform}: ${report}`;
  const limitations = observations.records
    .filter((entry) => entry.status !== "pass")
    .map((entry) => `- ${entry.name}: ${entry.status}: ${entry.detail.replace(/\n/g, " ")}`);
  fs.appendFileSync(
    markdownReport,
    `\n## Gate verification\n\nCommand: \`node packages/desktop/capture-harness/recording-run-feasibility.js\`\n\nResult: ${message}\n\nRecorded limitations:\n${limitations.join("\n")}\n`,
  );
  console.log(message);
} catch (error) {
  fs.appendFileSync(
    markdownReport,
    `\n## Latest feasibility run\n\nRun ${runId}: failed: ${error.message}. Earlier results are not current.\n`,
  );
  console.error(error);
  process.exitCode = 1;
}
