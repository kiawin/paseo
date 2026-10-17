import { useCallback, useMemo, useState, type ReactElement } from "react";
import { PickerAnchor, PullRequestKebab } from "@/components/pull-requests/pull-request-row";
import { PullRequestRowFrame } from "@/components/pull-requests/pull-request-row-frame";
import { Button } from "@/components/ui/button";
import { MenuItem, MenuLabel, MenuRoot, MenuSurface } from "@/components/ui/menu";
import type { StartReviewInput } from "@/hooks/use-review-requests";
import {
  buildReviewRequestMeta,
  describeReviewRequestBadges,
  type ReviewRequestRow as ReviewRequestRowModel,
  type ReviewRequestTarget,
} from "@/pull-requests/review-request-rows";
import { toErrorMessage } from "@/utils/error-messages";
import { useOpenForgeLink } from "@/utils/use-link-behavior";
import { buildWorkspaceTabPersistenceKey } from "@/workspace-tabs/model";

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
 *
 * Pressing the row opens the reviewer's workspace like an in-progress row opens its own.
 * Before a reviewer exists it opens the pull request instead: a stray tap must not start
 * an agent, so starting one stays on the Review button.
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
  const workspaceKey = activeReview
    ? buildWorkspaceTabPersistenceKey({
        serverId: activeReview.target.serverId,
        workspaceId: activeReview.workspaceId,
      })
    : null;
  const openForgeLink = useOpenForgeLink(workspaceKey);

  const handleOpen = useCallback(() => {
    if (activeReview) {
      onOpenWorkspace({
        serverId: activeReview.target.serverId,
        workspaceId: activeReview.workspaceId,
      });
    }
  }, [activeReview, onOpenWorkspace]);

  const handleRowPress = useCallback(() => {
    if (activeReview) {
      handleOpen();
      return;
    }
    openForgeLink(row.url);
  }, [activeReview, handleOpen, openForgeLink, row.url]);

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
    <PullRequestRowFrame
      testID={`review-request-row-${row.key}`}
      isFirst={isFirst}
      title={row.title}
      meta={buildReviewRequestMeta(row, showHostLabel)}
      badges={describeReviewRequestBadges(row)}
      error={error}
      errorTestID={`review-request-error-${row.key}`}
      accessibilityLabel={
        activeReview ? `Open review of ${row.title}` : `Open pull request ${row.title}`
      }
      onPress={handleRowPress}
      trailing={
        <>
          {action}
          <PullRequestKebab row={linkTarget} workspaceKey={workspaceKey} />
        </>
      }
    />
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
