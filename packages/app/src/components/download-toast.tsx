import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { useCallback, useEffect, useMemo, useRef } from "react";
import { useTranslation } from "react-i18next";
import { Pressable, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { Check, X, XCircle } from "lucide-react-native";
import { useDownloadStore, type Download } from "@/stores/download-store";
import { getTransferStatusText, hasDeterminateProgress, type Transfer } from "./transfer-status";
import { useUploadStore, type Upload } from "@/stores/upload-store";

const AUTO_DISMISS_DELAY = 3000;

function toTransfer(download: Download, dismiss: (id: string) => void): Transfer {
  return {
    id: download.id,
    fileName: download.fileName,
    inFlight: download.status === "downloading",
    complete: download.status === "complete",
    message: download.message,
    progress: download.progress,
    dismiss: () => dismiss(download.id),
  };
}

function uploadToTransfer(upload: Upload, dismiss: (id: string) => void): Transfer {
  return {
    id: upload.id,
    fileName: upload.fileName,
    inFlight: upload.status === "uploading",
    complete: upload.status === "complete",
    message: upload.message,
    progress: upload.progress,
    dismiss: () => dismiss(upload.id),
  };
}

export function DownloadToast() {
  const { theme } = useUnistyles();
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();
  const downloads = useDownloadStore((state) => state.downloads);
  const activeDownloadId = useDownloadStore((state) => state.activeDownloadId);
  const dismissDownload = useDownloadStore((state) => state.dismissDownload);
  const uploads = useUploadStore((state) => state.uploads);
  const activeUploadId = useUploadStore((state) => state.activeUploadId);
  const dismissUpload = useUploadStore((state) => state.dismissUpload);
  const dismissTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const download = activeDownloadId ? downloads.get(activeDownloadId) : null;
  const upload = activeUploadId ? uploads.get(activeUploadId) : null;
  const isUpload = !download && Boolean(upload);
  let activeDownload: Transfer | null = null;
  if (download) {
    activeDownload = toTransfer(download, dismissDownload);
  } else if (upload) {
    activeDownload = uploadToTransfer(upload, dismissUpload);
  }

  useEffect(() => {
    if (dismissTimeoutRef.current) {
      clearTimeout(dismissTimeoutRef.current);
      dismissTimeoutRef.current = null;
    }

    if (activeDownload && !activeDownload.inFlight) {
      const dismiss = activeDownload.dismiss;
      dismissTimeoutRef.current = setTimeout(dismiss, AUTO_DISMISS_DELAY);
    }

    return () => {
      if (dismissTimeoutRef.current) {
        clearTimeout(dismissTimeoutRef.current);
      }
    };
  }, [activeDownload]);

  const containerStyle = useMemo(
    () => [styles.container, { bottom: theme.spacing[4] + insets.bottom }],
    [theme.spacing, insets.bottom],
  );

  const handleDismiss = useCallback(() => {
    activeDownload?.dismiss();
  }, [activeDownload]);

  if (!activeDownload) {
    return null;
  }

  return (
    <View style={containerStyle} pointerEvents="box-none">
      <View style={styles.toast}>
        {activeDownload.inFlight ? (
          <LoadingSpinner size="small" color={theme.colors.foreground} />
        ) : null}
        {activeDownload.complete ? <Check size={18} color={theme.colors.primary} /> : null}
        {!activeDownload.inFlight && !activeDownload.complete ? (
          <XCircle size={18} color={theme.colors.destructive} />
        ) : null}
        <View style={styles.textContainer}>
          <Text style={styles.fileName} numberOfLines={1}>
            {activeDownload.fileName}
          </Text>
          <Text style={styles.status}>{getTransferStatusText(activeDownload, isUpload, t)}</Text>
          {hasDeterminateProgress(activeDownload) && activeDownload.progress && (
            <View style={styles.progressBar}>
              <ProgressFill percent={activeDownload.progress.percent} />
            </View>
          )}
        </View>
        {!activeDownload.inFlight && (
          <Pressable onPress={handleDismiss} hitSlop={8} style={styles.dismiss}>
            <X size={16} color={theme.colors.foregroundMuted} />
          </Pressable>
        )}
      </View>
    </View>
  );
}

function ProgressFill({ percent }: { percent: number }) {
  const width: `${number}%` = `${Math.round(percent * 100)}%`;
  const fillStyle = useMemo(() => [styles.progressFill, { width }], [width]);
  return <View style={fillStyle} />;
}

const styles = StyleSheet.create((theme) => ({
  container: {
    position: "absolute",
    left: theme.spacing[4],
    right: theme.spacing[4],
    zIndex: 1000,
  },
  toast: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[3],
    backgroundColor: theme.colors.surface2,
    borderRadius: theme.borderRadius.lg,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    paddingVertical: theme.spacing[3],
    paddingHorizontal: theme.spacing[4],
    ...theme.shadow.md,
  },
  textContainer: {
    flex: 1,
    gap: theme.spacing[1],
  },
  fileName: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.semibold,
  },
  status: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  progressBar: {
    height: 3,
    backgroundColor: theme.colors.surface2,
    borderRadius: theme.borderRadius.full,
    marginTop: theme.spacing[1],
    overflow: "hidden",
  },
  progressFill: {
    height: "100%",
    backgroundColor: theme.colors.primary,
    borderRadius: theme.borderRadius.full,
  },
  dismiss: {
    padding: theme.spacing[1],
  },
}));
