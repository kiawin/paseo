import {
  forwardRef,
  useCallback,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type ReactElement,
} from "react";
import {
  FlatList as NativeFlatList,
  StyleSheet as RNStyleSheet,
  View,
  type LayoutChangeEvent,
  type ViewStyle,
} from "react-native";
import { StyleSheet } from "react-native-unistyles";
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  type SharedValue,
} from "react-native-reanimated";
import { useTranslation } from "react-i18next";
import { FlatList } from "@/components/ui/scroll-view";
import { inlineUnistylesStyle } from "@/styles/unistyles-inline-style";
import {
  HorizontalScrollBoundaryShades,
  useHorizontalScrollBoundary,
} from "@/components/ui/horizontal-scroll-boundary";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { HighlightedText } from "@/components/ui/highlighted-text";
import { CsvHorizontalPan } from "./horizontal-pan";
import { CsvHeaderRow } from "./header-row";
import { csvRowLayout, type CsvColumnGeometry, type CsvColumnKind } from "./geometry";
import type { CsvFilters, CsvViewRow, CsvSortState } from "./model";

export interface CsvGridHandle {
  scrollToRow(index: number): void;
}

export type CsvCopyKind = "cell" | "row" | "visible";

export interface CsvGridProps {
  headers: readonly string[];
  headerMatches: ReadonlyArray<ReadonlyArray<{ start: number; length: number }>>;
  rows: readonly CsvViewRow[];
  allRows: readonly (readonly string[])[];
  geometry: CsvColumnGeometry;
  sort: CsvSortState | null;
  filters: CsvFilters;
  columnQueries: ReadonlyMap<number, string>;
  onSort: (column: number) => void;
  onFilterValuesChange: (column: number, values: ReadonlySet<string>) => void;
  onColumnQueryChange: (column: number, query: string) => void;
  onSubstringFilterChange: (column: number, query: string) => void;
  onCellPress: (rowIndex: number, column: number) => void;
  onCopyRequest: (kind: CsvCopyKind, rowIndex: number, column: number) => void;
  testID?: string;
}

export const CsvGrid = forwardRef<CsvGridHandle, CsvGridProps>(function CsvGrid(
  {
    headers,
    headerMatches,
    rows,
    allRows,
    geometry,
    sort,
    filters,
    columnQueries,
    onSort,
    onFilterValuesChange,
    onColumnQueryChange,
    onSubstringFilterChange,
    onCellPress,
    onCopyRequest,
    testID = "csv-grid",
  },
  forwardedRef,
): ReactElement {
  const [viewportWidth, setViewportWidth] = useState(0);
  const scrollX = useSharedValue(0);
  const maxScrollX = useSharedValue(0);
  const listRef = useRef<NativeFlatList<CsvViewRow>>(null);
  const scrollBoundary = useHorizontalScrollBoundary(scrollX);
  const totalWidth = Math.max(viewportWidth, geometry.totalWidth);
  const resolvedGeometry = useMemo(() => ({ ...geometry, totalWidth }), [geometry, totalWidth]);

  useImperativeHandle(
    forwardedRef,
    () => ({
      scrollToRow(index) {
        listRef.current?.scrollToIndex({ index, animated: true, viewPosition: 0 });
      },
    }),
    [],
  );

  const handleLayout = useCallback(
    (event: LayoutChangeEvent) => {
      const width = event.nativeEvent.layout.width;
      setViewportWidth(width);
      maxScrollX.value = Math.max(0, geometry.totalWidth - width);
      if (scrollX.value > maxScrollX.value) scrollX.value = maxScrollX.value;
      scrollBoundary.onLayout(event);
      scrollBoundary.onContentSizeChange(geometry.totalWidth);
    },
    [geometry.totalWidth, maxScrollX, scrollBoundary, scrollX],
  );

  const renderRow = useCallback(
    ({ item }: { item: CsvViewRow }) => (
      <CsvGridRow
        row={item}
        geometry={resolvedGeometry}
        scrollX={scrollX}
        onCellPress={onCellPress}
        onCopyRequest={onCopyRequest}
      />
    ),
    [onCellPress, onCopyRequest, resolvedGeometry, scrollX],
  );

  return (
    <CsvHorizontalPan scrollX={scrollX} maxScrollX={maxScrollX}>
      <View style={styles.root} onLayout={handleLayout} testID={testID}>
        <View style={styles.headerClip}>
          <CsvHeaderRow
            headers={headers}
            headerMatches={headerMatches}
            rows={allRows}
            geometry={resolvedGeometry}
            scrollX={scrollX}
            sort={sort}
            filters={filters}
            columnQueries={columnQueries}
            onSort={onSort}
            onFilterValuesChange={onFilterValuesChange}
            onColumnQueryChange={onColumnQueryChange}
            onSubstringFilterChange={onSubstringFilterChange}
          />
        </View>
        <FlatList
          ref={listRef}
          data={rows}
          keyExtractor={csvRowKey}
          renderItem={renderRow}
          style={styles.list}
          contentContainerStyle={inlineUnistylesStyle({ width: totalWidth })}
          getItemLayout={csvGetItemLayout}
          showsVerticalScrollIndicator
          testID={`${testID}-list`}
        />
        <HorizontalScrollBoundaryShades
          visible={geometry.totalWidth > viewportWidth}
          backdrop="surface"
          testIDPrefix={`${testID}-scroll-shade`}
          leftStyle={scrollBoundary.leftShadeStyle}
          rightStyle={scrollBoundary.rightShadeStyle}
        />
      </View>
    </CsvHorizontalPan>
  );
});

