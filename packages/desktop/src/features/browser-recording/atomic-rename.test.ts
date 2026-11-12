import { expect, it, vi } from "vitest";
import { renameRecordingFile } from "./atomic-rename.js";

it("retries a transient Windows permission failure before replacing the file", async () => {
  const denied = Object.assign(new Error("locked"), { code: "EPERM" });
  const move = vi.fn().mockRejectedValueOnce(denied).mockResolvedValue(undefined);
  const wait = vi.fn().mockResolvedValue(undefined);
  await renameRecordingFile("temporary", "metadata", { platform: "win32", move, wait });
  expect(move).toHaveBeenCalledTimes(2);
  expect(move).toHaveBeenLastCalledWith("temporary", "metadata");
  expect(wait).toHaveBeenCalledTimes(1);
});
it("preserves the final error after a bounded retry and does not retry other errors", async () => {
  const denied = Object.assign(new Error("locked"), { code: "EPERM" });
  const move = vi.fn().mockRejectedValue(denied);
  const wait = vi.fn().mockResolvedValue(undefined);
  await expect(
    renameRecordingFile("temporary", "metadata", { platform: "win32", move, wait }),
  ).rejects.toBe(denied);
  expect(move).toHaveBeenCalledTimes(6);
  const failure = Object.assign(new Error("disk full"), { code: "ENOSPC" });
  move.mockReset().mockRejectedValue(failure);
  await expect(
    renameRecordingFile("temporary", "metadata", { platform: "win32", move, wait }),
  ).rejects.toBe(failure);
  expect(move).toHaveBeenCalledTimes(1);
});
