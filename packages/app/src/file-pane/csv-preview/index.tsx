import {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type RefObject,
} from "react";
import { Text, View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import { controlSizingForLayout } from "@/components/ui/control-geometry";
import { useIsCompactFormFactor } from "@/constants/layout";
import { isWeb } from "@/constants/platform";
import type { TextFilePreviewEditor } from "@/file-panels/source/panel";
import type { TextMeasurer } from "@/text-measurement";
import {
  resolveCsvHeader,
  exceedsCsvByteBudget,
  parseCsv,
  type CsvHeaderMode,
  type CsvHeaderResolution,
  type ParsedCsv,
} from "./parse";
import { buildCsvViewModel, cycleCsvSort, reconcileCsvFilters, type CsvSortState } from "./model";
import type { CsvViewModel } from "./model";
import type { CsvColumnGeometry } from "./geometry";
import { keepCsvColumnWidths, measureCsvColumnGeometry } from "./geometry";
import { useCsvEditSession } from "./edit-session";
import {
  useCsvCellEditing,
  type CsvCellDraft,
  type CsvDraftCell,
  type CsvDraftSaveError,
  type CsvOwnEdit,
} from "./use-csv-cell-editing";
import { createCsvTextMeasurer } from "./text-measurer";
import { CsvGrid, type CsvGridHandle, type CsvCopyKind } from "./grid";
import { CsvToolbar, type CsvSaveFailure } from "./toolbar";
import { CsvValueSheet, type CsvSheetCell, type CsvSheetDraft } from "./value-sheet";

export { CsvEditSessionProvider } from "./edit-session";

interface FileCsvPreviewProps {
  filePath: string;
  content: string;
  size: number;
  /** The text panel's editor buffer. Without it the grid is read-only. */
  editor?: TextFilePreviewEditor;
}

interface CsvUiState {
  query: string;
  sort: CsvSortState | null;
  filters: Map<number, Set<string>>;
  columnQueries: Map<number, string>;
}

interface SelectedCsvCell {
  rowIndex: number;
  column: number;
}

type CsvUiAction =
  | { type: "setQuery"; query: string }
  | { type: "setSort"; column: number }
  | { type: "setFilterValues"; column: number; values: ReadonlySet<string> }
  | { type: "setColumnQuery"; column: number; query: string }
  | { type: "reconcileColumns"; columnCount: number }
  | { type: "clear" };

function createCsvUiState(): CsvUiState {
  return {
    query: "",
    sort: null,
    filters: new Map(),
    columnQueries: new Map(),
  };
}

function csvUiReducer(state: CsvUiState, action: CsvUiAction): CsvUiState {
  if (action.type === "setQuery") return { ...state, query: action.query };
  if (action.type === "setSort") return { ...state, sort: cycleCsvSort(state.sort, action.column) };
  if (action.type === "setFilterValues") {
    const filters = new Map(state.filters);
    if (action.values.size === 0) filters.delete(action.column);
    else filters.set(action.column, new Set(action.values));
    return { ...state, filters };
  }
  if (action.type === "setColumnQuery") {
    const columnQueries = new Map(state.columnQueries);
    const query = action.query.trim();
    if (query.length === 0) columnQueries.delete(action.column);
    else columnQueries.set(action.column, query);
    return { ...state, columnQueries };
  }
  if (action.type === "reconcileColumns") {
    const filters = reconcileCsvFilters(state.filters, action.columnCount);
    const columnQueries = new Map(
      [...state.columnQueries].filter(([column]) => column >= 0 && column < action.columnCount),
    );
    return { ...state, filters, columnQueries };
  }
  return {
    ...state,
    query: "",
    sort: null,
    filters: new Map(),
    columnQueries: new Map(),
  };
}

const ThemedCsvPreview = withUnistyles(FileCsvPreviewBase, (theme) => ({
  csvFontFamily: theme.fontFamily.mono,
  csvFontSize: theme.fontSize.code,
}));

export function FileCsvPreview(props: FileCsvPreviewProps) {
  return <ThemedCsvPreview {...props} />;
}

/** One of the grid's own edits: its parse, and the columns as they were laid out when it was made. */
interface CsvOwnEditView extends CsvOwnEdit {
  geometry: CsvColumnGeometry;
  measurer: TextMeasurer;
}

const EMPTY_GEOMETRY: CsvColumnGeometry = {
  widths: [],
  totalWidth: 0,
  frozenWidth: 0,
  columnKinds: [],
};

function FileCsvPreviewBase({
  filePath,
  content,
  size,
  editor,
  csvFontFamily = "monospace",
  csvFontSize = 12,
}: FileCsvPreviewProps & { csvFontFamily: string; csvFontSize: number }) {
  const { t } = useTranslation();
  const overBudget = exceedsCsvByteBudget(size, isWeb);
  const session = useCsvEditSession();
  const headerMode = session.state.headerMode;
  const dispatchSession = session.dispatch;
  const isPointerSized = controlSizingForLayout(useIsCompactFormFactor()) === "pointer";
  const [parseContent, setParseContent] = useState(content);
  const [ownEdit, setOwnEdit] = useState<CsvOwnEditView | null>(null);
  const [state, dispatch] = useReducer(csvUiReducer, undefined, createCsvUiState);
  const [appliedQuery, setAppliedQuery] = useState("");
  const [selectedCell, setSelectedCell] = useState<SelectedCsvCell | null>(null);
  const [sheetVisible, setSheetVisible] = useState(false);
  const [autoCopyKind, setAutoCopyKind] = useState<CsvCopyKind | null>(null);
  const gridRef = useRef<CsvGridHandle>(null);

  useEffect(() => {
    const timeout = setTimeout(() => setParseContent(content), 100);
    return () => clearTimeout(timeout);
  }, [content]);

  const parsed = useMemo(() => {
    if (overBudget) return null;
    if (ownEdit?.text === parseContent) return ownEdit.parsed;
    return parseCsv(parseContent, { filePath });
  }, [filePath, overBudget, ownEdit, parseContent]);
  const header = useMemo(
    () => (parsed ? resolveCsvHeader(parsed.rows, headerMode) : null),
    [parsed, headerMode],
  );

  useEffect(() => {
    if (!header) return;
    dispatch({ type: "reconcileColumns", columnCount: header.headers.length });
  }, [header]);

  useEffect(() => {
    const timeout = setTimeout(() => setAppliedQuery(state.query), 120);
    return () => clearTimeout(timeout);
  }, [state.query]);

  const measurer = useMemo(
    () => createCsvTextMeasurer({ configuredFamily: csvFontFamily, fontSize: csvFontSize }),
    [csvFontFamily, csvFontSize],
  );
  const measuredGeometry = useMemo(
    () =>
      header
        ? measureCsvColumnGeometry({ headers: header.headers, rows: header.bodyRows, measurer })
        : EMPTY_GEOMETRY,
    [header, measurer],
  );
  const geometry = useMemo(() => {
    if (!ownEdit || ownEdit.text !== parseContent || ownEdit.measurer !== measurer) {
      return measuredGeometry;
    }
    return keepCsvColumnWidths(measuredGeometry, ownEdit.geometry);
  }, [measuredGeometry, measurer, ownEdit, parseContent]);
  const view = useMemo(
    () =>
      parsed && header
        ? buildCsvViewModel({
            parsed,
            headerMode,
            filters: state.filters,
            columnQueries: state.columnQueries,
            query: appliedQuery,
            sort: state.sort,
          })
        : null,
    [appliedQuery, header, headerMode, parsed, state.columnQueries, state.filters, state.sort],
  );

  // The grid's own edit is shown at once, with the parse the edit already made.
  const handleOwnEdit = useCallback(
    (edit: CsvOwnEdit) => {
      setParseContent(edit.text);
      setOwnEdit({ ...edit, geometry, measurer });
    },
    [geometry, measurer],
  );
  const editing = useCsvCellEditing({
    editor,
    session,
    filePath,
    content,
    parseContent,
    parsed,
    header,
    onOwnEdit: handleOwnEdit,
  });
  const { openDraft, closeDraft, saveDraft } = editing;
  const hasEditor = editor !== undefined;

  const handleRaggedPress = useCallback(() => {
    const first = header?.raggedRowIndices[0];
    if (first === undefined) return;
    const visibleIndex = view?.rows.findIndex((row) => row.originalIndex === first) ?? -1;
    gridRef.current?.scrollToRow(visibleIndex >= 0 ? visibleIndex : 0);
  }, [header?.raggedRowIndices, view?.rows]);
  const openSheet = useCallback(
    (cell: CsvDraftCell, copyKind: CsvCopyKind | null) => {
      openDraft(cell);
      setSelectedCell({ rowIndex: cell.rowIndex, column: cell.column });
      setAutoCopyKind(copyKind);
      setSheetVisible(true);
    },
    [openDraft],
  );
  const handleCellPress = useCallback(
    (rowIndex: number, column: number) =>
      openSheet({ rowIndex, column, focusOnOpen: isPointerSized }, null),
    [isPointerSized, openSheet],
  );
  const handleEditRequest = useCallback(
    (rowIndex: number, column: number) => openSheet({ rowIndex, column, focusOnOpen: true }, null),
    [openSheet],
  );
  const handleCopyRequest = useCallback(
    (kind: CsvCopyKind, rowIndex: number, column: number) =>
      openSheet({ rowIndex, column, focusOnOpen: false }, kind),
    [openSheet],
  );
  const handleCloseSheet = useCallback(() => {
    setSheetVisible(false);
    setAutoCopyKind(null);
    closeDraft();
  }, [closeDraft]);
  const handleSaveDraft = useCallback(
    (value: string): CsvDraftSaveError | null => {
      const error = saveDraft(value);
      if (error) return error;
      setSheetVisible(false);
      setAutoCopyKind(null);
      return null;
    },
    [saveDraft],
  );
  const handleAutoCopyConsumed = useCallback(() => setAutoCopyKind(null), []);
  const handleQueryChange = useCallback((query: string) => {
    dispatch({ type: "setQuery", query });
  }, []);
  const handleToggleHeader = useCallback(
    (value: boolean) => {
      dispatchSession({ type: "setHeaderMode", mode: value ? "header" : "data" });
    },
    [dispatchSession],
  );
  const handleClear = useCallback(() => dispatch({ type: "clear" }), []);
  const handleSort = useCallback((column: number) => dispatch({ type: "setSort", column }), []);
  const handleFilterValuesChange = useCallback(
    (column: number, values: ReadonlySet<string>) =>
      dispatch({ type: "setFilterValues", column, values }),
    [],
  );
  const handleColumnQueryChange = useCallback((column: number, query: string) => {
    dispatch({ type: "setColumnQuery", column, query });
  }, []);
  const handleSubstringFilterChange = useCallback((column: number, query: string) => {
    dispatch({ type: "setColumnQuery", column, query });
  }, []);
  const visibleRows = useMemo(() => view?.rows.map((row) => row.values) ?? [], [view?.rows]);
  const sheetDraft = useMemo<CsvSheetDraft | null>(
    () =>
      editing.draft
        ? {
            key: editing.draft.key,
            focusOnOpen: editing.draft.focusOnOpen,
            isStale: editing.isDraftStale,
            onSave: handleSaveDraft,
          }
        : null,
    [editing.draft, editing.isDraftStale, handleSaveDraft],
  );
  const saveFailure = useMemo<CsvSaveFailure | null>(
    () =>
      editor?.status === "error" ? { message: editor.error ?? "", onRetry: editor.save } : null,
    [editor],
  );

  if (overBudget) {
    return (
      <View style={styles.state} testID="csv-preview-too-large">
        <Text style={styles.stateText}>{t("panels.file.csv.tooLarge")}</Text>
      </View>
    );
  }

  if (!parsed || !header || !view) return null;

  return (
    <CsvPreviewContent
      parsed={parsed}
      header={header}
      view={view}
      state={state}
      headerMode={headerMode}
      geometry={geometry}
      gridRef={gridRef}
      sheetCell={sheetCellFor({ draft: editing.draft, selectedCell, header })}
      sheetVisible={sheetVisible}
      sheetDraft={sheetDraft}
      autoCopyKind={autoCopyKind}
      visibleRows={visibleRows}
      saveFailure={saveFailure}
      onUndo={editing.canUndo ? editing.undo : undefined}
      onQueryChange={handleQueryChange}
      onToggleHeader={handleToggleHeader}
      onClear={handleClear}
      onRaggedPress={handleRaggedPress}
      onSort={handleSort}
      onFilterValuesChange={handleFilterValuesChange}
      onColumnQueryChange={handleColumnQueryChange}
      onSubstringFilterChange={handleSubstringFilterChange}
      onCellPress={handleCellPress}
      onEditRequest={hasEditor ? handleEditRequest : undefined}
      onCopyRequest={handleCopyRequest}
      onAutoCopyConsumed={handleAutoCopyConsumed}
      onCloseSheet={handleCloseSheet}
    />
  );
}

/** What the sheet shows: the draft's captured cell while one is open, the live cell otherwise. */
function sheetCellFor(input: {
  draft: CsvCellDraft | null;
  selectedCell: SelectedCsvCell | null;
  header: CsvHeaderResolution;
}): CsvSheetCell | null {
  const { draft, selectedCell, header } = input;
  if (draft) return draft;
  if (!selectedCell) return null;
  const rowValues = header.bodyRows[selectedCell.rowIndex] ?? [];
  const column = selectedCell.column;
  return {
    value: rowValues[column] ?? "",
    columnName: header.headers[column] ?? `Column ${column + 1}`,
    rowNumber: selectedCell.rowIndex + (header.hasHeader ? 2 : 1),
    rowValues,
  };
}

function CsvPreviewContent({
  parsed,
  header,
  view,
  state,
  headerMode,
  geometry,
  gridRef,
  sheetCell,
  sheetVisible,
  sheetDraft,
  autoCopyKind,
  visibleRows,
  saveFailure,
  onUndo,
  onQueryChange,
  onToggleHeader,
  onClear,
  onRaggedPress,
  onSort,
  onFilterValuesChange,
  onColumnQueryChange,
  onSubstringFilterChange,
  onCellPress,
  onEditRequest,
  onCopyRequest,
  onAutoCopyConsumed,
  onCloseSheet,
}: {
  parsed: ParsedCsv;
  header: CsvHeaderResolution;
  view: CsvViewModel;
  state: CsvUiState;
  headerMode: CsvHeaderMode;
  geometry: CsvColumnGeometry;
  gridRef: RefObject<CsvGridHandle | null>;
  sheetCell: CsvSheetCell | null;
  sheetVisible: boolean;
  sheetDraft: CsvSheetDraft | null;
  autoCopyKind: CsvCopyKind | null;
  visibleRows: readonly (readonly string[])[];
  saveFailure: CsvSaveFailure | null;
  onUndo: (() => void) | undefined;
  onQueryChange: (query: string) => void;
  onToggleHeader: (value: boolean) => void;
  onClear: () => void;
  onRaggedPress: () => void;
  onSort: (column: number) => void;
  onFilterValuesChange: (column: number, values: ReadonlySet<string>) => void;
  onColumnQueryChange: (column: number, query: string) => void;
  onSubstringFilterChange: (column: number, query: string) => void;
  onCellPress: (rowIndex: number, column: number) => void;
  onEditRequest: ((rowIndex: number, column: number) => void) | undefined;
  onCopyRequest: (kind: CsvCopyKind, rowIndex: number, column: number) => void;
  onAutoCopyConsumed: () => void;
  onCloseSheet: () => void;
}) {
  const { t } = useTranslation();

  const firstRowIsHeader = headerMode === "header" || (headerMode === "auto" && header.hasHeader);
  const hasActiveFilters = state.filters.size > 0 || state.columnQueries.size > 0;

  return (
    <View style={styles.container} testID="csv-preview">
      <CsvToolbar
        query={state.query}
        visibleRowCount={view.rows.length}
        totalRowCount={header.bodyRows.length}
        firstRowIsHeader={firstRowIsHeader}
        hasActiveFilters={hasActiveFilters}
        raggedCount={header.raggedRowIndices.length}
        truncated={parsed.truncated || parsed.unterminatedQuote}
        saveFailure={saveFailure}
        onUndo={onUndo}
        onQueryChange={onQueryChange}
        onToggleHeader={onToggleHeader}
        onClear={onClear}
        onRaggedPress={onRaggedPress}
      />
      {view.rows.length === 0 && header.bodyRows.length === 0 ? (
        <View style={styles.state} testID="csv-empty">
          <Text style={styles.stateText}>{t("panels.file.csv.empty")}</Text>
        </View>
      ) : (
        <CsvGrid
          ref={gridRef}
          headers={view.headers}
          headerMatches={view.headerMatches}
          rows={view.rows}
          allRows={header.bodyRows}
          geometry={geometry}
          sort={state.sort}
          filters={state.filters}
          columnQueries={state.columnQueries}
          onSort={onSort}
          onFilterValuesChange={onFilterValuesChange}
          onColumnQueryChange={onColumnQueryChange}
          onSubstringFilterChange={onSubstringFilterChange}
          onCellPress={onCellPress}
          onEditRequest={onEditRequest}
          onCopyRequest={onCopyRequest}
        />
      )}
      <CsvValueSheet
        visible={sheetVisible && sheetCell !== null}
        cell={sheetCell}
        draft={sheetDraft}
        visibleRows={visibleRows}
        autoCopyKind={autoCopyKind}
        onAutoCopyConsumed={onAutoCopyConsumed}
        onClose={onCloseSheet}
      />
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: {
    flex: 1,
    minHeight: 0,
    backgroundColor: theme.colors.surface0,
  },
  state: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: theme.spacing[3],
    padding: theme.spacing[4],
  },
  stateText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.base,
    textAlign: "center",
  },
}));
