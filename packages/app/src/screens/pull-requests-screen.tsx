import { useCallback, type ReactElement } from "react";
import { ScrollView, Text, View } from "react-native";
import { useIsFocused } from "@react-navigation/native";
import { StyleSheet } from "react-native-unistyles";
import { MenuHeader } from "@/components/headers/menu-header";
import { SettingsSection } from "@/components/settings/headings/settings-section";
import { PullRequestRow } from "@/components/pull-requests/pull-request-row";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { usePullRequests, type PullRequestListRow } from "@/hooks/use-pull-requests";
import type { PrWatchHostError } from "@/pull-requests/aggregated-pr-watches";
import { navigateToWorkspace } from "@/stores/navigation-active-workspace-store";
import { settingsStyles } from "@/styles/settings";

export function PullRequestsScreen(): ReactElement {
  const isFocused = useIsFocused();

  if (!isFocused) {
    return <View style={styles.container} />;
  }

  return <PullRequestsScreenContent />;
}

function PullRequestsScreenContent(): ReactElement {
  const { bodyState, sections, hostErrors, showHostLabel, setAutoFix } = usePullRequests();

  const handleOpen = useCallback((row: PullRequestListRow) => {
    navigateToWorkspace({ serverId: row.serverId, workspaceId: row.workspaceId });
  }, []);

  let body: ReactElement;
  if (bodyState === "loading") {
    body = (
      <View style={styles.centered}>
        <LoadingSpinner size="large" color={styles.spinner.color} />
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
        {hostErrors.length > 0 ? <HostErrorsBanner errors={hostErrors} /> : null}
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

function HostErrorsBanner({ errors }: { errors: PrWatchHostError[] }): ReactElement {
  return (
    <View style={styles.errorsBanner} testID="pull-requests-host-errors">
      {errors.map((error) => (
        <Text key={error.serverId} style={styles.errorsBannerText}>
          {`${error.serverName}: Could not load auto-fix state`}
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
  // Static color holder read by the spinner; keeps the muted token without useUnistyles.
  spinner: {
    color: theme.colors.foregroundMuted,
  },
}));
