import { describe, expect, it, vi } from "vitest";

describe("recording sharing", () => {
  async function setup() {
    const { createRecordingShare } = await import("./recording-share");
    const destination = {
      begin: vi.fn().mockResolvedValue("share-1"),
      upload: vi.fn().mockResolvedValue(undefined),
      complete: vi.fn().mockResolvedValue("/remote/manifest.json"),
      delete: vi.fn().mockResolvedValue(undefined),
    };
    const resolveDestination = vi.fn().mockReturnValue(destination);
    const confirm = vi.fn().mockResolvedValue(true);
    const audit = vi.fn().mockResolvedValue(undefined);
    const reserve = vi.fn().mockResolvedValue(undefined);
    const unreserve = vi.fn().mockResolvedValue(undefined);
    const handoff = vi.fn().mockResolvedValue(undefined);
    const source = {
      prepare: vi.fn().mockResolvedValue({
        recordingId: "rec-1",
        completeness: { complete: false, reasons: ["response body unavailable"] },
        segments: [
          {
            id: "events",
            size: 2,
            sha256: "a".repeat(64),
            read: async () => new Uint8Array([1, 2]),
          },
        ],
      }),
    };
    let tick = 123;
    const share = createRecordingShare({
      source,
      resolveDestination,
      confirm,
      audit,
      reserve,
      unreserve,
      handoff,
      now: () => tick++,
    });
    return {
      share,
      destination,
      resolveDestination,
      confirm,
      audit,
      reserve,
      unreserve,
      handoff,
      source,
    };
  }

  it("does nothing until explicitly invoked and shares to the selected remote agent", async () => {
    const s = await setup();
    expect(s.source.prepare).not.toHaveBeenCalled();
    expect(s.destination.begin).not.toHaveBeenCalled();
    await s.share({
      recordingId: "rec-1",
      serverId: "remote",
      agentId: "agent-2",
      agentName: "Remote agent",
    });
    expect(s.resolveDestination).toHaveBeenCalledWith("remote");
    expect(s.confirm).toHaveBeenCalledWith(
      expect.objectContaining({
        agentName: "Remote agent",
        containsSecrets: true,
        completeness: expect.objectContaining({ complete: false }),
      }),
    );
    expect(s.destination.begin).toHaveBeenCalledWith(
      expect.objectContaining({ recordingId: "rec-1", recipientAgentId: "agent-2" }),
    );
    expect(s.handoff).toHaveBeenCalledWith(
      expect.objectContaining({
        serverId: "remote",
        agentId: "agent-2",
        manifestPath: "/remote/manifest.json",
      }),
    );
    expect(s.audit).toHaveBeenCalledWith(
      expect.objectContaining({
        recordingId: "rec-1",
        serverId: "remote",
        agentId: "agent-2",
        shareId: "share-1",
        time: 123,
        completeness: expect.objectContaining({ complete: false }),
      }),
    );
  });

  it("does not transfer when confirmation is declined", async () => {
    const s = await setup();
    s.confirm.mockResolvedValue(false);
    await s.share({
      recordingId: "rec-1",
      serverId: "remote",
      agentId: "agent-2",
      agentName: "Remote agent",
    });
    expect(s.destination.begin).not.toHaveBeenCalled();
    expect(s.handoff).not.toHaveBeenCalled();
  });

  it("cleans up a failed transfer and does not hand off or audit it", async () => {
    const s = await setup();
    s.destination.upload.mockRejectedValue(new Error("connection lost"));
    await expect(
      s.share({
        recordingId: "rec-1",
        serverId: "remote",
        agentId: "agent-2",
        agentName: "Remote agent",
      }),
    ).rejects.toThrow("connection lost");
    expect(s.destination.delete).toHaveBeenCalledWith("share-1", "agent-2");
    expect(s.handoff).not.toHaveBeenCalled();
    expect(s.audit).not.toHaveBeenCalled();
  });
  it("removes the selected remote copy before deleting its local audit entry", async () => {
    const s = await setup();
    const { removeRecordingShare } = await import("./recording-share");
    const removeAudit = vi.fn().mockResolvedValue(undefined);
    const entry = {
      recordingId: "rec-1",
      serverId: "remote",
      agentId: "agent-2",
      shareId: "share-1",
      time: 123,
      completeness: { complete: false, reasons: ["gap"] },
      manifestPath: "/remote/manifest.json",
    };
    await removeRecordingShare(entry, s.resolveDestination, removeAudit);
    expect(s.resolveDestination).toHaveBeenCalledWith("remote");
    expect(s.destination.delete).toHaveBeenCalledWith("share-1", "agent-2");
    expect(removeAudit).toHaveBeenCalledWith("rec-1", "share-1");
    expect(s.destination.delete.mock.invocationCallOrder[0]).toBeLessThan(
      removeAudit.mock.invocationCallOrder[0],
    );
    s.destination.delete.mockRejectedValueOnce(new Error("offline"));
    removeAudit.mockClear();
    await expect(removeRecordingShare(entry, s.resolveDestination, removeAudit)).rejects.toThrow(
      "offline",
    );
    expect(removeAudit).not.toHaveBeenCalled();
  });
  it("routes a local selection to that host and agent", async () => {
    const s = await setup();
    await s.share({
      recordingId: "rec-1",
      serverId: "local",
      agentId: "agent-local",
      agentName: "Local agent",
    });
    expect(s.resolveDestination).toHaveBeenCalledWith("local");
    expect(s.destination.begin).toHaveBeenCalledWith(
      expect.objectContaining({ recipientAgentId: "agent-local" }),
    );
    expect(s.handoff).toHaveBeenCalledWith(
      expect.objectContaining({ serverId: "local", agentId: "agent-local" }),
    );
  });
  it("removes the pending copy if audit reservation fails", async () => {
    const s = await setup();
    s.reserve.mockRejectedValue(new Error("disk full"));
    await expect(
      s.share({
        recordingId: "rec-1",
        serverId: "remote",
        agentId: "agent-2",
        agentName: "Remote agent",
      }),
    ).rejects.toThrow("disk full");
    expect(s.destination.delete).toHaveBeenCalledWith("share-1", "agent-2");
    expect(s.destination.upload).not.toHaveBeenCalled();
    expect(s.unreserve).not.toHaveBeenCalled();
  });
  it("retains the reservation when transfer and remote cleanup both fail", async () => {
    const s = await setup();
    s.destination.upload.mockRejectedValue(new Error("upload failed"));
    s.destination.delete.mockRejectedValue(new Error("offline"));
    await expect(
      s.share({
        recordingId: "rec-1",
        serverId: "remote",
        agentId: "agent-2",
        agentName: "Remote agent",
      }),
    ).rejects.toThrow("cleanup also failed");
    expect(s.reserve).toHaveBeenCalledOnce();
    expect(s.unreserve).not.toHaveBeenCalled();
  });
  it("retains the reservation if final audit or agent handoff fails", async () => {
    const s = await setup();
    s.audit.mockRejectedValueOnce(new Error("disk full"));
    await expect(
      s.share({
        recordingId: "rec-1",
        serverId: "remote",
        agentId: "agent-2",
        agentName: "Remote agent",
      }),
    ).rejects.toThrow("disk full");
    expect(s.destination.delete).not.toHaveBeenCalled();
    expect(s.unreserve).not.toHaveBeenCalled();
    s.handoff.mockRejectedValueOnce(new Error("agent unavailable"));
    await expect(
      s.share({
        recordingId: "rec-1",
        serverId: "remote",
        agentId: "agent-2",
        agentName: "Remote agent",
      }),
    ).rejects.toThrow("agent unavailable");
    expect(s.destination.delete).not.toHaveBeenCalled();
    expect(s.unreserve).not.toHaveBeenCalled();
  });
  it("rejects an unavailable destination before reading the recording", async () => {
    const s = await setup();
    s.resolveDestination.mockImplementationOnce(() => {
      throw new Error("offline");
    });
    await expect(
      s.share({
        recordingId: "rec-1",
        serverId: "remote",
        agentId: "agent-2",
        agentName: "Remote agent",
      }),
    ).rejects.toThrow("offline");
    expect(s.source.prepare).not.toHaveBeenCalled();
    expect(s.confirm).not.toHaveBeenCalled();
  });
  it("uses the same audit time for the reservation and completed copy", async () => {
    const s = await setup();
    await s.share({
      recordingId: "rec-1",
      serverId: "remote",
      agentId: "agent-2",
      agentName: "Remote agent",
    });
    expect(s.reserve.mock.calls[0][0].time).toBe(s.audit.mock.calls[0][0].time);
  });
});