function CsvGridRow({
  row,
  geometry,
  scrollX,
  onCellPress,
  onCopyRequest,
}: {
  row: CsvViewRow;
  geometry: CsvColumnGeometry;
  scrollX: SharedValue<number>;
  onCellPress: (rowIndex: number, column: number) => void;
  onCopyRequest: (kind: CsvCopyKind, rowIndex: number, column: number) => void;
}) {
  const bodyStyle = useAnimatedStyle(
    () => ({ transform: [{ translateX: -scrollX.value }] }),
    [scrollX],
  );
  const rowStyle = inlineUnistylesStyle({ width: geometry.totalWidth, height: 34 });

  return (
    <View style={[styles.row, rowStyle]} testID={`csv-row-${row.originalIndex}`}>
      <View
        style={[
          styles.frozenCell,
          inlineUnistylesStyle({ width: geometry.frozenWidth, height: 34 }),
        ]}
      >
        <CsvCell
          value={row.values[0] ?? ""}
          ranges={row.matches[0] ?? []}
          width={geometry.frozenWidth}
          columnKind={geometry.columnKinds[0] ?? "text"}
          rowIndex={row.originalIndex}
          column={0}
          onCellPress={onCellPress}
          onCopyRequest={onCopyRequest}
          testID={`csv-cell-${row.originalIndex}-0`}
        />
      </View>
      <Animated.View
        style={[
          animatedStyles.bodyCells,
          inlineUnistylesStyle({
            marginLeft: geometry.frozenWidth,
            width: geometry.totalWidth - geometry.frozenWidth,
          }),
          bodyStyle,
        ]}
      >
        {row.values.slice(1).map((value, index) => {
          const column = index + 1;
          return (
            <CsvCell
              key={`${row.originalIndex}-${column}`}
              value={value}
              ranges={row.matches[column] ?? []}
              width={geometry.widths[column] ?? 120}
              columnKind={geometry.columnKinds[column] ?? "text"}
              rowIndex={row.originalIndex}
              column={column}
              onCellPress={onCellPress}
              onCopyRequest={onCopyRequest}
              testID={`csv-cell-${row.originalIndex}-${column}`}
            />
          );
        })}
      </Animated.View>
    </View>
  );
}

