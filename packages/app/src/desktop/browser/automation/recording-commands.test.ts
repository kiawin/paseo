import { describe, expect, it, vi } from "vitest";
import type { DesktopRecordingBridge, DesktopRecordingState } from "@/desktop/host";
import type { RecordingShareAudit } from "@/attachments/recording-share";
import { createAgentRecordingCommands } from "./recording-commands";

const BROWSER_ID = "11111111-1111-4111-8111-111111111111";
const caller = { serverId: "srv-1", agentId: "agent-1", workspaceId: "wks-1" };

function createBridge() {
  const events = new TextEncoder().encode('{"kind":"navigation"}\n');
  let active: DesktopRecordingState | null = null;
  const audit: RecordingShareAudit[] = [];
  const bridge = {
    active: vi.fn(async () => active),
    start: vi.fn(
      async (input: {
        browserId: string;
        audio?: boolean;
        agent?: { serverId: string; agentId: string };
      }) => {
        active = {
          recordingId: "rec-1",
          browserId: input.browserId,
          status: "recording",
          ...(input.agent ? { agent: input.agent } : {}),
        };
        return { recordingId: "rec-1", status: "recording" };
      },
    ),
    stop: vi.fn(async () => {
      active = null;
    }),
    list: vi.fn(async () => ({
      recordings: [
        { recordingId: "rec-1", workspaceId: "wks-1", startedAt: 1, status: "complete" as const },
      ],
      incomplete: [],
    })),
    readEvents: vi.fn(async () => ({ events: [], nextCursor: null, incompleteTail: false })),
    listMedia: vi.fn(async () => ({
      segments: [],
      incomplete: [],
      nextCursor: null,
      pending: false,
    })),
    readExportEvents: vi.fn(async (input: { offset: number; length: number }) => ({
      bytes: events.slice(input.offset, input.offset + input.length),
      totalBytes: events.byteLength,
    })),
    changeShareAudit: vi.fn(async (input: { entry?: RecordingShareAudit }) => {
      if (input.entry) audit.push(input.entry);
    }),
  };
  const startedByPerson = () => {
    active = { recordingId: "rec-person", browserId: BROWSER_ID, status: "recording" };
  };
  return {
    bridge: bridge as unknown as DesktopRecordingBridge,
    mocks: bridge,
    audit,
    startedByPerson,
  };
}

function createDestination() {
  return {
    begin: vi.fn(async () => "share-1"),
    upload: vi.fn(async () => undefined),
    complete: vi.fn(async () => "/home/paseo/recording-shares/share-1/manifest.json"),
    delete: vi.fn(async () => undefined),
  };
}

describe("agent recording commands", () => {
  it("returns once the copy starts and finishes it in the background", async () => {
    const { bridge, mocks, audit } = createBridge();
    const destination = createDestination();
    let releaseUpload!: () => void;
    const uploadGate = new Promise<undefined>((resolve) => {
      releaseUpload = () => resolve(undefined);
    });
    destination.upload.mockImplementation(() => uploadGate);
    const commands = createAgentRecordingCommands({
      resolveDestination: () => destination,
      now: () => 42,
    });

    await expect(
      commands.start({ bridge, caller, browserId: BROWSER_ID, audio: true }),
    ).resolves.toEqual({ recordingId: "rec-1" });
    expect(mocks.start).toHaveBeenCalledWith({
      browserId: BROWSER_ID,
      audio: true,
      agent: { serverId: "srv-1", agentId: "agent-1" },
    });

    await expect(commands.stop({ bridge, caller, browserId: BROWSER_ID })).resolves.toEqual({
      recordingId: "rec-1",
      status: "complete",
      complete: true,
      gaps: [],
    });
    expect(mocks.stop).toHaveBeenCalledWith({ recordingId: "rec-1" });
    expect(destination.begin).toHaveBeenCalledWith(
      expect.objectContaining({
        recordingId: "rec-1",
        recipientAgentId: "agent-1",
        notifyRecipient: { complete: true, gaps: [] },
      }),
    );
    expect(destination.complete).not.toHaveBeenCalled();

    releaseUpload();
    await vi.waitFor(() => expect(destination.complete).toHaveBeenCalledWith("share-1"));
    await vi.waitFor(() =>
      expect(audit.at(-1)).toMatchObject({
        recordingId: "rec-1",
        shareId: "share-1",
        manifestPath: "/home/paseo/recording-shares/share-1/manifest.json",
      }),
    );
  });

  it("removes the started copy when the upload fails, so the destination tells the agent", async () => {
    const { bridge } = createBridge();
    const destination = createDestination();
    destination.complete.mockRejectedValue(new Error("disk full"));
    const commands = createAgentRecordingCommands({
      resolveDestination: () => destination,
      now: () => 42,
    });
    await commands.start({ bridge, caller, browserId: BROWSER_ID, audio: false });

    await expect(commands.stop({ bridge, caller, browserId: BROWSER_ID })).resolves.toMatchObject({
      recordingId: "rec-1",
    });
    await vi.waitFor(() => expect(destination.delete).toHaveBeenCalledWith("share-1", "agent-1"));
  });

  it("stops the agent's recording after the window reloads", async () => {
    const { bridge } = createBridge();
    const destination = createDestination();
    const deps = { resolveDestination: () => destination, now: () => 42 };
    await createAgentRecordingCommands(deps).start({
      bridge,
      caller,
      browserId: BROWSER_ID,
      audio: false,
    });

    const afterReload = createAgentRecordingCommands(deps);
    await expect(
      afterReload.stop({ bridge, caller, browserId: BROWSER_ID }),
    ).resolves.toMatchObject({ recordingId: "rec-1" });
  });

  it("refuses to stop a recording the person started", async () => {
    const { bridge, mocks, startedByPerson } = createBridge();
    const destination = createDestination();
    const commands = createAgentRecordingCommands({
      resolveDestination: () => destination,
      now: () => 42,
    });
    startedByPerson();

    await expect(commands.stop({ bridge, caller, browserId: BROWSER_ID })).rejects.toMatchObject({
      code: "browser_denied",
    });
    expect(mocks.stop).not.toHaveBeenCalled();
    expect(destination.begin).not.toHaveBeenCalled();
  });

  it("refuses to stop another agent's recording", async () => {
    const { bridge, mocks } = createBridge();
    const destination = createDestination();
    const commands = createAgentRecordingCommands({
      resolveDestination: () => destination,
      now: () => 42,
    });
    await commands.start({ bridge, caller, browserId: BROWSER_ID, audio: false });

    await expect(
      commands.stop({ bridge, caller: { ...caller, agentId: "agent-2" }, browserId: BROWSER_ID }),
    ).rejects.toMatchObject({ code: "browser_denied" });
    expect(mocks.stop).not.toHaveBeenCalled();
  });

  it("names the stopped recording when the copy cannot start", async () => {
    const { bridge } = createBridge();
    const destination = createDestination();
    destination.begin.mockRejectedValue(new Error("Recording recipient is unavailable"));
    const commands = createAgentRecordingCommands({
      resolveDestination: () => destination,
      now: () => 42,
    });
    await commands.start({ bridge, caller, browserId: BROWSER_ID, audio: false });

    await expect(commands.stop({ bridge, caller, browserId: BROWSER_ID })).rejects.toThrow(
      "Recording rec-1 stopped, but copying it to this host failed: Recording recipient is unavailable. Share it from Recordings in the desktop app.",
    );
  });
});
