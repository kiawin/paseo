import type pino from "pino";

import { getErrorMessage } from "@getpaseo/protocol/error-utils";
import {
  encodeFileTransferFrame,
  FileTransferOpcode,
  TransferFlowControl,
} from "@getpaseo/protocol/binary-frames/index";

import type {
  ArtifactDeleteRequest,
  ArtifactEntryDownloadRequest,
  ArtifactListRequest,
  ArtifactPinSetRequest,
  ArtifactRecordPayload,
  FileTransferAck,
  FileTransferCancel,
  SessionOutboundMessage,
} from "../../messages.js";
import {
  ArtifactError,
  type ArtifactStore,
  type PersistedArtifactRecord,
} from "../../artifact-store.js";

/** Frames are sized well under the 8 MiB flow-control window, so several fit before an ack. */
const CHUNK_BYTES = 256 * 1024;

export interface ArtifactsSessionHost {
  emit(msg: SessionOutboundMessage, source?: object): void;
  emitBinary(frame: Uint8Array, source?: object): Promise<void>;
  hasBinaryChannel(): boolean;
}

export function toArtifactRecordPayload(record: PersistedArtifactRecord): ArtifactRecordPayload {
  return {
    artifactId: record.artifactId,
    projectId: record.projectId,
    title: record.title,
    mimeType: record.mimeType,
    size: record.size,
    contentSha256: record.contentSha256,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    pinned: record.pinned,
    externalUrl: record.externalUrl,
    origin: {
      agentId: record.origin.agentId,
      workspaceId: record.origin.workspaceId,
      provider: record.origin.provider,
    },
  };
}

/**
 * Session-side surface for the artifact store.
 *
 * Downloads reuse the workspace file-transfer machinery wholesale — the binary opcodes and
 * `fs.transfer.ack` / `fs.transfer.cancel` are keyed by requestId and carry no path, so they
 * are transport, not workspace semantics. The daemon keeps its own in-flight map here rather
 * than sharing the workspace one; the session routes ack and cancel to both, and each ignores a
 * requestId it does not own.
 *
 * HTTP is not an alternative. A relay answers only its own `/ws`, `/health`, `/ready` and
 * `/metrics`, so `GET /api/files/download` cannot reach the daemon on the connection this
 * feature exists for.
 */
export class ArtifactsSession {
  private readonly logger: pino.Logger;
  private readonly activeDownloads = new Map<string, { flow: TransferFlowControl }>();

  constructor(
    private readonly host: ArtifactsSessionHost,
    private readonly store: ArtifactStore | null,
    logger: pino.Logger,
  ) {
    this.logger = logger.child({ module: "artifacts-session" });
  }

  dispose(): void {
    for (const { flow } of this.activeDownloads.values()) flow.cancel();
    this.activeDownloads.clear();
  }

  async handleListRequest(request: ArtifactListRequest, source?: object): Promise<void> {
    const { projectId, requestId } = request;
    try {
      const records = await this.requireStore().listForProject(projectId);
      this.host.emit(
        {
          type: "artifact.list.response",
          payload: {
            projectId,
            artifacts: records.map(toArtifactRecordPayload),
            success: true,
            error: null,
            requestId,
          },
        },
        source,
      );
    } catch (error) {
      this.host.emit(
        {
          type: "artifact.list.response",
          payload: {
            projectId,
            artifacts: [],
            success: false,
            error: getErrorMessage(error),
            requestId,
          },
        },
        source,
      );
    }
  }

  async handleDeleteRequest(request: ArtifactDeleteRequest, source?: object): Promise<void> {
    const { artifactId, requestId } = request;
    try {
      const store = this.requireStore();
      const record = await store.get(artifactId);
      const removed = await store.delete(artifactId);
      if (!removed) throw new ArtifactError("artifact_not_found", `No artifact ${artifactId}`);
      this.host.emit(
        {
          type: "artifact.delete.response",
          payload: { artifactId, success: true, error: null, requestId },
        },
        source,
      );
      if (record) this.emitChanged(record.projectId, source);
    } catch (error) {
      this.host.emit(
        {
          type: "artifact.delete.response",
          payload: { artifactId, success: false, error: getErrorMessage(error), requestId },
        },
        source,
      );
    }
  }

