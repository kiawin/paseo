import type pino from "pino";
import { getErrorMessage } from "@getpaseo/protocol/error-utils";
import {
  encodeFileTransferFrame,
  FileTransferOpcode,
  TransferFlowControl,
  TRANSFER_ACK_INTERVAL_BYTES,
  type FileTransferFrame,
} from "@getpaseo/protocol/binary-frames/index";
import type {
  FileDownloadTokenRequest,
  FileEntryCreateRequest,
  FileEntryDeleteRequest,
  FileEntryDownloadRequest,
  FileEntryUploadRequest,
  FileEntryDuplicateRequest,
  FileEntryRenameRequest,
  FileExplorerRequest,
  FileUploadRequest,
  FileSubscribeRequest,
  FileTransferAck,
  FileTransferCancel,
  FileUnsubscribeRequest,
  FileWriteRequest,
  SessionInboundMessage,
  SessionOutboundMessage,
} from "../../messages.js";
import { FileUploadStore } from "../../file-upload/index.js";
import type { DownloadTokenStore } from "../../file-download/token-store.js";
import {
  createExplorerEntry,
  createUploadSink,
  deleteExplorerEntry,
  duplicateExplorerEntry,
  getDownloadableEntryInfo,
  getDownloadableFileInfo,
  listDirectoryEntries,
  readExplorerFile,
  renameExplorerEntry,
  streamDirectoryArchive,
  streamExplorerFile,
  writeExplorerFile,
  type UploadSink,
} from "../../file-explorer/service.js";
import { workspaceFileObserver, type FileObserver } from "../../file-explorer/observer.js";
import { getProjectIcon } from "../../../utils/project-icon.js";

/**
 * What a workspace file-access request reaches outside its own domain: the
 * outbound message channel (text + binary). `hasBinaryChannel` gates the
 * binary file-explorer transfer path the same way the terminal subsystem does
 * — old clients without a binary channel fall back to inline JSON file content.
 */
export interface WorkspaceFilesSessionHost {
  emit(msg: SessionOutboundMessage, source?: object): void;
  emitBinary(frame: Uint8Array, source?: object): Promise<void>;
  hasBinaryChannel(): boolean;
}

interface WorkspaceUploadState {
  sink: UploadSink;
  cwd: string;
  requestedPath: string;
  receivedBytes: number;
  ackedBytes: number;
  source?: object;
}

export interface WorkspaceFilesSessionOptions {
  host: WorkspaceFilesSessionHost;
  downloadTokenStore: DownloadTokenStore;
  paseoHome: string;
  logger: pino.Logger;
  fileObserver?: FileObserver;
}

/**
 * A client's workspace file-access surface: browsing directories, reading file
 * contents (inline JSON or binary frames), receiving uploads, issuing download
 * tokens, and reading project icons. It owns the upload store and reaches no
 * workspace-git, registry, or subscription state — file I/O scoped to a cwd is
 * the whole concern.
 */
export class WorkspaceFilesSession {
  private readonly host: WorkspaceFilesSessionHost;
  private readonly downloadTokenStore: DownloadTokenStore;
  private readonly logger: pino.Logger;
  private readonly fileUploads: FileUploadStore;
  private readonly fileObserver: FileObserver;
  private readonly fileSubscriptions = new Map<string, () => void>();
  private readonly activeDownloads = new Map<string, TransferFlowControl>();
  private readonly activeUploads = new Map<string, WorkspaceUploadState>();

  constructor(options: WorkspaceFilesSessionOptions) {
    this.host = options.host;
    this.downloadTokenStore = options.downloadTokenStore;
    this.logger = options.logger;
    this.fileUploads = new FileUploadStore({ paseoHome: options.paseoHome });
    this.fileObserver = options.fileObserver ?? workspaceFileObserver;
  }

  async handleFileSubscribeRequest(request: FileSubscribeRequest): Promise<void> {
    this.fileSubscriptions.get(request.subscriptionId)?.();
    try {
      const subscription = await this.fileObserver.subscribe(
        { cwd: request.cwd, path: request.path },
        (version) => {
          this.host.emit({
            type: "fs.file.update",
            payload: { subscriptionId: request.subscriptionId, version },
          });
        },
      );
      this.fileSubscriptions.set(request.subscriptionId, subscription.unsubscribe);
      this.host.emit({
        type: "fs.file.subscribe.response",
        payload: {
          subscriptionId: request.subscriptionId,
          initial: subscription.initial,
          requestId: request.requestId,
        },
      });
    } catch (error) {
      this.host.emit({
        type: "fs.file.subscribe.response",
        payload: {
          subscriptionId: request.subscriptionId,
          initial: {
            status: "error",
            cwd: request.cwd,
            path: request.path,
            error: getErrorMessage(error),
          },
          requestId: request.requestId,
        },
      });
    }
  }

