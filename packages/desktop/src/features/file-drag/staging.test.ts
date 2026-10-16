import { mkdtemp, mkdir, readFile, readdir, rm, utimes } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  FILE_DRAG_STAGED_COPY_TTL_MS,
  FILE_DRAG_STAGING_MAX_BYTES,
  normalizeStagedFileName,
  pruneStagedFileDragCopies,
  resolveFileDragSourcePath,
  stageFileDragCopy,
} from "./staging";

describe("file drag staging", () => {
  let stagingRoot: string;

  beforeEach(async () => {
    stagingRoot = await mkdtemp(path.join(os.tmpdir(), "paseo-file-drag-test-"));
  });

  afterEach(async () => {
    await rm(stagingRoot, { recursive: true, force: true });
  });

  it("writes a staged copy under its original file name", async () => {
    const filePath = await stageFileDragCopy({
      stagingRoot,
      fileName: "report.pdf",
      bytes: new Uint8Array([1, 2, 3]),
    });

    expect(path.basename(filePath)).toBe("report.pdf");
    expect(path.dirname(path.dirname(filePath))).toBe(stagingRoot);
    expect([...(await readFile(filePath))]).toEqual([1, 2, 3]);
  });

  it("keeps a staged copy inside the staging root whatever name it is given", async () => {
    const filePath = await stageFileDragCopy({
      stagingRoot,
      fileName: "../../etc/passwd",
      bytes: new Uint8Array([1]),
    });

    expect(filePath.startsWith(stagingRoot + path.sep)).toBe(true);
    expect(path.basename(filePath)).toBe("passwd");
    expect(() => normalizeStagedFileName("..")).toThrow();
  });

  it("refuses bytes over the staging limit", async () => {
    await expect(
      stageFileDragCopy({
        stagingRoot,
        fileName: "big.bin",
        bytes: new Uint8Array(FILE_DRAG_STAGING_MAX_BYTES + 1),
      }),
    ).rejects.toThrow();
    expect(await readdir(stagingRoot)).toEqual([]);
  });

  it("prunes staged copies older than the TTL and keeps recent ones", async () => {
    const oldDir = path.join(stagingRoot, "old");
    const recentDir = path.join(stagingRoot, "recent");
    await mkdir(oldDir);
    await mkdir(recentDir);
    const now = Date.now();
    const old = new Date(now - FILE_DRAG_STAGED_COPY_TTL_MS - 1000);
    await utimes(oldDir, old, old);

    await pruneStagedFileDragCopies({ stagingRoot, now });

    expect(await readdir(stagingRoot)).toEqual(["recent"]);
  });

  it("only drags existing files by absolute path", async () => {
    const filePath = await stageFileDragCopy({
      stagingRoot,
      fileName: "a.txt",
      bytes: new Uint8Array([1]),
    });

    await expect(resolveFileDragSourcePath(filePath)).resolves.toBe(filePath);
    await expect(resolveFileDragSourcePath("a.txt")).rejects.toThrow();
    await expect(resolveFileDragSourcePath(stagingRoot)).rejects.toThrow();
    await expect(resolveFileDragSourcePath(path.join(stagingRoot, "missing"))).rejects.toThrow();
  });
});
