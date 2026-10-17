import { useCallback, useMemo, useState, type ReactElement } from "react";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { PullRequestKebab } from "@/components/pull-requests/pull-request-row";
import { Button } from "@/components/ui/button";
import { StatusBadge } from "@/components/ui/status-badge";
import type { StartReviewInput } from "@/hooks/use-review-requests";
import {
  buildReviewRequestMeta,
  describeReviewRequestBadges,
  type ReviewRequestRow as ReviewRequestRowModel,
} from "@/pull-requests/review-request-rows";
import { settingsStyles } from "@/styles/settings";
import { toErrorMessage } from "@/utils/error-messages";

interface ReviewRequestRowProps {
  row: ReviewRequestRowModel;
  isFirst: boolean;
  showHostLabel: boolean;
  onOpenWorkspace: (input: { serverId: string; workspaceId: string }) => void;
  onStartReview: (input: StartReviewInput) => Promise<string | null>;
}

/**
 * A pull request waiting on your review: title, number, author, and project, with
 * Fork and Draft pills, a trailing action, and a kebab that opens it on GitHub. The
 * action opens the reviewer's workspace, or starts a reviewer and then opens it.
 */
export function ReviewRequestRow({
  row,
  isFirst,
  showHostLabel,
  onOpenWorkspace,
  onStartReview,
}: ReviewRequestRowProps): ReactElement {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { action } = row;

  const handleOpen = useCallback(() => {
    if (action.kind === "open") {
      onOpenWorkspace({ serverId: row.serverId, workspaceId: action.workspaceId });
    }
  }, [action, onOpenWorkspace, row.serverId]);

  const startReview = useCallback(async () => {
    setPending(true);
    setError(null);
    try {
      const workspaceId = await onStartReview({
        serverId: row.serverId,
        projectId: row.projectId,
        prNumber: row.number,
      });
      if (workspaceId !== null) onOpenWorkspace({ serverId: row.serverId, workspaceId });
    } catch (cause) {
      setError(toErrorMessage(cause));
    } finally {
      setPending(false);
    }
  }, [onOpenWorkspace, onStartReview, row.number, row.projectId, row.serverId]);
  const handleReview = useCallback(() => {
    void startReview();
  }, [startReview]);

  const badges = describeReviewRequestBadges(row);
  const linkTarget = useMemo(
    () => ({ key: row.key, forge: "github", url: row.url }),
    [row.key, row.url],
  );

  return (
    <View
      style={[settingsStyles.row, styles.row, !isFirst && settingsStyles.rowBorder]}
      testID={`review-request-row-${row.key}`}
    >
      <View style={styles.textGroup}>
        <Text style={settingsStyles.rowTitle} numberOfLines={1}>
          {row.title}
        </Text>
        <Text style={settingsStyles.rowHint} numberOfLines={1}>
          {buildReviewRequestMeta(row, showHostLabel)}
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
        {error ? (
          <Text style={settingsStyles.rowError} testID={`review-request-error-${row.key}`}>
            {error}
          </Text>
        ) : null}
      </View>

      <View style={styles.trailing}>
        {action.kind === "open" ? (
          <Button
            variant="outline"
            size="sm"
            onPress={handleOpen}
            testID={`review-request-open-${row.key}`}
          >
            Open review
          </Button>
        ) : (
          <Button
            variant="outline"
            size="sm"
            onPress={handleReview}
            disabled={pending}
            loading={pending}
            testID={`review-request-start-${row.key}`}
          >
            {pending ? "Starting..." : "Review"}
          </Button>
        )}
        <PullRequestKebab row={linkTarget} />
      </View>
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