  handleFileUnsubscribeRequest(request: FileUnsubscribeRequest): void {
    this.fileSubscriptions.get(request.subscriptionId)?.();
    this.fileSubscriptions.delete(request.subscriptionId);
    this.host.emit({
      type: "fs.file.unsubscribe.response",
      payload: { subscriptionId: request.subscriptionId, requestId: request.requestId },
    });
  }

  async handleFileWriteRequest(request: FileWriteRequest): Promise<void> {
    const result = await writeExplorerFile({
      root: request.cwd,
      relativePath: request.path,
      content: request.content,
      expectedModifiedAt: request.expectedModifiedAt,
      expectedRevision: request.expectedRevision,
    });
    this.host.emit({
      type: "fs.file.write.response",
      payload: { result, requestId: request.requestId },
    });
  }

  async handleFileEntryCreateRequest(request: FileEntryCreateRequest): Promise<void> {
    const result = await createExplorerEntry({
      root: request.cwd,
      parentPath: request.parentPath,
      name: request.name,
      kind: request.kind,
    });
    this.host.emit({
      type: "fs.entry.create.response",
      payload: {
        cwd: request.cwd,
        parentPath: request.parentPath,
        path: result.status === "ok" ? result.path : null,
        success: result.status === "ok",
        error: result.status === "ok" ? null : result.error,
        requestId: request.requestId,
      },
    });
  }

  async handleFileEntryRenameRequest(request: FileEntryRenameRequest): Promise<void> {
    const result = await renameExplorerEntry({
      root: request.cwd,
      relativePath: request.path,
      name: request.name,
    });
    this.host.emit({
      type: "fs.entry.rename.response",
      payload: {
        cwd: request.cwd,
        path: request.path,
        renamedPath: result.status === "ok" ? result.path : null,
        success: result.status === "ok",
        error: result.status === "ok" ? null : result.error,
        requestId: request.requestId,
      },
    });
  }

  async handleFileEntryDuplicateRequest(request: FileEntryDuplicateRequest): Promise<void> {
    const result = await duplicateExplorerEntry({
      root: request.cwd,
      relativePath: request.path,
    });
    this.host.emit({
      type: "fs.entry.duplicate.response",
      payload: {
        cwd: request.cwd,
        path: request.path,
        duplicatedPath: result.status === "ok" ? result.path : null,
        success: result.status === "ok",
        error: result.status === "ok" ? null : result.error,
        requestId: request.requestId,
      },
    });
  }

  async handleFileEntryDeleteRequest(request: FileEntryDeleteRequest): Promise<void> {
    const result = await deleteExplorerEntry({
      root: request.cwd,
      relativePath: request.path,
    });
    this.host.emit({
      type: "fs.entry.delete.response",
      payload: {
        cwd: request.cwd,
        path: request.path,
        success: result.status === "ok",
        error: result.status === "ok" ? null : result.error,
        requestId: request.requestId,
      },
    });
  }

  dispose(): void {
    for (const unsubscribe of this.fileSubscriptions.values()) unsubscribe();
    this.fileSubscriptions.clear();
    // A parked sender is waiting on an ack that will never arrive once the client is gone.
    for (const flow of this.activeDownloads.values()) flow.cancel();
    this.activeDownloads.clear();
    // A half-written upload must not survive the connection that was feeding it.
    for (const upload of this.activeUploads.values()) void upload.sink.abort();
    this.activeUploads.clear();
  }

