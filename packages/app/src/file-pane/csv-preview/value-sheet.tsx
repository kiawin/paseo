import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet } from "react-native-unistyles";
import { AdaptiveModalSheet, SheetHeaderSubtitle } from "@/components/adaptive-modal-sheet";
import { Button } from "@/components/ui/button";
import { FormTextInput } from "@/components/ui/form-field";
import type { EditingTextInputHandle } from "@/components/ui/text-input";
import { copyCsvText } from "./clipboard";
import { normalizeLineBreaks, restoreLineBreaks } from "./edit";
import type { CsvCopyKind } from "./grid";
import type { CsvDraftSaveError } from "./use-csv-cell-editing";

type CopyStatus = "idle" | "pending" | "copied" | "failed";

export interface CsvSheetCell {
  value: string;
  columnName: string;
  rowNumber: number;
  rowValues: readonly string[];
}

export interface CsvSheetDraft {
  /** Changes on every open, so each one mounts a fresh editor. */
  key: number;
  focusOnOpen: boolean;
  /** The file changed after the cell was opened. */
  isStale: boolean;
  /** Null when the edit was applied; the sheet's owner then closes it. */
  onSave(value: string): CsvDraftSaveError | null;
}

interface CsvValueSheetProps {
  visible: boolean;
  cell: CsvSheetCell | null;
  /** The cell is open for editing. Without it the sheet shows the value read-only. */
  draft: CsvSheetDraft | null;
  visibleRows: readonly (readonly string[])[];
  autoCopyKind: CsvCopyKind | null;
  onAutoCopyConsumed: () => void;
  onClose: () => void;
  write?: (value: string) => Promise<void>;
}

const NO_CELL: CsvSheetCell = { value: "", columnName: "", rowNumber: 0, rowValues: [] };

const DRAFT_ERROR_KEYS = {
  stale: "panels.file.csv.editChanged",
  "tsv-control-character": "panels.file.csv.editTsvCharacters",
  // No string of its own yet; the tab and line-break wording does not describe it.
  "tsv-leading-quote": "panels.file.csv.editNotApplied",
  "too-large": "panels.file.csv.editTooLarge",
  unsafe: "panels.file.csv.editNotApplied",
} as const satisfies Record<CsvDraftSaveError, string>;

export function CsvValueSheet({ visible, cell, draft, ...props }: CsvValueSheetProps) {
  if (!draft) {
    return <CsvReadonlyValueSheet visible={visible} cell={cell ?? NO_CELL} {...props} />;
  }
  // Each open mounts its own editor, so one cell's typed text never reaches another.
  if (!visible || !cell) return null;
  return <CsvEditableValueSheet key={draft.key} cell={cell} draft={draft} {...props} />;
}

type CsvSheetBodyProps = Omit<CsvValueSheetProps, "visible" | "cell" | "draft"> & {
  cell: CsvSheetCell;
};

function CsvReadonlyValueSheet({
  visible,
  cell,
  onClose,
  ...copyInput
}: CsvSheetBodyProps & { visible: boolean }) {
  const header = useSheetHeader(cell);
  const copy = useCsvCopy({ visible, cell, ...copyInput });

  return (
    <AdaptiveModalSheet
      visible={visible}
      onClose={onClose}
      header={header}
      testID="csv-value-sheet"
    >
      <View style={styles.content}>
        <Text selectable style={styles.value} testID="csv-value-text">
          {cell.value}
        </Text>
        <CsvCopyActions copy={copy} />
      </View>
    </AdaptiveModalSheet>
  );
}

