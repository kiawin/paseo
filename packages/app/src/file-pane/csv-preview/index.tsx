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
import { isWeb } from "@/constants/platform";
import { Button } from "@/components/ui/button";
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
import { measureCsvColumnGeometry } from "./geometry";
import { createCsvTextMeasurer } from "./text-measurer";
import { CsvGrid, type CsvGridHandle, type CsvCopyKind } from "./grid";
import { CsvToolbar } from "./toolbar";
import { CsvValueSheet } from "./value-sheet";

interface FileCsvPreviewProps {
  filePath: string;
  content: string;
  size: number;
  onSwitchToSource?: () => void;
}

interface CsvUiState {
  headerMode: CsvHeaderMode;
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
  | { type: "setHeaderMode"; mode: "header" | "data" }
  | { type: "setQuery"; query: string }
  | { type: "setSort"; column: number }
  | { type: "setFilterValues"; column: number; values: ReadonlySet<string> }
  | { type: "setColumnQuery"; column: number; query: string }
  | { type: "reconcileColumns"; columnCount: number }
  | { type: "clear" };

function createCsvUiState(): CsvUiState {
  return {
    headerMode: "auto",
    query: "",
    sort: null,
    filters: new Map(),
    columnQueries: new Map(),
  };
}

function csvUiReducer(state: CsvUiState, action: CsvUiAction): CsvUiState {
  if (action.type === "setHeaderMode") return { ...state, headerMode: action.mode };
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

function FileCsvPreviewBase({
  filePath,
  content,
  size,
  onSwitchToSource,
  csvFontFamily = "monospace",
  csvFontSize = 12,
}: FileCsvPreviewProps & { csvFontFamily: string; csvFontSize: number }) {
  const { t } = useTranslation();
  const overBudget = exceedsCsvByteBudget(size, isWeb);
  const [parseContent, setParseContent] = useState(content);
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

  const parsed = useMemo(
    () => (overBudget ? null : parseCsv(parseContent, { filePath })),
    [filePath, overBudget, parseContent],
  );
  const header = useMemo(
    () => (parsed ? resolveCsvHeader(parsed.rows, state.headerMode) : null),
    [parsed, state.headerMode],
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
  const geometry = useMemo(
    () =>
      header
        ? measureCsvColumnGeometry({ headers: header.headers, rows: header.bodyRows, measurer })
        : { widths: [], totalWidth: 0, frozenWidth: 0, columnKinds: [] },
    [header, measurer],
  );
  const view = useMemo(
    () =>
      parsed && header
        ? buildCsvViewModel({
            parsed,
            headerMode: state.headerMode,
            filters: state.filters,
            columnQueries: state.columnQueries,
            query: appliedQuery,
            sort: state.sort,
          })
        : null,
    [
      appliedQuery,
      header,
      parsed,
      state.columnQueries,
      state.filters,
      state.headerMode,
      state.sort,
    ],
  );

  const handleRaggedPress = useCallback(() => {
    const first = header?.raggedRowIndices[0];
    if (first === undefined) return;
    const visibleIndex = view?.rows.findIndex((row) => row.originalIndex === first) ?? -1;
    gridRef.current?.scrollToRow(visibleIndex >= 0 ? visibleIndex : 0);
  }, [header?.raggedRowIndices, view?.rows]);
  const handleCellPress = useCallback((rowIndex: number, column: number) => {
    setSelectedCell({ rowIndex, column });
    setAutoCopyKind(null);
    setSheetVisible(true);
  }, []);
  const handleCopyRequest = useCallback((kind: CsvCopyKind, rowIndex: number, column: number) => {
    setSelectedCell({ rowIndex, column });
    setAutoCopyKind(kind);
    setSheetVisible(true);
  }, []);
  const handleCloseSheet = useCallback(() => {
    setSheetVisible(false);
    setAutoCopyKind(null);
  }, []);
  const handleAutoCopyConsumed = useCallback(() => setAutoCopyKind(null), []);
  const handleQueryChange = useCallback((query: string) => {
    dispatch({ type: "setQuery", query });
  }, []);
  const handleToggleHeader = useCallback((value: boolean) => {
    dispatch({ type: "setHeaderMode", mode: value ? "header" : "data" });
  }, []);
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

  if (overBudget) {
    return (
      <View style={styles.state} testID="csv-preview-too-large">
        <Text style={styles.stateText}>{t("panels.file.csv.tooLarge")}</Text>
        {onSwitchToSource ? (
          <Button variant="outline" size="sm" onPress={onSwitchToSource}>
            {t("panels.file.editor.source")}
          </Button>
        ) : null}
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
      geometry={geometry}
      gridRef={gridRef}
      selectedCell={selectedCell}
      sheetVisible={sheetVisible}
      autoCopyKind={autoCopyKind}
      visibleRows={visibleRows}
      onQueryChange={handleQueryChange}
      onToggleHeader={handleToggleHeader}
      onClear={handleClear}
      onRaggedPress={handleRaggedPress}
      onSort={handleSort}
      onFilterValuesChange={handleFilterValuesChange}
      onColumnQueryChange={handleColumnQueryChange}
      onSubstringFilterChange={handleSubstringFilterChange}
      onCellPress={handleCellPress}
      onCopyRequest={handleCopyRequest}
      onAutoCopyConsumed={handleAutoCopyConsumed}
      onCloseSheet={handleCloseSheet}
    />
  );
}

function CsvPreviewContent({
  parsed,
  header,
  view,
  state,
  geometry,
  gridRef,
  selectedCell,
  sheetVisible,
  autoCopyKind,
  visibleRows,
  onQueryChange,
  onToggleHeader,
  onClear,
  onRaggedPress,
  onSort,
  onFilterValuesChange,
  onColumnQueryChange,
  onSubstringFilterChange,
  onCellPress,
  onCopyRequest,
  onAutoCopyConsumed,
  onCloseSheet,
}: {
  parsed: ParsedCsv;
  header: CsvHeaderResolution;
  view: CsvViewModel;
  state: CsvUiState;
  geometry: CsvColumnGeometry;
  gridRef: RefObject<CsvGridHandle | null>;
  selectedCell: SelectedCsvCell | null;
  sheetVisible: boolean;
  autoCopyKind: CsvCopyKind | null;
  visibleRows: readonly (readonly string[])[];
  onQueryChange: (query: string) => void;
  onToggleHeader: (value: boolean) => void;
  onClear: () => void;
  onRaggedPress: () => void;
  onSort: (column: number) => void;
  onFilterValuesChange: (column: number, values: ReadonlySet<string>) => void;
  onColumnQueryChange: (column: number, query: string) => void;
  onSubstringFilterChange: (column: number, query: string) => void;
  onCellPress: (rowIndex: number, column: number) => void;
  onCopyRequest: (kind: CsvCopyKind, rowIndex: number, column: number) => void;
  onAutoCopyConsumed: () => void;
  onCloseSheet: () => void;
}) {
  const { t } = useTranslation();

  const firstRowIsHeader =
    state.headerMode === "header" || (state.headerMode === "auto" && header.hasHeader);
  const selectedRow = selectedCell ? (header.bodyRows[selectedCell.rowIndex] ?? []) : [];
  const selectedColumn = selectedCell?.column ?? 0;
  const selectedValue = selectedRow[selectedColumn] ?? "";
  const selectedColumnName = view.headers[selectedColumn] ?? `Column ${selectedColumn + 1}`;
  const rowNumber = (selectedCell?.rowIndex ?? 0) + (header.hasHeader ? 2 : 1);
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
          onCopyRequest={onCopyRequest}
        />
      )}
      <CsvValueSheet
        visible={sheetVisible && selectedCell !== null}
        value={selectedValue}
        columnName={selectedColumnName}
        rowNumber={rowNumber}
        rowValues={selectedRow}
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
