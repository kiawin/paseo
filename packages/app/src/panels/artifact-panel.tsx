import { useCallback } from "react";
import { Pressable, Text, View } from "react-native";
import { ExternalLink, FileCode2 } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import invariant from "tiny-invariant";

import { useArtifactContent, useArtifactRecord } from "@/artifacts/hooks";
import { FileHtmlPreview } from "@/file-pane/html-preview";
import { externalLinkHost } from "@/utils/external-link-host";
import { usePaneContext } from "@/panels/pane-context";
import { definePanel } from "@/panels/panel-registry";
import { openExternalUrl } from "@/utils/open-external-url";

const ThemedFileCode = withUnistyles(FileCode2);
const ThemedExternalLink = withUnistyles(ExternalLink, (theme) => ({
  color: theme.colors.mutedForeground,
}));

function useArtifactPanelDescriptor(
  target: { kind: "artifact"; artifactId: string },
  context: { serverId: string },
) {
  const { t } = useTranslation();
  const record = useArtifactRecord(context.serverId, target.artifactId);
  const label = record?.title ?? t("panels.artifacts.label");
  return {
    label,
    subtitle: t("panels.artifacts.subtitle"),
    tooltip: label,
    titleState: record ? ("ready" as const) : ("loading" as const),
    icon: ThemedFileCode,
    statusBucket: null,
  };
}

/**
 * A document, not a browser. The chrome is a title and the companion link; the bytes render in
 * the same sandboxed preview the file pane uses, unchanged. The link opens externally and is
 * never loaded into the frame — a published page is a live site, the preview is for bytes Paseo
 * holds.
 */
function ArtifactPanel() {
  const { t } = useTranslation();
  const { serverId, target } = usePaneContext();
  invariant(target.kind === "artifact", "ArtifactPanel requires artifact target");
  const record = useArtifactRecord(serverId, target.artifactId);
  const content = useArtifactContent(serverId, target.artifactId, record?.contentSha256 ?? null);
  const externalUrl = record?.externalUrl ?? null;
  const host = externalUrl ? externalLinkHost(externalUrl) : null;
  const onOpenLink = useCallback(() => {
    if (externalUrl) void openExternalUrl(externalUrl);
  }, [externalUrl]);

  if (content.error) {
    return (
      <View style={styles.centerState} testID="artifact-error">
        <Text style={styles.emptyTitle}>{t("panels.artifacts.loadFailed")}</Text>
        <Text style={styles.emptyBody}>{content.error}</Text>
      </View>
    );
  }
  if (content.html === null) {
    return (
      <View style={styles.centerState} testID="artifact-loading">
        <Text style={styles.emptyBody}>{t("common.states.loading")}</Text>
      </View>
    );
  }
  return (
    <View style={styles.container}>
      {externalUrl && host ? (
        <Pressable style={styles.linkBar} onPress={onOpenLink} testID="artifact-external-link">
          <ThemedExternalLink size={12} />
          <Text style={styles.linkText} numberOfLines={1}>
            {t("panels.artifacts.openOn", { host })}
          </Text>
        </Pressable>
      ) : null}
      <View style={styles.preview}>
        <FileHtmlPreview html={content.html} testID="artifact-html-preview" />
      </View>
    </View>
  );
}

export const artifactPanelRegistration = definePanel("artifact", {
  component: ArtifactPanel,
  useDescriptor: useArtifactPanelDescriptor,
});

const styles = StyleSheet.create((theme) => ({
  container: {
    flex: 1,
  },
  linkBar: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: theme.colors.border,
  },
  linkText: {
    color: theme.colors.mutedForeground,
    fontSize: theme.fontSize.xs,
  },
  preview: {
    flex: 1,
    minHeight: 0,
  },
  centerState: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    padding: theme.spacing[4],
    gap: theme.spacing[2],
  },
  emptyTitle: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    textAlign: "center",
  },
  emptyBody: {
    color: theme.colors.mutedForeground,
    fontSize: theme.fontSize.xs,
    textAlign: "center",
  },
}));