  async handleFileExplorerRequest(request: FileExplorerRequest, source?: object): Promise<void> {
    const { cwd: workspaceCwd, path: requestedPath = ".", mode, requestId } = request;
    const cwd = workspaceCwd.trim();
    if (!cwd) {
      this.host.emit(
        {
          type: "file_explorer_response",
          payload: {
            cwd: workspaceCwd,
            path: requestedPath,
            mode,
            directory: null,
            file: null,
            error: "cwd is required",
            requestId,
          },
        },
        source,
      );
      return;
    }

    try {
      if (mode === "list") {
        const directory = await listDirectoryEntries({
          root: cwd,
          relativePath: requestedPath,
        });

        this.host.emit(
          {
            type: "file_explorer_response",
            payload: {
              cwd,
              path: directory.path,
              mode,
              directory,
              file: null,
              error: null,
              requestId,
            },
          },
          source,
        );
      } else {
        if (request.maxBytes) {
          const file = await getDownloadableFileInfo({ root: cwd, relativePath: requestedPath });
          if (file.size > request.maxBytes) {
            throw new Error("File is too large to display");
          }
        }
        if (request.acceptBinary && this.host.hasBinaryChannel()) {
          await streamExplorerFile({ root: cwd, relativePath: requestedPath }, async (file) => {
            await this.host.emitBinary(
              encodeFileTransferFrame({
                opcode: FileTransferOpcode.FileBegin,
                requestId,
                metadata: {
                  mime: file.mimeType,
                  size: file.size,
                  encoding: file.encoding,
                  modifiedAt: file.modifiedAt,
                  revision: file.revision,
                },
              }),
              source,
            );
            for await (const chunk of file.chunks) {
              await this.host.emitBinary(
                encodeFileTransferFrame({
                  opcode: FileTransferOpcode.FileChunk,
                  requestId,
                  payload: chunk,
                }),
                source,
              );
            }
            await this.host.emitBinary(
              encodeFileTransferFrame({
                opcode: FileTransferOpcode.FileEnd,
                requestId,
              }),
              source,
            );
          });
        } else {
          const file = await readExplorerFile({
            root: cwd,
            relativePath: requestedPath,
          });

          this.host.emit(
            {
              type: "file_explorer_response",
              payload: {
                cwd,
                path: file.path,
                mode,
                directory: null,
                file,
                error: null,
                requestId,
              },
            },
            source,
          );
        }
      }
    } catch (error) {
      this.logger.error(
        { err: error, cwd, path: requestedPath },
        `Failed to fulfill file explorer request for workspace ${cwd}`,
      );
      this.host.emit(
        {
          type: "file_explorer_response",
          payload: {
            cwd,
            path: requestedPath,
            mode,
            directory: null,
            file: null,
            error: getErrorMessage(error),
            requestId,
          },
        },
        source,
      );
    }
  }

