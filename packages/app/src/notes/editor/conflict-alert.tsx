import { useTranslation } from "react-i18next";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";

import { Button } from "@/components/ui/button";
import type { RevisionedTextConflictCallout } from "@/editor/revisioned-text-model";
import { noteConflictActions } from "./conflict-actions";

export function NoteConflictAlert({
  callout,
  onReload,
  onOverwrite,
  onRetry,
}: {
  callout: RevisionedTextConflictCallout | null;
  onReload?: () => void;
  onOverwrite?: () => void;
  onRetry?: () => void;
}) {
  const { t } = useTranslation();
  if (!callout) return null;

  const title =
    callout.kind === "changed" ? t("panels.notes.changedTitle") : t("panels.notes.loadFailed");
  const actionKinds = noteConflictActions(callout);
  let renderedActions = null;
  if (actionKinds.includes("overwrite") || actionKinds.includes("reload")) {
    renderedActions = (
      <View style={styles.actions}>
        {actionKinds.includes("overwrite") && onOverwrite ? (
          <Button variant="outline" size="sm" onPress={onOverwrite}>
            {t("panels.file.editor.overwrite")}
          </Button>
        ) : null}
        {actionKinds.includes("reload") && onReload ? (
          <Button variant="outline" size="sm" onPress={onReload}>
            {t("panels.notes.reload")}
          </Button>
        ) : null}
      </View>
    );
  } else if (actionKinds.includes("retry") && onRetry) {
    renderedActions = (
      <View style={styles.actions}>
        <Button variant="outline" size="sm" onPress={onRetry}>
          {t("common.actions.retry")}
        </Button>
      </View>
    );
  }
  return (
    <View style={styles.container} testID="note-conflict" accessibilityRole="alert">
      <View style={styles.message}>
        <Text style={styles.title}>{title}</Text>
      </View>
      {renderedActions}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: {
    minHeight: 48,
    flexDirection: "row",
    alignItems: "center",
    flexWrap: "wrap",
    gap: theme.spacing[3],
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.palette.amber[500],
    backgroundColor: theme.colors.surface1,
  },
  message: { flex: 1, minWidth: 0 },
  title: {
    color: theme.colors.palette.amber[500],
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.medium,
  },
  actions: {
    flexShrink: 0,
    marginLeft: "auto",
    flexDirection: "row",
    gap: theme.spacing[2],
  },
}));
