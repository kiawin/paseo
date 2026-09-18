import { Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet } from "react-native-unistyles";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { SearchField } from "@/components/ui/search-field";
import { Switch } from "@/components/ui/switch";

export function CsvToolbar({
  query,
  visibleRowCount,
  totalRowCount,
  firstRowIsHeader,
  hasActiveFilters,
  raggedCount,
  truncated,
  onQueryChange,
  onToggleHeader,
  onClear,
  onRaggedPress,
}: {
  query: string;
  visibleRowCount: number;
  totalRowCount: number;
  firstRowIsHeader: boolean;
  hasActiveFilters: boolean;
  raggedCount: number;
  truncated: boolean;
  onQueryChange: (value: string) => void;
  onToggleHeader: (value: boolean) => void;
  onClear: () => void;
  onRaggedPress: () => void;
}) {
  const { t } = useTranslation();
  return (
    <View style={styles.container} testID="csv-toolbar">
      <View style={styles.controls}>
        <SearchField
          key={query.length === 0 ? "empty" : "filled"}
          value={query}
          onChangeText={onQueryChange}
          placeholder={t("panels.file.csv.searchPlaceholder")}
          clearAccessibilityLabel={t("panels.file.csv.clearSearch")}
          accessibilityLabel={t("panels.file.csv.searchPlaceholder")}
          testID="csv-search"
          clearTestID="csv-search-clear"
        />
        <Text style={styles.count}>
          {t("panels.file.csv.rowCount", { visible: visibleRowCount, total: totalRowCount })}
        </Text>
        <View style={styles.switchRow}>
          <Text style={styles.switchLabel}>{t("panels.file.csv.firstRowHeader")}</Text>
          <Switch
            value={firstRowIsHeader}
            onValueChange={onToggleHeader}
            accessibilityLabel={t("panels.file.csv.firstRowHeader")}
            testID="csv-first-row-header"
          />
        </View>
        {query.length > 0 || hasActiveFilters ? (
          <Button variant="ghost" size="xs" onPress={onClear} testID="csv-clear-filters">
            {t("panels.file.csv.clearFilters")}
          </Button>
        ) : null}
      </View>
      {truncated ? (
        <Alert
          variant="warning"
          title={t("panels.file.csv.truncated")}
          testID="csv-truncated-banner"
        />
      ) : null}
      {raggedCount > 0 ? (
        <Alert
          variant="warning"
          title={t("panels.file.csv.raggedRows", { count: raggedCount })}
          testID="csv-ragged-banner"
        >
          <Button variant="ghost" size="xs" onPress={onRaggedPress} testID="csv-ragged-jump">
            {t("panels.file.csv.jumpToRow")}
          </Button>
        </Alert>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: {
    flexShrink: 0,
    gap: theme.spacing[1],
    padding: theme.spacing[2],
    backgroundColor: theme.colors.surface0,
    borderBottomWidth: theme.borderWidth[1],
    borderBottomColor: theme.colors.border,
  },
  controls: {
    minHeight: 32,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  count: {
    flexShrink: 0,
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  switchRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    flexShrink: 0,
  },
  switchLabel: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
}));