function CsvEditableValueSheet({
  cell,
  draft,
  onClose,
  ...copyInput
}: CsvSheetBodyProps & { draft: CsvSheetDraft }) {
  const { t } = useTranslation();
  const inputRef = useRef<EditingTextInputHandle>(null);
  const [typed, setTyped] = useState(cell.value);
  const [saveError, setSaveError] = useState<CsvDraftSaveError | null>(null);
  const header = useSheetHeader(cell);
  // Copy cell copies what the sheet shows, which is the draft once the user has typed.
  const shownCell = useMemo(() => ({ ...cell, value: typed }), [cell, typed]);
  const copy = useCsvCopy({ visible: true, cell: shownCell, ...copyInput });
  const { onSave } = draft;

  const handleChangeText = useCallback((text: string) => {
    setTyped(text);
    setSaveError(null);
  }, []);
  const handleSave = useCallback(() => {
    // Text an input method is still composing has not reached `onChangeText`; the input has it.
    const text = inputRef.current?.getText() ?? typed;
    setSaveError(onSave(restoreLineBreaks(cell.value, text)));
  }, [cell.value, onSave, typed]);

  const isChanged = normalizeLineBreaks(typed) !== normalizeLineBreaks(cell.value);
  const error = draft.isStale ? "stale" : saveError;
  const footer = useMemo(
    () => (
      <View style={styles.footer}>
        <Button
          style={styles.footerButton}
          variant="secondary"
          onPress={onClose}
          testID="csv-edit-cancel"
        >
          {t("common.actions.cancel")}
        </Button>
        <Button
          style={styles.footerButton}
          variant="default"
          onPress={handleSave}
          disabled={!isChanged || draft.isStale}
          testID="csv-edit-save"
        >
          {t("common.actions.save")}
        </Button>
      </View>
    ),
    [draft.isStale, handleSave, isChanged, onClose, t],
  );

  return (
    <AdaptiveModalSheet
      visible
      onClose={onClose}
      header={header}
      footer={footer}
      testID="csv-value-sheet"
    >
      <View style={styles.content}>
        <View style={styles.field}>
          <FormTextInput
            ref={inputRef}
            initialValue={cell.value}
            onChangeText={handleChangeText}
            multiline
            autoFocus={draft.focusOnOpen}
            autoCapitalize="none"
            autoCorrect={false}
            spellCheck={false}
            style={styles.input}
            accessibilityLabel={cell.columnName}
            testID="csv-value-input"
          />
          {error ? (
            <Text style={styles.error} accessibilityRole="alert" testID="csv-edit-error">
              {t(DRAFT_ERROR_KEYS[error])}
            </Text>
          ) : null}
        </View>
        <CsvCopyActions copy={copy} />
      </View>
    </AdaptiveModalSheet>
  );
}

function useSheetHeader(cell: CsvSheetCell) {
  const { t } = useTranslation();
  return useMemo(
    () => ({
      title: cell.columnName,
      // The header renders its subtitle as given, and a bare string is not a valid child of a View.
      subtitle: (
        <SheetHeaderSubtitle text={t("panels.file.csv.rowNumber", { row: cell.rowNumber })} />
      ),
    }),
    [cell.columnName, cell.rowNumber, t],
  );
}

interface CsvCopy {
  statuses: Record<CsvCopyKind, CopyStatus>;
  run(kind: CsvCopyKind): void;
}

function useCsvCopy({
  visible,
  cell,
  visibleRows,
  autoCopyKind,
  onAutoCopyConsumed,
  write = copyCsvText,
}: Omit<CsvSheetBodyProps, "onClose"> & { visible: boolean }): CsvCopy {
  const { value, columnName, rowNumber, rowValues } = cell;
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

  const run = useCallback(
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
    void run(autoCopyKind);
  }, [autoCopyKind, onAutoCopyConsumed, run, visible]);

  return useMemo(() => ({ statuses, run }), [run, statuses]);
}

function CsvCopyActions({ copy }: { copy: CsvCopy }) {
  const { t } = useTranslation();
  const { statuses, run } = copy;
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

  return (
    <View style={styles.actions}>
      <CopyButton
        kind="cell"
        label={actionLabel("cell", t("panels.file.csv.copyCell"))}
        status={statuses.cell}
        onPress={run}
      />
      <CopyButton
        kind="row"
        label={actionLabel("row", t("panels.file.csv.copyRow"))}
        status={statuses.row}
        onPress={run}
      />
      <CopyButton
        kind="visible"
        label={actionLabel("visible", t("panels.file.csv.copyVisibleRows"))}
        status={statuses.visible}
        onPress={run}
      />
    </View>
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
  field: {
    gap: theme.spacing[2],
  },
  input: {
    minHeight: 120,
    fontFamily: theme.fontFamily.mono,
    fontSize: theme.fontSize.sm,
  },
  error: {
    color: theme.colors.palette.red[300],
    fontSize: theme.fontSize.xs,
  },
  actions: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: theme.spacing[2],
  },
  footer: {
    flex: 1,
    flexDirection: "row",
    gap: theme.spacing[3],
  },
  footerButton: {
    flex: 1,
  },
}));
