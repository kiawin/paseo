import { useCallback, useState, type ReactElement, type ReactNode } from "react";
import { Pressable, Text, View, type PressableStateCallbackType } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { StatusBadge } from "@/components/ui/status-badge";
import { useIsCompactFormFactor } from "@/constants/layout";
import type { PullRequestBadge } from "@/pull-requests/pull-request-rows";
import { settingsStyles } from "@/styles/settings";

export interface PullRequestRowFrameProps {
  testID: string;
  isFirst: boolean;
  title: string;
  meta: string;
  badges: readonly PullRequestBadge[];
  /** Hint line under the badges, such as an auto-fix pause reason. */
  note?: string | null;
  error?: string | null;
  errorTestID?: string;
  accessibilityLabel: string;
  /** Pressing anywhere on the row that the trailing controls do not claim. */
  onPress: () => void;
  trailing: ReactNode;
}

/**
 * The shared shape of a pull request row: a press target across the whole card with the
 * text on the left and controls on the right. Both the in-progress and review-requested
 * lists render through it, so pressing a row and hovering it behave the same everywhere.
 *
 * Hover lives on the outer plain View (docs/hover.md). Trailing controls are nested
 * Pressables, so they take the press before the row does.
 */
export function PullRequestRowFrame({
  testID,
  isFirst,
  title,
  meta,
  badges,
  note = null,
  error = null,
  errorTestID,
  accessibilityLabel,
  onPress,
  trailing,
}: PullRequestRowFrameProps): ReactElement {
  const isCompact = useIsCompactFormFactor();
  const [isHovered, setIsHovered] = useState(false);
  const handlePointerEnter = useCallback(() => setIsHovered(true), []);
  const handlePointerLeave = useCallback(() => setIsHovered(false), []);

  const rowStyle = useCallback(
    ({ pressed }: PressableStateCallbackType) => [
      settingsStyles.row,
      styles.row,
      !isFirst && settingsStyles.rowBorder,
      isHovered && !isCompact && styles.rowHovered,
      pressed && styles.rowPressed,
    ],
    [isFirst, isHovered, isCompact],
  );

  return (
    <View
      style={styles.rowContainer}
      onPointerEnter={handlePointerEnter}
      onPointerLeave={handlePointerLeave}
    >
      <Pressable
        style={rowStyle}
        onPress={onPress}
        accessibilityRole="button"
        accessibilityLabel={accessibilityLabel}
        testID={testID}
      >
        <View style={styles.textGroup}>
          <Text style={settingsStyles.rowTitle} numberOfLines={1}>
            {title}
          </Text>
          <Text style={settingsStyles.rowHint} numberOfLines={1}>
            {meta}
          </Text>
          {badges.length > 0 ? (
            <View style={styles.badges}>
              {badges.map((badge) => (
                <StatusBadge
                  key={badge.label}
                  label={badge.label}
                  variant={badge.variant}
                  size="xs"
                />
              ))}
            </View>
          ) : null}
          {note ? <Text style={settingsStyles.rowHint}>{note}</Text> : null}
          {error ? (
            <Text style={settingsStyles.rowError} testID={errorTestID}>
              {error}
            </Text>
          ) : null}
        </View>

        <View style={styles.trailing}>{trailing}</View>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  rowContainer: {
    position: "relative",
  },
  row: {
    gap: theme.spacing[3],
  },
  rowHovered: {
    backgroundColor: theme.colors.surface2,
  },
  rowPressed: {
    backgroundColor: theme.colors.surface3,
  },
  textGroup: {
    flex: 1,
    minWidth: 0,
  },
  badges: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: theme.spacing[1],
    marginTop: theme.spacing[2],
  },
  trailing: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
}));
