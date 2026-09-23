import { Image } from "react-native";
import { isWeb } from "@/constants/platform";
import { useMemo, useEffect, useId } from "react";
import { useFetchQueries } from "@/data/query";
import { createAssistantImageFileAcquisition } from "@/assistant-image/file-acquisition";
import {
  persistAttachmentFromBytes,
  resolveAttachmentPreviewUrl,
  releaseAttachmentPreviewUrl,
} from "@/attachments/service";
import { createAssistantImageAcquisitionCache } from "@/assistant-image/acquisition-cache";
import { retainAttachmentForGarbageCollection } from "@/attachments/gc-retention";
import { resolveAssistantImageSource } from "@/utils/assistant-image-source";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type { AttachmentMetadata } from "@/attachments/types";
import { resolveMarkdownPreviewImageSource } from "./image-source";
import { PENDING_MARKDOWN_IMAGE, prepareMarkdownSource } from "./source";
import { decodeMarkdownImage, getMarkdownImageStatus } from "./image-decoding";
import { isRemoteImageUrl, type RemoteImageBehavior } from "./image-policy";

const urls = createAssistantImageAcquisitionCache<{ uri: string; attachment: AttachmentMetadata }>({
  capacity: 500,
  onRetain: ({ uri, attachment }) => {
    const release = retainAttachmentForGarbageCollection(attachment.id);
    return () => {
      release();
      void releaseAttachmentPreviewUrl({ attachment, url: uri });
    };
  },
});

export interface MarkdownImageContext {
  client?: Pick<DaemonClient, "readFile"> | null;
  workspaceRoot?: string;
  serverId?: string;
  filePath?: string;
  remoteImageBehavior?: RemoteImageBehavior;
  remoteImageLoadLabel?: string;
  loadedRemoteImageSources?: ReadonlySet<string>;
}

export function useMarkdownSource(text: string, context: MarkdownImageContext) {
  const occurrenceKey = useId();
  const remoteImageBehavior = context.remoteImageBehavior ?? "auto";
  const loadedRemoteImageSources = context.loadedRemoteImageSources ?? EMPTY_REMOTE_IMAGES;
  const prepared = useMemo(
    () => prepareMarkdownSource(text, context.workspaceRoot, { supportsSvg: isWeb }),
    [text, context.workspaceRoot],
  );
  const sources = [...new Set(prepared.images.map((image) => image.source))];
  const isDeferredRemoteImage = (source: string) =>
    isRemoteImageUrl(source) &&
    remoteImageBehavior === "tap-to-load" &&
    !loadedRemoteImageSources.has(source);
  const isBlockedRemoteImage = (source: string) =>
    isRemoteImageUrl(source) && remoteImageBehavior === "disabled";
  const acquisitions = sources.map((source) => {
    if (isDeferredRemoteImage(source) || isBlockedRemoteImage(source)) return null;
    const resolved = resolveMarkdownPreviewImageSource({
      source,
      markdownPath: context.filePath ?? "",
      workspaceRoot: context.workspaceRoot,
    });
    return createAssistantImageFileAcquisition({
      port: context.client
        ? {
            readFile: (cwd, path) => context.client!.readFile(cwd, path),
            persist: persistAttachmentFromBytes,
          }
        : null,
      resolution: resolved
        ? resolveAssistantImageSource({ source: resolved, workspaceRoot: context.workspaceRoot })
        : null,
      serverId: context.serverId,
      occurrenceKey,
      unavailableMessage: "Image unavailable",
    });
  });
  const results = useFetchQueries(
    acquisitions.map((acquisition, index) => ({
      queryKey: ["markdownImage", acquisition?.key ?? sources[index]],
      enabled: acquisition !== null,
      immutableWhen: () => true,
      dataShape: "value",
      gcTime: 0,
      queryFn: async () => {
        if (!acquisition) throw new Error("No image acquisition");
        return urls.acquire(acquisition.key, async () => {
          const attachment = await acquisition.locate();
          const uri = await resolveAttachmentPreviewUrl(attachment);
          return { attachment, uri };
        });
      },
    })),
  );
  useEffect(() => {
    const releases = results.flatMap((result, index) => {
      const acquisition = acquisitions[index];
      if (!result.data || !acquisition) return [];
      const value = result.data;
      return [urls.acquireRetained(acquisition.key, async () => value).release];
    });
    return () => releases.forEach((release) => release());
  }, [results, acquisitions]);
  const resolved = new Map<string, string>();
  results.forEach((result, index) => {
    if (result.data) resolved.set(sources[index]!, result.data.uri);
  });
  const displayUrls = sources.map((source) =>
    isDeferredRemoteImage(source) || isBlockedRemoteImage(source)
      ? undefined
      : (resolved.get(source) ?? (/^(https?:|data:|blob:)/i.test(source) ? source : undefined)),
  );
  const decoded = useFetchQueries(
    displayUrls.map((uri, index) => ({
      queryKey: ["markdownImageDecode", occurrenceKey, uri ?? sources[index]],
      refetchOnReconnect: true,
      enabled: uri !== undefined,
      immutableWhen: () => true,
      dataShape: "value",
      gcTime: 0,
      queryFn: () => {
        if (!uri) throw new Error("No image URL to decode");
        return decodeMarkdownImage(uri, Image.getSize);
      },
    })),
  );
  const statuses = sources.map((source, index) => {
    if (isBlockedRemoteImage(source)) return "unavailable" as const;
    if (isDeferredRemoteImage(source)) return "pending" as const;
    return getMarkdownImageStatus({
      canAcquire: acquisitions[index] !== null,
      url: displayUrls[index],
      acquisitionFailed: results[index].isError,
      decodeFailed: decoded[index].isError,
      decoded: decoded[index].data === true,
    });
  });
  const unavailableImages = new Set(
    sources.filter((_source, index) => statuses[index] === "unavailable"),
  );
  const pendingImages = new Set(sources.filter((_source, index) => statuses[index] === "pending"));
  let markdown = prepared.render(resolved, unavailableImages, pendingImages);
  const remoteImagePlaceholders = new Map<string, string>();
  if (remoteImageBehavior === "tap-to-load") {
    let searchStart = 0;
    for (const image of prepared.images) {
      const pending = pendingImages.has(image.source);
      if (!pending) continue;
      const markerStart = markdown.indexOf(PENDING_MARKDOWN_IMAGE, searchStart);
      if (markerStart < 0) continue;
      if (isDeferredRemoteImage(image.source)) {
        const placeholder = `${PENDING_MARKDOWN_IMAGE}#paseo-remote-${encodeURIComponent(image.source)}`;
        markdown =
          markdown.slice(0, markerStart) +
          placeholder +
          markdown.slice(markerStart + PENDING_MARKDOWN_IMAGE.length);
        remoteImagePlaceholders.set(placeholder, image.source);
        searchStart = markerStart + placeholder.length;
      } else {
        searchStart = markerStart + PENDING_MARKDOWN_IMAGE.length;
      }
    }
  }
  return {
    markdown,
    linkRecognition: prepared.linkRecognition,
    linkSource: prepared.linkSource,
    imageSources: Object.fromEntries([...resolved].map(([source, url]) => [url, source])),
    remoteImagePlaceholders,
  };
}

const EMPTY_REMOTE_IMAGES: ReadonlySet<string> = new Set();
