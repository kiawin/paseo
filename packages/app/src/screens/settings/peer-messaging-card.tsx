import React, { useCallback } from "react";
import { Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { Switch } from "@/components/ui/switch";
import { useDaemonConfig } from "@/hooks/use-daemon-config";
import { useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import { settingsStyles } from "@/styles/settings";

export function PeerMessagingCards({ serverId }: { serverId: string }) {
  const { t } = useTranslation();
  const isConnected = useHostRuntimeIsConnected(serverId);
  const { config, patchConfig } = useDaemonConfig(serverId);

  const handleEnforceReachabilityChange = useCallback(
    (next: boolean) => {
      void patchConfig({
        agents: { peerMessaging: { enforceReachability: next } },
      });
    },
    [patchConfig],
  );

  const handleCwdReachabilityChange = useCallback(
    (next: boolean) => {
      void patchConfig({
        agents: { peerMessaging: { cwdReachability: next } },
      });
    },
    [patchConfig],
  );

  if (!isConnected) return null;

  return (
    <>
      <View style={settingsStyles.card} testID="host-page-peer-messaging-enforce-card">
        <View style={settingsStyles.row}>
          <View style={settingsStyles.rowContent}>
            <Text style={settingsStyles.rowTitle}>
              {t("settings.host.orchestration.enforceReachability.title")}
            </Text>
            <Text style={settingsStyles.rowHint}>
              {t("settings.host.orchestration.enforceReachability.hint")}
            </Text>
          </View>
          <Switch
            value={config?.agents?.peerMessaging?.enforceReachability ?? false}
            onValueChange={handleEnforceReachabilityChange}
            accessibilityLabel={t(
              "settings.host.orchestration.enforceReachability.accessibilityLabel",
            )}
            testID="host-page-peer-messaging-enforce-switch"
          />
        </View>
      </View>
      <View style={settingsStyles.card} testID="host-page-peer-messaging-cwd-card">
        <View style={settingsStyles.row}>
          <View style={settingsStyles.rowContent}>
            <Text style={settingsStyles.rowTitle}>
              {t("settings.host.orchestration.cwdReachability.title")}
            </Text>
            <Text style={settingsStyles.rowHint}>
              {t("settings.host.orchestration.cwdReachability.hint")}
            </Text>
          </View>
          <Switch
            value={config?.agents?.peerMessaging?.cwdReachability ?? true}
            onValueChange={handleCwdReachabilityChange}
            accessibilityLabel={t("settings.host.orchestration.cwdReachability.accessibilityLabel")}
            testID="host-page-peer-messaging-cwd-switch"
          />
        </View>
      </View>
    </>
  );
}
