import { useCallback, useMemo, type ReactElement } from "react";
import { ScrollView, Text, View } from "react-native";
import { useIsFocused } from "expo-router/react-navigation";
import { StyleSheet } from "react-native-unistyles";
import { MenuHeader } from "@/components/headers/menu-header";
import { SettingsSection } from "@/components/settings/headings/settings-section";
import { PullRequestRow } from "@/components/pull-requests/pull-request-row";
import { PullRequestRowsSkeleton } from "@/components/pull-requests/pull-request-rows-skeleton";
import { ReviewRequestRow } from "@/components/pull-requests/review-request-row";
import {
  usePullRequests,
  type PullRequestListRow,
  type PullRequestsBodyState,
} from "@/hooks/use-pull-requests";
import { useReviewRequests } from "@/hooks/use-review-requests";
import type {
  ReviewRequestErrorLine,
  ReviewRequestRow as ReviewRequestRowModel,
} from "@/pull-requests/review-request-rows";
import { navigateToWorkspace } from "@/stores/navigation-active-workspace-store";
import { settingsStyles } from "@/styles/settings";

export function PullRequestsScreen(): ReactElement {
  const isFocused = useIsFocused();

  if (!isFocused) {
    return <View style={styles.container} />;
  }

  return <PullRequestsScreenContent />;
}

const NO_REVIEW_ROWS: readonly ReviewRequestRowModel[] = [];
const NO_ERROR_LINES: readonly ReviewRequestErrorLine[] = [];

function PullRequestsScreenContent(): ReactElement {
  const {
    bodyState: pullRequestsState,
    sections,
    hostErrors,
    showHostLabel,
    setAutoFix,
  } = usePullRequests();
  const { state: reviewState, startReview } = useReviewRequests();

  const handleOpen = useCallback((row: PullRequestListRow) => {
    navigateToWorkspace({ serverId: row.serverId, workspaceId: row.workspaceId });
  }, []);
  const handleOpenWorkspace = useCallback(
    (input: { serverId: string; workspaceId: string }) => navigateToWorkspace(input),
    [],
  );

  const reviewRows = reviewState.status === "loaded" ? reviewState.rows : NO_REVIEW_ROWS;
  const reviewErrors = reviewState.status === "loaded" ? reviewState.errors : NO_ERROR_LINES;
  const errorLines = useMemo<ReviewRequestErrorLine[]>(
    () => [
      ...hostErrors.map((error) => ({
        key: `pr-watches:${error.serverId}`,
        text: `${error.serverName}: Could not load auto-fix state`,
      })),
      ...reviewErrors,
    ],
    [hostErrors, reviewErrors],
  );

  // Your own PRs come from workspace descriptors already in memory; review requests
  // need a round trip to GitHub. Either one with content shows the list, and the empty
  // state waits until both have answered.
  let bodyState: PullRequestsBodyState = "empty";
  if (pullRequestsState === "content" || reviewRows.length > 0 || errorLines.length > 0) {
    bodyState = "content";
  } else if (pullRequestsState === "loading" || reviewState.status === "loading") {
    bodyState = "loading";
  }

  let body: ReactElement;
  if (bodyState === "loading") {
    body = (
      <View style={styles.scrollContent} testID="pull-requests-loading">
        <PullRequestRowsSkeleton count={3} />
      </View>
    );
  } else if (bodyState === "empty") {
    body = (
      <View style={styles.centered} testID="pull-requests-empty">
        <Text style={styles.message}>No open pull requests</Text>
      </View>
    );
  } else {
    body = (
      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.scrollContent}
        showsVerticalScrollIndicator={false}
        testID="pull-requests-list"
      >
        {errorLines.length > 0 ? <ErrorsBanner lines={errorLines} /> : null}
        {sections.map((section) => (
          <SettingsSection
            key={section.id}
            title={section.title}
            testID={`pull-requests-section-${section.id}`}
          >
            <View style={settingsStyles.card}>
              {section.rows.map((row, index) => (
                <PullRequestRow
                  key={row.key}
                  row={row}
                  isFirst={index === 0}
                  showHostLabel={showHostLabel}
                  onOpen={handleOpen}
                  onSetAutoFix={setAutoFix}
                />
              ))}
            </View>
          </SettingsSection>
        ))}
        {reviewState.status === "loading" ? (
          <SettingsSection title="Review requested" testID="pull-requests-section-review-requested">
            <PullRequestRowsSkeleton count={2} testID="pull-requests-review-requested-loading" />
          </SettingsSection>
        ) : null}
        {reviewRows.length > 0 ? (
          <SettingsSection title="Review requested" testID="pull-requests-section-review-requested">
            <View style={settingsStyles.card}>
              {reviewRows.map((row, index) => (
                <ReviewRequestRow
                  key={row.key}
                  row={row}
                  isFirst={index === 0}
                  showHostLabel={showHostLabel}
                  onOpenWorkspace={handleOpenWorkspace}
                  onStartReview={startReview}
                />
              ))}
            </View>
          </SettingsSection>
        ) : null}
      </ScrollView>
    );
  }

  return (
    <View style={styles.container}>
      <MenuHeader title="Pull requests" />
      {body}
    </View>
  );
}

function ErrorsBanner({ lines }: { lines: readonly ReviewRequestErrorLine[] }): ReactElement {
  return (
    <View style={styles.errorsBanner} testID="pull-requests-host-errors">
      {lines.map((line) => (
        <Text key={line.key} style={styles.errorsBannerText}>
          {line.text}
        </Text>
      ))}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: {
    flex: 1,
    backgroundColor: theme.colors.surface0,
  },
  centered: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    padding: theme.spacing[6],
  },
  scroll: {
    flex: 1,
    minHeight: 0,
  },
  scrollContent: {
    flexGrow: 1,
    gap: theme.spacing[3],
    paddingTop: theme.spacing[4],
    paddingBottom: theme.spacing[6],
    paddingHorizontal: { xs: theme.spacing[3], md: theme.spacing[6] },
  },
  errorsBanner: {
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.lg,
    padding: theme.spacing[3],
    gap: theme.spacing[1],
  },
  errorsBannerText: {
    color: theme.colors.palette.red[300],
    fontSize: theme.fontSize.xs,
  },
  message: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.base,
    textAlign: "center",
  },
}));
