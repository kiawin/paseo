import { useCallback, useMemo, useState } from "react";
import { Pressable, StyleSheet as RNStyleSheet, View, type ViewStyle } from "react-native";
import { useTranslation } from "react-i18next";
import { ArrowDown, ArrowUp, Filter } from "lucide-react-native";
import Animated, { useAnimatedStyle, type SharedValue } from "react-native-reanimated";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { isNative } from "@/constants/platform";
import { useIsCompactFormFactor } from "@/constants/layout";
import { inlineUnistylesStyle } from "@/styles/unistyles-inline-style";
import { HighlightedText } from "@/components/ui/highlighted-text";
import {
  MenuHint,
  MenuItem,
  MenuLabel,
  MenuRoot,
  MenuSurface,
  MenuTextField,
  MenuSeparator,
  MenuTrigger,
} from "@/components/ui/menu";
import type { Theme } from "@/styles/theme";
import { MAX_DISTINCT, type CsvFilters, type CsvSortState, distinctValuesForColumn } from "./model";
import type { CsvColumnGeometry, CsvColumnKind } from "./geometry";

const ThemedFilter = withUnistyles(Filter);
const ThemedArrowUp = withUnistyles(ArrowUp);
const ThemedArrowDown = withUnistyles(ArrowDown);

const mutedIconMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const activeIconMapping = (theme: Theme) => ({ color: theme.colors.accent });

export interface CsvHeaderRowProps {
  headers: readonly string[];
  headerMatches: ReadonlyArray<ReadonlyArray<{ start: number; length: number }>>;
  rows: readonly (readonly string[])[];
  geometry: CsvColumnGeometry;
  scrollX: SharedValue<number>;
  sort: CsvSortState | null;
  filters: CsvFilters;
  columnQueries: ReadonlyMap<number, string>;
  onSort: (column: number) => void;
  onFilterValuesChange: (column: number, values: ReadonlySet<string>) => void;
  onColumnQueryChange: (column: number, query: string) => void;
  onSubstringFilterChange: (column: number, query: string) => void;
}

export function CsvHeaderRow({
  headers,
  headerMatches,
  rows,
  geometry,
  scrollX,
  sort,
  filters,
  columnQueries,
  onSort,
  onFilterValuesChange,
  onColumnQueryChange,
  onSubstringFilterChange,
}: CsvHeaderRowProps) {
  const bodyStyle = useAnimatedStyle(
    () => ({ transform: [{ translateX: -scrollX.value }] }),
    [scrollX],
  );

  return (
    <View
      style={[styles.row, inlineUnistylesStyle({ width: geometry.totalWidth, height: 36 })]}
      testID="csv-header-row"
    >
      <View
        style={[
          styles.frozenCell,
          inlineUnistylesStyle({ width: geometry.frozenWidth, height: 36 }),
        ]}
        testID="csv-spike-header-cell-0"
      >
        <CsvHeaderCell
          column={0}
          label={headers[0] ?? ""}
          matchRanges={headerMatches[0] ?? []}
          width={geometry.widths[0] ?? geometry.frozenWidth}
          columnKind={geometry.columnKinds[0] ?? "text"}
          sort={sort?.column === 0 ? sort : null}
          filterValues={filters.get(0) ?? new Set()}
          query={columnQueries.get(0) ?? ""}
          rows={rows}
          onSort={onSort}
          onFilterValuesChange={onFilterValuesChange}
          onColumnQueryChange={onColumnQueryChange}
          onSubstringFilterChange={onSubstringFilterChange}
        />
      </View>
      <Animated.View
        style={[
          animatedStyles.bodyCells,
          inlineUnistylesStyle({ marginLeft: geometry.frozenWidth }),
          bodyStyle,
        ]}
        testID="csv-spike-header-body"
      >
        {headers.slice(1).map((label, index) => {
          const column = index + 1;
          return (
            <View
              key={`csv-header-${column}`}
              style={inlineUnistylesStyle({ width: geometry.widths[column] ?? 120, height: 36 })}
            >
              <CsvHeaderCell
                column={column}
                label={label}
                matchRanges={headerMatches[column] ?? []}
                width={geometry.widths[column] ?? 120}
                columnKind={geometry.columnKinds[column] ?? "text"}
                sort={sort?.column === column ? sort : null}
                filterValues={filters.get(column) ?? new Set()}
                query={columnQueries.get(column) ?? ""}
                rows={rows}
                onSort={onSort}
                onFilterValuesChange={onFilterValuesChange}
                onColumnQueryChange={onColumnQueryChange}
                onSubstringFilterChange={onSubstringFilterChange}
              />
            </View>
          );
        })}
      </Animated.View>
    </View>
  );
}

