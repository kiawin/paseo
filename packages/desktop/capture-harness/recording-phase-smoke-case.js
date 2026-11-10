const fs = require("node:fs/promises");
const path = require("node:path");

module.exports = {
  name: "phase-smoke",
  phases: ["write", "read"],
  async run({ phase, outDir, runId }) {
    if (typeof runId !== "string" || !/^[0-9a-f-]{36}$/.test(runId)) {
      throw new Error("recording phase smoke requires a valid run identifier");
    }
    const marker = path.join(outDir, `recording-phase-smoke-${runId}.json`);
    if (phase === "write") {
      await fs.writeFile(marker, JSON.stringify({ pid: process.pid }));
    } else {
      const previous = JSON.parse(await fs.readFile(marker, "utf8"));
      if (!Number.isInteger(previous.pid) || previous.pid === process.pid) {
        throw new Error("recording read phase did not start in a separate process");
      }
      await fs.unlink(marker);
    }
    return [{ group: "recording", check: "phase-smoke", phase, pass: true }];
  },
};
