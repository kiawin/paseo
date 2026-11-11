import { expect, it, vi } from "vitest";
import { recoverBrowserRecordingsOnStartup } from "./startup-recovery.js";

it("runs recovery only with the single-instance lock and surfaces failures", async () => {
  const recover = vi.fn().mockResolvedValue(undefined);
  expect(await recoverBrowserRecordingsOnStartup({ recover }, false)).toBe(
    "single-instance-lock-disabled",
  );
  expect(recover).not.toHaveBeenCalled();
  expect(await recoverBrowserRecordingsOnStartup({ recover }, true)).toBeNull();
  recover.mockRejectedValueOnce(new Error("disk unavailable"));
  expect(await recoverBrowserRecordingsOnStartup({ recover }, true)).toBe("disk unavailable");
});
