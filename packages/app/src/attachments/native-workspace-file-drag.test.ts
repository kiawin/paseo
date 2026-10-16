/** @vitest-environment jsdom */
import { describe, expect, it } from "vitest";
import {
  beginNativeWorkspaceFileDrag,
  takeNativeWorkspaceFileDrop,
  type NativeWorkspaceFileDrag,
} from "./native-workspace-file-drag";
import { createWorkspaceFileAttachment } from "./workspace-file";

function drag(localPath: string): NativeWorkspaceFileDrag {
  return {
    localPath,
    staged: false,
    payload: {
      version: 1,
      serverId: "server-1",
      workspaceId: "workspace-1",
      attachment: createWorkspaceFileAttachment({ path: "src/a.ts" }),
    },
  };
}

describe("native workspace file drag", () => {
  it("resolves a drop of the dragged file back to the drag", () => {
    const active = drag("/repo/src/a.ts");
    beginNativeWorkspaceFileDrag(active);

    expect(takeNativeWorkspaceFileDrop(["/repo/src/a.ts"])).toBe(active);
  });

  it("ends the drag on the first drop", () => {
    beginNativeWorkspaceFileDrag(drag("/repo/src/a.ts"));
    takeNativeWorkspaceFileDrop(["/elsewhere/b.ts"]);

    expect(takeNativeWorkspaceFileDrop(["/repo/src/a.ts"])).toBeNull();
  });

  it("does not claim drops of other or several files", () => {
    beginNativeWorkspaceFileDrag(drag("/repo/src/a.ts"));
    expect(takeNativeWorkspaceFileDrop(["/repo/src/b.ts"])).toBeNull();

    beginNativeWorkspaceFileDrag(drag("/repo/src/a.ts"));
    expect(takeNativeWorkspaceFileDrop(["/repo/src/a.ts", "/repo/src/b.ts"])).toBeNull();
  });

  it("ends the drag on the next press", () => {
    beginNativeWorkspaceFileDrag(drag("/repo/src/a.ts"));
    window.dispatchEvent(new Event("pointerdown"));

    expect(takeNativeWorkspaceFileDrop(["/repo/src/a.ts"])).toBeNull();
  });
});
