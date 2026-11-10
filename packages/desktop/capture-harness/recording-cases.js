const fs = require("node:fs");
const path = require("node:path");

const CASE_FILE = /^recording-([a-z0-9]+(?:-[a-z0-9]+)*)-case\.js$/;

// Case modules describe their process phases and load Electron-only APIs inside run().
// The launcher also reads the metadata under plain Node before it starts Electron.
function loadRecordingCases(directory, selection) {
  if (selection !== undefined && !selection.trim()) {
    throw new Error("recording case selection is empty");
  }
  const cases = fs
    .readdirSync(directory)
    .sort()
    .flatMap((file) => {
      const match = CASE_FILE.exec(file);
      if (!match || (selection !== undefined && match[1] !== selection)) return [];
      const entry = require(path.join(directory, file));
      const phases = entry.phases;
      if (
        entry.name !== match[1] ||
        typeof entry.run !== "function" ||
        !Array.isArray(phases) ||
        !(
          (phases.length === 1 && phases[0] === "single") ||
          (phases.length === 2 && phases[0] === "write" && phases[1] === "read")
        )
      ) {
        throw new Error(`invalid recording case ${file}`);
      }
      return [entry];
    });

  if (selection !== undefined) {
    if (cases.length !== 1) throw new Error(`unknown recording case ${selection}`);
    return cases;
  }
  if (cases.length === 0) throw new Error("recording group has no cases");
  return cases;
}

function validateRecordingResults(name, results) {
  if (!Array.isArray(results) || results.length === 0) {
    throw new Error(`recording case ${name} produced no results`);
  }
  for (const result of results) {
    if (!result || result.pass !== true) {
      throw new Error(`recording case ${name} reported a failed result`);
    }
    // An observed limitation is an explicit, successful feasibility result.
    if (
      result.limitation !== undefined &&
      (typeof result.limitation !== "string" || !result.limitation.trim())
    ) {
      throw new Error(`recording case ${name} has an invalid limitation`);
    }
  }
}

function validateRecordingPhase(entry, phase) {
  if (!phase || !entry.phases.includes(phase)) {
    throw new Error(`invalid phase ${phase || "(missing)"} for recording case ${entry.name}`);
  }
}

module.exports = { loadRecordingCases, validateRecordingPhase, validateRecordingResults };