function CsvHeaderCell({
  column,
  label,
  matchRanges,
  width,
  columnKind,
  sort,
  filterValues,
  query,
  rows,
  onSort,
  onFilterValuesChange,
  onColumnQueryChange,
  onSubstringFilterChange,
}: {
  column: number;
  label: string;
  matchRanges: readonly { start: number; length: number }[];
  width: number;
  columnKind: CsvColumnKind;
  sort: CsvSortState | null;
  filterValues: ReadonlySet<string>;
  query: string;
  rows: readonly (readonly string[])[];
  onSort: (column: number) => void;
  onFilterValuesChange: (column: number, values: ReadonlySet<string>) => void;
  onColumnQueryChange: (column: number, query: string) => void;
  onSubstringFilterChange: (column: number, query: string) => void;
}) {
  const { t } = useTranslation();
  const [isHovered, setIsHovered] = useState(false);
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const isCompact = useIsCompactFormFactor();
  const isFiltered = filterValues.size > 0 || query.length > 0;
  const showFilter = isHovered || isFiltered || isMenuOpen || isNative || isCompact;
  const handlePointerEnter = useCallback(() => setIsHovered(true), []);
  const handlePointerLeave = useCallback(() => setIsHovered(false), []);
  const handleSort = useCallback(() => onSort(column), [column, onSort]);
  let sortLabel = t("panels.file.csv.sortUnsorted");
  if (sort) {
    sortLabel =
      sort.direction === "ascending"
        ? t("panels.file.csv.sortAscending")
        : t("panels.file.csv.sortDescending");
  }
  const accessibilityLabel = `${label || `Column ${column + 1}`}, ${sortLabel}`;

  return (
    <View
      style={[styles.headerCell, textAlignmentStyle(columnKind), inlineUnistylesStyle({ width })]}
      onPointerEnter={handlePointerEnter}
      onPointerLeave={handlePointerLeave}
    >
      <Pressable
        role="columnheader"
        accessibilityLabel={accessibilityLabel}
        aria-sort={sort?.direction ?? "none"}
        onPress={handleSort}
        style={[styles.sortTarget, textAlignmentStyle(columnKind)]}
        testID={`csv-sort-${column}`}
      >
        <HighlightedText
          text={label || `Column ${column + 1}`}
          ranges={matchRanges}
          style={[styles.headerText, columnKind === "numeric" ? styles.numericHeaderText : null]}
        />
        {sort?.direction === "ascending" ? (
          <ThemedArrowUp size={13} uniProps={activeIconMapping} />
        ) : null}
        {sort?.direction === "descending" ? (
          <ThemedArrowDown size={13} uniProps={activeIconMapping} />
        ) : null}
      </Pressable>
      <MenuRoot compactMode="sheet" open={isMenuOpen} onOpenChange={setIsMenuOpen}>
        <MenuTrigger
          accessibilityRole="button"
          accessibilityLabel={t("panels.file.csv.filterAccessibility", {
            column: label || `Column ${column + 1}`,
          })}
          style={[styles.filterTrigger, showFilter ? null : styles.hiddenTrigger]}
          testID={`csv-filter-${column}`}
        >
          {({ open }) => (
            <ThemedFilter
              size={14}
              uniProps={open || isFiltered ? activeIconMapping : mutedIconMapping}
            />
          )}
        </MenuTrigger>
        <MenuSurface scrollable maxHeight={360} minWidth={240} testID={`csv-filter-menu-${column}`}>
          <CsvColumnMenu
            column={column}
            rows={rows}
            selected={filterValues}
            query={query}
            onSelectedChange={onFilterValuesChange}
            onQueryChange={onColumnQueryChange}
            onSubstringFilterChange={onSubstringFilterChange}
          />
        </MenuSurface>
      </MenuRoot>
    </View>
  );
}