function CsvCell({
  value,
  ranges,
  width,
  columnKind,
  rowIndex,
  column,
  onCellPress,
  onCopyRequest,
  testID,
}: {
  value: string;
  ranges: readonly { start: number; length: number }[];
  width: number;
  columnKind: CsvColumnKind;
  rowIndex: number;
  column: number;
  onCellPress: (rowIndex: number, column: number) => void;
  onCopyRequest: (kind: CsvCopyKind, rowIndex: number, column: number) => void;
  testID: string;
}) {
  const { t } = useTranslation();
  const handlePress = useCallback(
    () => onCellPress(rowIndex, column),
    [column, onCellPress, rowIndex],
  );
  const handleCopyCell = useCallback(
    () => onCopyRequest("cell", rowIndex, column),
    [column, onCopyRequest, rowIndex],
  );
  const handleCopyRow = useCallback(
    () => onCopyRequest("row", rowIndex, column),
    [column, onCopyRequest, rowIndex],
  );
  const handleCopyVisible = useCallback(
    () => onCopyRequest("visible", rowIndex, column),
    [column, onCopyRequest, rowIndex],
  );

  return (
    <ContextMenu>
      <ContextMenuTrigger
        onPress={handlePress}
        style={[
          styles.cell,
          textAlignmentStyle(columnKind),
          inlineUnistylesStyle({ width, height: 34 }),
        ]}
        accessibilityRole="button"
        accessibilityLabel={value}
        testID={testID}
      >
        <HighlightedText
          text={value}
          ranges={ranges}
          style={[styles.cellText, columnKind === "numeric" ? styles.numericCellText : null]}
          numberOfLines={1}
        />
      </ContextMenuTrigger>
      <ContextMenuContent minWidth={200} testID={`${testID}-context-menu`}>
        <ContextMenuItem onSelect={handleCopyCell}>{t("panels.file.csv.copyCell")}</ContextMenuItem>
        <ContextMenuItem onSelect={handleCopyRow}>{t("panels.file.csv.copyRow")}</ContextMenuItem>
        <ContextMenuItem onSelect={handleCopyVisible}>
          {t("panels.file.csv.copyVisibleRows")}
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}

function csvRowKey(row: CsvViewRow): string {
  return `csv-row-${row.originalIndex}`;
}

function csvGetItemLayout(_: ArrayLike<CsvViewRow> | null | undefined, index: number) {
  return csvRowLayout(index);
}

const styles = StyleSheet.create((theme) => ({
  root: {
    flex: 1,
    minHeight: 0,
    overflow: "hidden",
    backgroundColor: theme.colors.surface0,
  },
  headerClip: {
    overflow: "hidden",
    borderBottomWidth: theme.borderWidth[1],
    borderBottomColor: theme.colors.border,
  },
  list: {
    flex: 1,
    minHeight: 0,
  },
  row: {
    position: "relative",
    flexDirection: "row",
    borderBottomWidth: theme.borderWidth[1],
    borderBottomColor: theme.colors.border,
  },
  frozenCell: {
    position: "absolute",
    left: 0,
    top: 0,
    zIndex: 1,
    backgroundColor: theme.colors.surface0,
    borderRightWidth: theme.borderWidth[1],
    borderRightColor: theme.colors.border,
  },
  cell: {
    justifyContent: "center",
    textAlign: "left",
    paddingHorizontal: theme.spacing[3],
    backgroundColor: theme.colors.surface0,
    borderRightWidth: theme.borderWidth[1],
    borderRightColor: theme.colors.border,
  },
  cellText: {
    color: theme.colors.foreground,
    fontFamily: theme.fontFamily.mono,
    fontSize: theme.fontSize.code,
    textAlign: "left",
  },
  numericCellText: {
    textAlign: "right",
  },
}));

const animatedStyles = RNStyleSheet.create({
  bodyCells: {
    flexDirection: "row",
    position: "absolute",
    top: 0,
    bottom: 0,
  },
});

function textAlignmentStyle(columnKind: CsvColumnKind): ViewStyle {
  return inlineUnistylesStyle({
    textAlign: columnKind === "numeric" ? "right" : "left",
  }) as unknown as ViewStyle;
}
