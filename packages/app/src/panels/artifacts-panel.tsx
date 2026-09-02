import { useCallback } from "react";
import { FileCode2 } from "lucide-react-native";
import { withUnistyles } from "react-native-unistyles";
import invariant from "tiny-invariant";

import { ArtifactsPane } from "@/artifacts/pane";
import { usePaneContext } from "@/panels/pane-context";
import { definePanel, type PanelPresentation } from "@/panels/panel-registry";

const ThemedFileCode = withUnistyles(FileCode2);

export const artifactsPanelPresentation = {
  label: (t) => t("panels.artifacts.label"),
  subtitle: (t) => t("panels.artifacts.subtitle"),
  tooltip: (t) => t("panels.artifacts.tooltip"),
  icon: ThemedFileCode,
} satisfies PanelPresentation;

function ArtifactsPanel() {
  const { serverId, workspaceId, target, openPreferredTarget } = usePaneContext();
  invariant(target.kind === "artifacts", "ArtifactsPanel requires artifacts target");
  const onOpenArtifact = useCallback(
    (artifactId: string) => openPreferredTarget({ kind: "artifact", artifactId }, "explorerFiles"),
    [openPreferredTarget],
  );
  return (
    <ArtifactsPane serverId={serverId} workspaceId={workspaceId} onOpenArtifact={onOpenArtifact} />
  );
}

export const artifactsPanelRegistration = definePanel("artifacts", {
  component: ArtifactsPanel,
  presentation: artifactsPanelPresentation,
});
