import { useMemo, type ReactElement } from "react";
import { View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { SkeletonPulse, useSkeletonPulse } from "@/git/pull-request-panel/activity-skeleton";
import { settingsStyles } from "@/styles/settings";

/**
 * Placeholder pull request rows, shaped like `PullRequestRowFrame`: title and meta lines on
 * the left, a trailing control on the right. Shown while a list is still on its way.
 */
export function PullRequestRowsSkeleton({
  count,
  testID,
}: {
  count: number;
  testID?: string;
}): ReactElement {
  const pulse = useSkeletonPulse();
  const keys = useMemo(
    () => Array.from({ length: count }, (_, index) => `pull-request-skeleton-${index}`),
    [count],
  );
  return (
    <View style={settingsStyles.card} testID={testID}>
      {keys.map((key, index) => (
        <View
          key={key}
          style={[settingsStyles.row, styles.row, index > 0 && settingsStyles.rowBorder]}
        >
          <View style={styles.textGroup}>
            <SkeletonPulse pulse={pulse} style={styles.title} />
            <SkeletonPulse pulse={pulse} style={styles.meta} />
          </View>
          <SkeletonPulse pulse={pulse} style={styles.trailing} />
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  row: {
    gap: theme.spacing[3],
  },
  textGroup: {
    flex: 1,
    minWidth: 0,
    gap: theme.spacing[2],
  },
  title: {
    width: "70%",
    height: 14,
    borderRadius: theme.borderRadius.sm,
    backgroundColor: theme.colors.surface2,
  },
  meta: {
    width: "40%",
    height: 12,
    borderRadius: theme.borderRadius.sm,
    backgroundColor: theme.colors.surface2,
  },
  trailing: {
    width: 72,
    height: 24,
    borderRadius: theme.borderRadius.md,
    backgroundColor: theme.colors.surface2,
  },
}));
