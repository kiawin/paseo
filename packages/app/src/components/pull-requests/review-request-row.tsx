import { useCallback, useMemo, useState, type ReactElement } from "react";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { PickerAnchor, PullRequestKebab } from "@/components/pull-requests/pull-request-row";
import { Button } from "@/components/ui/button";
import { MenuItem, MenuLabel, MenuRoot, MenuSurface } from "@/components/ui/menu";
import { StatusBadge } from "@/components/ui/status-badge";
import type { StartReviewInput } from "@/hooks/use-review-requests";
import {
  buildReviewRequestMeta,
  describeReviewRequestBadges,
  type ReviewRequestRow as ReviewRequestRowModel,
  type ReviewRequestTarget,
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
 * action opens the reviewer's workspace, or starts a reviewer and then opens it. When
 * several hosts have the project, Review first asks which host runs the reviewer.
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
  const { activeReview } = row;

  const handleOpen = useCallback(() => {
    if (activeReview) {
      onOpenWorkspace({
        serverId: activeReview.target.serverId,
        workspaceId: activeReview.workspaceId,
      });
    }
  }, [activeReview, onOpenWorkspace]);

  const startReview = useCallback(
    async (target: ReviewRequestTarget) => {
      setPending(true);
      setError(null);
      try {
        const workspaceId = await onStartReview({
          serverId: target.serverId,
          projectId: target.projectId,
          prNumber: row.number,
        });
        if (workspaceId !== null) onOpenWorkspace({ serverId: target.serverId, workspaceId });
      } catch (cause) {
        setError(toErrorMessage(cause));
      } finally {
        setPending(false);
      }
    },
    [onOpenWorkspace, onStartReview, row.number],
  );
  const handleChooseTarget = useCallback(
    (target: ReviewRequestTarget) => {
      void startReview(target);
    },
    [startReview],
  );

  const badges = describeReviewRequestBadges(row);
  const linkTarget = useMemo(
    () => ({ key: row.key, forge: "github", url: row.url }),
    [row.key, row.url],
  );

  let action: ReactElement;
  if (activeReview) {
    action = (
      <Button
        variant="outline"
        size="sm"
        onPress={handleOpen}
        testID={`review-request-open-${row.key}`}
      >
        Open review
      </Button>
    );
  } else if (row.targets.length > 1) {
    action = (
      <ReviewHostPicker
        rowKey={row.key}
        targets={row.targets}
        pending={pending}
        onChoose={handleChooseTarget}
      />
    );
  } else {
    action = (
      <ReviewButton
        rowKey={row.key}
        target={row.targets[0]}
        pending={pending}
        onPress={handleChooseTarget}
      />
    );
  }

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
        {action}
        <PullRequestKebab row={linkTarget} />
      </View>
    </View>
  );
}

function ReviewButton({
  rowKey,
  target,
  pending,
  onPress,
}: {
  rowKey: string;
  target: ReviewRequestTarget | undefined;
  pending: boolean;
  onPress: (target: ReviewRequestTarget) => void;
}): ReactElement {
  const handlePress = useCallback(() => {
    if (target) onPress(target);
  }, [onPress, target]);
  return (
    <Button
      variant="outline"
      size="sm"
      onPress={handlePress}
      disabled={pending || !target}
      loading={pending}
      testID={`review-request-start-${rowKey}`}
    >
      {pending ? "Starting..." : "Review"}
    </Button>
  );
}

/**
 * Several hosts have the project and none is reviewing: Review opens a menu to choose
 * the host that runs the reviewer, so only one host reviews the pull request.
 */
function ReviewHostPicker({
  rowKey,
  targets,
  pending,
  onChoose,
}: {
  rowKey: string;
  targets: readonly ReviewRequestTarget[];
  pending: boolean;
  onChoose: (target: ReviewRequestTarget) => void;
}): ReactElement {
  const [open, setOpen] = useState(false);
  const openPicker = useCallback(() => setOpen(true), []);
  return (
    <MenuRoot open={open} onOpenChange={setOpen} compactMode="sheet">
      <PickerAnchor>
        <Button
          variant="outline"
          size="sm"
          onPress={openPicker}
          disabled={pending}
          loading={pending}
          testID={`review-request-start-${rowKey}`}
        >
          {pending ? "Starting..." : "Review"}
        </Button>
      </PickerAnchor>
      <MenuSurface align="end" width={260} sheetTitle="Review pull request">
        <MenuLabel>Choose the host that reviews this pull request</MenuLabel>
        {targets.map((target) => (
          <ReviewHostItem
            key={`${target.serverId}:${target.projectId}`}
            target={target}
            onChoose={onChoose}
          />
        ))}
      </MenuSurface>
    </MenuRoot>
  );
}

function ReviewHostItem({
  target,
  onChoose,
}: {
  target: ReviewRequestTarget;
  onChoose: (target: ReviewRequestTarget) => void;
}): ReactElement {
  const handleSelect = useCallback(() => onChoose(target), [onChoose, target]);
  return (
    <MenuItem
      description={target.projectName ?? undefined}
      onSelect={handleSelect}
      testID={`review-request-host-${target.serverId}:${target.projectId}`}
    >
      {target.serverName}
    </MenuItem>
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
