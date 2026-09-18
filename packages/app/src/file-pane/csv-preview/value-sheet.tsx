import { useCallback, useEffect, useMemo, useState } from "react";
import { Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet } from "react-native-unistyles";
import { AdaptiveModalSheet } from "@/components/adaptive-modal-sheet";
import { Button } from "@/components/ui/button";
import { copyCsvText } from "./clipboard";
import type { CsvCopyKind } from "./grid";

type CopyStatus = "idle" | "pending" | "copied" | "failed";

export function CsvValueSheet({
  visible,
  value,
  columnName,
  rowNumber,
  rowValues,
  visibleRows,
  autoCopyKind,
  onAutoCopyConsumed,
  onClose,
  write = copyCsvText,
}: {
  visible: boolean;
  value: string;
  columnName: string;
  rowNumber: number;
  rowValues: readonly string[];
  visibleRows: readonly (readonly string[])[];
  autoCopyKind: CsvCopyKind | null;
  onAutoCopyConsumed: () => void;
  onClose: () => void;
  write?: (value: string) => Promise<void>;
}) {
  const { t } = useTranslation();
  const [statuses, setStatuses] = useState<Record<CsvCopyKind, CopyStatus>>({
    cell: "idle",
    row: "idle",
    visible: "idle",
  });

  useEffect(() => {
    setStatuses({ cell: "idle", row: "idle", visible: "idle" });
  }, [columnName, rowNumber, value, visible]);

  const copyValues = useMemo(
    () => ({
      cell: value,
      row: rowValues.join("\t"),
      visible: visibleRows.map((row) => row.join("\t")).join("\n"),
    }),
    [rowValues, value, visibleRows],
  );

  const copy = useCallback(
    async (kind: CsvCopyKind) => {
      setStatuses((current) => ({ ...current, [kind]: "pending" }));
      try {
        await write(copyValues[kind]);
        setStatuses((current) => ({ ...current, [kind]: "copied" }));
      } catch {
        setStatuses((current) => ({ ...current, [kind]: "failed" }));
      }
    },
    [copyValues, write],
  );

  useEffect(() => {
    if (!visible || !autoCopyKind) return;
    onAutoCopyConsumed();
    void copy(autoCopyKind);
  }, [autoCopyKind, copy, onAutoCopyConsumed, visible]);

  const actionLabel = useCallback(
    (kind: CsvCopyKind, idleLabel: string) => {
      const status = statuses[kind];
      if (status === "pending") return t("panels.file.csv.copyPending");
      if (status === "copied") return t("panels.file.csv.copySuccess");
      if (status === "failed") return t("panels.file.csv.copyFailed");
      return idleLabel;
    },
    [statuses, t],
  );
  const header = useMemo(
    () => ({ title: columnName, subtitle: t("panels.file.csv.rowNumber", { row: rowNumber }) }),
    [columnName, rowNumber, t],
  );

  return (
    <AdaptiveModalSheet
      visible={visible}
      onClose={onClose}
      header={header}
      testID="csv-value-sheet"
    >
      <View style={styles.content}>
        <Text selectable style={styles.value} testID="csv-value-text">
          {value}
        </Text>
        <View style={styles.actions}>
          <CopyButton
            kind="cell"
            label={actionLabel("cell", t("panels.file.csv.copyCell"))}
            status={statuses.cell}
            onPress={copy}
          />
          <CopyButton
            kind="row"
            label={actionLabel("row", t("panels.file.csv.copyRow"))}
            status={statuses.row}
            onPress={copy}
          />
          <CopyButton
            kind="visible"
            label={actionLabel("visible", t("panels.file.csv.copyVisibleRows"))}
            status={statuses.visible}
            onPress={copy}
          />
        </View>
      </View>
    </AdaptiveModalSheet>
  );
}

function CopyButton({
  kind,
  label,
  status,
  onPress,
}: {
  kind: CsvCopyKind;
  label: string;
  status: CopyStatus;
  onPress: (kind: CsvCopyKind) => void;
}) {
  const handlePress = useCallback(() => onPress(kind), [kind, onPress]);
  return (
    <Button
      variant="outline"
      size="sm"
      loading={status === "pending"}
      onPress={handlePress}
      testID={`csv-copy-${kind}`}
    >
      {label}
    </Button>
  );
}

const styles = StyleSheet.create((theme) => ({
  content: {
    gap: theme.spacing[4],
  },
  value: {
    color: theme.colors.foreground,
    fontFamily: theme.fontFamily.mono,
    fontSize: theme.fontSize.sm,
    lineHeight: theme.fontSize.sm * 1.5,
  },
  actions: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: theme.spacing[2],
  },
}));