function CsvColumnMenu({
  column,
  rows,
  selected,
  query,
  onSelectedChange,
  onQueryChange,
  onSubstringFilterChange,
}: {
  column: number;
  rows: readonly (readonly string[])[];
  selected: ReadonlySet<string>;
  query: string;
  onSelectedChange: (column: number, values: ReadonlySet<string>) => void;
  onQueryChange: (column: number, query: string) => void;
  onSubstringFilterChange: (column: number, query: string) => void;
}) {
  const { t } = useTranslation();
  const distinct = useMemo(() => distinctValuesForColumn(rows, column), [column, rows]);
  const visibleValues = distinct.values.filter((value) =>
    value.toLocaleLowerCase().includes(query.toLocaleLowerCase()),
  );
  const handleSubmit = useCallback(() => {
    if (selected.size === 0) onSubstringFilterChange(column, query.trim());
  }, [column, onSubstringFilterChange, query, selected.size]);
  const handleQueryChange = useCallback(
    (value: string) => onQueryChange(column, value),
    [column, onQueryChange],
  );
  const toggleValue = useCallback(
    (value: string) => {
      const next = new Set(selected);
      if (next.has(value)) next.delete(value);
      else next.add(value);
      onSelectedChange(column, next);
    },
    [column, onSelectedChange, selected],
  );
  const selectAll = useCallback(
    () => onSelectedChange(column, new Set(distinct.values)),
    [column, distinct.values, onSelectedChange],
  );
  const clear = useCallback(() => {
    onSelectedChange(column, new Set());
    onSubstringFilterChange(column, "");
  }, [column, onSelectedChange, onSubstringFilterChange]);

  return (
    <>
      <MenuTextField
        initialValue={query}
        onChangeText={handleQueryChange}
        onSubmitEditing={handleSubmit}
        placeholder={t("panels.file.csv.filterValues")}
        accessibilityLabel={t("panels.file.csv.filterValues")}
        testID={`csv-filter-search-${column}`}
      />
      {distinct.capped ? (
        <MenuHint>{t("panels.file.csv.tooManyValues", { count: MAX_DISTINCT })}</MenuHint>
      ) : (
        <>
          <MenuItem
            closeOnSelect={false}
            onSelect={selectAll}
            testID={`csv-filter-select-all-${column}`}
          >
            {t("panels.file.csv.selectAll")}
          </MenuItem>
          <MenuItem closeOnSelect={false} onSelect={clear} testID={`csv-filter-clear-${column}`}>
            {t("panels.file.csv.clear")}
          </MenuItem>
          <MenuSeparator />
          <MenuLabel>
            {selected.size > 0
              ? t("panels.file.csv.selected", { count: selected.size })
              : t("panels.file.csv.values")}
          </MenuLabel>
          {visibleValues.map((value) => (
            <CsvFilterValueItem
              key={value}
              value={value}
              selected={selected.has(value)}
              onToggle={toggleValue}
              testID={`csv-filter-value-${column}-${value || "empty"}`}
              emptyLabel={t("panels.file.csv.emptyValue")}
            />
          ))}
        </>
      )}
    </>
  );
}

function CsvFilterValueItem({
  value,
  selected,
  onToggle,
  testID,
  emptyLabel,
}: {
  value: string;
  selected: boolean;
  onToggle: (value: string) => void;
  testID: string;
  emptyLabel: string;
}) {
  const handleSelect = useCallback(() => onToggle(value), [onToggle, value]);
  return (
    <MenuItem selected={selected} closeOnSelect={false} onSelect={handleSelect} testID={testID}>
      {value || emptyLabel}
    </MenuItem>
  );
}

const styles = StyleSheet.create((theme) => ({
  row: {
    position: "relative",
    flexDirection: "row",
    backgroundColor: theme.colors.surface1,
    borderBottomWidth: theme.borderWidth[1],
    borderBottomColor: theme.colors.border,
  },
  frozenCell: {
    position: "absolute",
    left: 0,
    top: 0,
    zIndex: 2,
    backgroundColor: theme.colors.surface1,
    borderRightWidth: theme.borderWidth[1],
    borderRightColor: theme.colors.border,
  },
  headerCell: {
    height: 36,
    flexDirection: "row",
    alignItems: "center",
    textAlign: "left",
    borderRightWidth: theme.borderWidth[1],
    borderRightColor: theme.colors.border,
  },
  sortTarget: {
    flex: 1,
    minWidth: 0,
    height: 36,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    paddingHorizontal: theme.spacing[3],
  },
  headerText: {
    flex: 1,
    flexShrink: 1,
    color: theme.colors.foreground,
    fontFamily: theme.fontFamily.mono,
    fontSize: theme.fontSize.code,
    fontWeight: theme.fontWeight.medium,
    textAlign: "left",
  },
  numericHeaderText: {
    textAlign: "right",
  },
  filterTrigger: {
    width: 28,
    height: 28,
    alignItems: "center",
    justifyContent: "center",
    marginRight: theme.spacing[1],
    borderRadius: theme.borderRadius.md,
  },
  hiddenTrigger: {
    opacity: 0,
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