  /**
   * Streams one workspace entry to the client over the binary channel.
   *
   * This is the WebSocket replacement for `GET /api/files/download`: a relay carries only
   * `/health` and `/ws`, so an HTTP download cannot work on a relay connection at all.
   * The client registers a sink for `requestId` before sending the request, so the metadata
   * response and the frames that follow both land on a receiver that already exists.
   */
  async handleEntryDownloadRequest(
    request: FileEntryDownloadRequest,
    source?: object,
  ): Promise<void> {
    const { cwd, path: requestedPath, requestId } = request;
    const flow = new TransferFlowControl();
    this.activeDownloads.set(requestId, flow);
    let streamStarted = false;

    try {
      if (!this.host.hasBinaryChannel()) {
        throw new Error("This connection cannot carry file downloads.");
      }

      // `kind` comes from the daemon's own stat, never from the client.
      const info = await getDownloadableEntryInfo({ root: cwd, relativePath: requestedPath });

      this.host.emit(
        {
          type: "fs.entry.download.response",
          payload: {
            cwd,
            path: info.path,
            kind: info.kind === "directory" ? "archive" : "file",
            fileName: info.fileName,
            mimeType: info.mimeType,
            size: info.size,
            success: true,
            error: null,
            requestId,
          },
        },
        source,
      );

      if (info.kind === "directory") {
        streamStarted = true;
        await this.streamArchiveFrames({ cwd, requestedPath, requestId, flow, info, source });
        return;
      }

      await streamExplorerFile({ root: cwd, relativePath: requestedPath }, async (file) => {
        streamStarted = true;
        await this.host.emitBinary(
          encodeFileTransferFrame({
            opcode: FileTransferOpcode.FileBegin,
            requestId,
            metadata: {
              mime: file.mimeType,
              size: file.size,
              encoding: file.encoding,
              modifiedAt: file.modifiedAt,
              revision: file.revision,
            },
          }),
          source,
        );

        for await (const chunk of file.chunks) {
          await flow.awaitWindow();
          if (flow.isCancelled) {
            return;
          }
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

        if (flow.isCancelled) {
          return;
        }
        await this.host.emitBinary(
          encodeFileTransferFrame({ opcode: FileTransferOpcode.FileEnd, requestId }),
          source,
        );
      });
    } catch (error) {
      this.logger.error(
        { err: error, cwd, path: requestedPath },
        `Failed to stream download for workspace ${cwd}`,
      );
      if (streamStarted) {
        // The client is already draining frames and is no longer awaiting the response,
        // so cancel is the only signal it will act on.
        this.host.emit({ type: "fs.transfer.cancel", requestId }, source);
      } else {
        this.host.emit(
          {
            type: "fs.entry.download.response",
            payload: {
              cwd,
              path: requestedPath,
              kind: null,
              fileName: null,
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

  /**
   * Streams a directory archive. The zip is produced as it is sent, so `size` is a
   * placeholder and `sizeKnown: false` tells the receiver not to treat it as a length.
   */
  private async streamArchiveFrames({
    cwd,
    requestedPath,
    requestId,
    flow,
    info,
    source,
  }: {
    cwd: string;
    requestedPath: string;
    requestId: string;
    flow: TransferFlowControl;
    info: { fileName: string; mimeType: string };
    source?: object;
  }): Promise<void> {
    await this.host.emitBinary(
      encodeFileTransferFrame({
        opcode: FileTransferOpcode.FileBegin,
        requestId,
        metadata: {
          mime: info.mimeType,
          size: 0,
          sizeKnown: false,
          encoding: "binary",
          modifiedAt: new Date().toISOString(),
          fileName: info.fileName,
        },
      }),
      source,
    );

    for await (const chunk of streamDirectoryArchive({ root: cwd, relativePath: requestedPath })) {
      await flow.awaitWindow();
      if (flow.isCancelled) {
        // Leaving the for-await destroys the zip stream, so the daemon stops reading.
        return;
      }
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

    if (flow.isCancelled) {
      return;
    }
    await this.host.emitBinary(
      encodeFileTransferFrame({ opcode: FileTransferOpcode.FileEnd, requestId }),
      source,
    );
  }

  /**
   * Opens a sink for an upload into the workspace tree.
   *
   * The response is withheld until the bytes land, because it reports the path the file
   * actually took — "rename" mode may not be the path that was asked for. A failure to
   * even open the sink (a path that escapes, or a taken name under "fail") answers
   * immediately, before the client starts sending.
   */
  async handleEntryUploadRequest(request: FileEntryUploadRequest, source?: object): Promise<void> {
    const { cwd, path: requestedPath, overwrite, requestId } = request;
    try {
      const sink = await createUploadSink({
        root: cwd,
        relativePath: requestedPath,
        overwrite,
        createMissingDirectories: request.createMissingDirectories ?? false,
      });
      this.activeUploads.set(requestId, {
        sink,
        cwd,
        requestedPath,
        receivedBytes: 0,
        ackedBytes: 0,
        source,
      });
    } catch (error) {
      this.logger.error(
        { err: error, cwd, path: requestedPath },
        `Failed to open upload sink for workspace ${cwd}`,
      );
      this.emitUploadFailure(cwd, requestId, getErrorMessage(error), source);
    }
  }

  /** `path` stays null on failure: no file was written, so there is no path to report. */
  private emitUploadFailure(cwd: string, requestId: string, error: string, source?: object): void {
    this.host.emit(
      {
        type: "fs.entry.upload.response",
        payload: {
          cwd,
          path: null,
          size: null,
          modifiedAt: null,
          success: false,
          error,
          requestId,
        },
      },
      source,
    );
  }

  /** Feeds one inbound frame to whichever upload owns its requestId. */
  private async receiveWorkspaceUploadFrame(
    upload: WorkspaceUploadState,
    frame: FileTransferFrame,
  ): Promise<void> {
    const requestId = frame.requestId;
    try {
      if (frame.opcode === FileTransferOpcode.FileBegin) {
        // Everything the daemon needs came in fs.entry.upload.request.
        return;
      }

      if (frame.opcode === FileTransferOpcode.FileChunk) {
        await upload.sink.write(frame.payload);
        upload.receivedBytes += frame.payload.byteLength;
        if (upload.receivedBytes - upload.ackedBytes >= TRANSFER_ACK_INTERVAL_BYTES) {
          upload.ackedBytes = upload.receivedBytes;
          this.host.emit(
            { type: "fs.transfer.ack", requestId, bytesReceived: upload.receivedBytes },
            upload.source,
          );
        }
        return;
      }

      const result = await upload.sink.commit();
      this.activeUploads.delete(requestId);
      this.host.emit(
        {
          type: "fs.entry.upload.response",
          payload: {
            cwd: upload.cwd,
            path: result.path,
            size: result.size,
            modifiedAt: result.modifiedAt,
            revision: result.revision,
            success: true,
            error: null,
            requestId,
          },
        },
        upload.source,
      );
    } catch (error) {
      this.activeUploads.delete(requestId);
      await upload.sink.abort().catch(() => undefined);
      this.logger.error(
        { err: error, cwd: upload.cwd, path: upload.requestedPath },
        `Failed to receive upload for workspace ${upload.cwd}`,
      );
      this.emitUploadFailure(upload.cwd, requestId, getErrorMessage(error), upload.source);
    }
  }

  handleFileTransferAck(message: FileTransferAck): void {
    this.activeDownloads.get(message.requestId)?.onAck(message.bytesReceived);
  }

  handleFileTransferCancel(message: FileTransferCancel): void {
    this.activeDownloads.get(message.requestId)?.cancel();
    const upload = this.activeUploads.get(message.requestId);
    if (upload) {
      this.activeUploads.delete(message.requestId);
      void upload.sink.abort();
    }
  }

  handleFileUploadRequest(request: FileUploadRequest): void {
    this.fileUploads.beginUpload(request);
  }

  /**
   * Routes an inbound binary frame by requestId.
   *
   * Composer attachments and workspace uploads share the frame format, so the requestId
   * that registered the transfer decides which one owns it. Without this every frame
   * would land in the attachment store.
   */
  async handleFileTransferFrame(frame: FileTransferFrame): Promise<void> {
    const upload = this.activeUploads.get(frame.requestId);
    if (upload) {
      await this.receiveWorkspaceUploadFrame(upload, frame);
      return;
    }

    const response = await this.fileUploads.receiveFrame(frame);
    if (response) {
      this.host.emit(response);
    }
  }

  async handleProjectIconRequest(
    request: Extract<SessionInboundMessage, { type: "project_icon_request" }>,
  ): Promise<void> {
    const { cwd, requestId } = request;

    try {
      const icon = await getProjectIcon(cwd);
      this.host.emit({
        type: "project_icon_response",
        payload: {
          cwd,
          icon,
          error: null,
          requestId,
        },
      });
    } catch (error) {
      this.host.emit({
        type: "project_icon_response",
        payload: {
          cwd,
          icon: null,
          error: getErrorMessage(error),
          requestId,
        },
      });
    }
  }

  async handleFileDownloadTokenRequest(request: FileDownloadTokenRequest): Promise<void> {
    const { cwd: workspaceCwd, path: requestedPath, requestId } = request;
    const cwd = workspaceCwd.trim();
    if (!cwd) {
      this.host.emit({
        type: "file_download_token_response",
        payload: {
          cwd: workspaceCwd,
          path: requestedPath,
          token: null,
          fileName: null,
          mimeType: null,
          size: null,
          error: "cwd is required",
          requestId,
        },
      });
      return;
    }

    this.logger.debug(
      { cwd, path: requestedPath },
      `Handling file download token request for workspace ${cwd} (${requestedPath})`,
    );

    try {
      const info = await getDownloadableFileInfo({
        root: cwd,
        relativePath: requestedPath,
      });

      const entry = this.downloadTokenStore.issueToken({
        path: info.path,
        absolutePath: info.absolutePath,
        fileName: info.fileName,
        mimeType: info.mimeType,
        size: info.size,
      });

      this.host.emit({
        type: "file_download_token_response",
        payload: {
          cwd,
          path: info.path,
          token: entry.token,
          fileName: entry.fileName,
          mimeType: entry.mimeType,
          size: entry.size,
          error: null,
          requestId,
        },
      });
    } catch (error) {
      this.logger.error(
        { err: error, cwd, path: requestedPath },
        `Failed to issue download token for workspace ${cwd}`,
      );
      this.host.emit({
        type: "file_download_token_response",
        payload: {
          cwd,
          path: requestedPath,
          token: null,
          fileName: null,
          mimeType: null,
          size: null,
          error: getErrorMessage(error),
          requestId,
        },
      });
    }
  }
}