  async handlePinSetRequest(request: ArtifactPinSetRequest, source?: object): Promise<void> {
    const { artifactId, pinned, requestId } = request;
    try {
      const record = await this.requireStore().setPinned(artifactId, pinned);
      if (!record) throw new ArtifactError("artifact_not_found", `No artifact ${artifactId}`);
      this.host.emit(
        {
          type: "artifact.pin.set.response",
          payload: {
            artifact: toArtifactRecordPayload(record),
            success: true,
            error: null,
            requestId,
          },
        },
        source,
      );
      this.emitChanged(record.projectId, source);
    } catch (error) {
      this.host.emit(
        {
          type: "artifact.pin.set.response",
          payload: {
            artifact: null,
            success: false,
            error: getErrorMessage(error),
            requestId,
          },
        },
        source,
      );
    }
  }

  /**
   * The client registers a sink for `requestId` before sending the request, so the metadata
   * response and the frames behind it both land on a receiver that already exists.
   */
  async handleEntryDownloadRequest(
    request: ArtifactEntryDownloadRequest,
    source?: object,
  ): Promise<void> {
    const { artifactId, requestId } = request;
    const flow = new TransferFlowControl();
    this.activeDownloads.set(requestId, { flow });
    let streamStarted = false;

    try {
      if (!this.host.hasBinaryChannel()) {
        throw new Error("This connection cannot carry artifact downloads.");
      }
      const store = this.requireStore();
      const record = await store.get(artifactId);
      if (!record) throw new ArtifactError("artifact_not_found", `No artifact ${artifactId}`);
      const content = await store.readContent(artifactId);

      this.host.emit(
        {
          type: "artifact.entry.download.response",
          payload: {
            artifactId,
            title: record.title,
            mimeType: record.mimeType,
            size: content.byteLength,
            success: true,
            error: null,
            requestId,
          },
        },
        source,
      );

      streamStarted = true;
      await this.host.emitBinary(
        encodeFileTransferFrame({
          opcode: FileTransferOpcode.FileBegin,
          requestId,
          metadata: {
            mime: record.mimeType,
            size: content.byteLength,
            encoding: "utf-8",
            modifiedAt: record.updatedAt,
            ...(record.contentSha256 ? { revision: record.contentSha256 } : {}),
            fileName: `${record.artifactId}.html`,
          },
        }),
        source,
      );

      for (let offset = 0; offset < content.byteLength; offset += CHUNK_BYTES) {
        await flow.awaitWindow();
        if (flow.isCancelled) return;
        const chunk = content.subarray(offset, Math.min(offset + CHUNK_BYTES, content.byteLength));
        await this.host.emitBinary(
          encodeFileTransferFrame({
            opcode: FileTransferOpcode.FileChunk,
            requestId,
            payload: chunk,
          }),
          source,
        );
        flow.recordSent(chunk.byteLength);
      }

      if (flow.isCancelled) return;
      await this.host.emitBinary(
        encodeFileTransferFrame({ opcode: FileTransferOpcode.FileEnd, requestId }),
        source,
      );
    } catch (error) {
      this.logger.error({ err: error, artifactId }, "Failed to stream artifact download");
      if (streamStarted) {
        // The client is draining frames and no longer awaiting the response, so cancel is the
        // only signal it will act on.
        this.host.emit({ type: "fs.transfer.cancel", requestId }, source);
      } else {
        this.host.emit(
          {
            type: "artifact.entry.download.response",
            payload: {
              artifactId,
              title: null,
              mimeType: null,
              size: null,
              success: false,
              error: getErrorMessage(error),
              requestId,
            },
          },
          source,
        );
      }
    } finally {
      this.activeDownloads.delete(requestId);
    }
  }

  /** No-ops for a requestId this subsystem does not own; the workspace one may. */
  handleFileTransferAck(message: FileTransferAck): void {
    this.activeDownloads.get(message.requestId)?.flow.onAck(message.bytesReceived);
  }

  handleFileTransferCancel(message: FileTransferCancel): void {
    this.activeDownloads.get(message.requestId)?.flow.cancel();
  }

  emitChanged(projectId: string, source?: object): void {
    this.host.emit({ type: "artifact.changed", payload: { projectId } }, source);
  }

  private requireStore(): ArtifactStore {
    if (!this.store) throw new Error("This daemon does not support artifacts.");
    return this.store;
  }
}
