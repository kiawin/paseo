import { CircleDot } from "lucide-react-native";
import { withUnistyles } from "react-native-unistyles";
import { RecordingsPane } from "@/desktop/browser/recordings/pane";
import { usePaneContext } from "@/panels/pane-context";
import { definePanel, type PanelPresentation } from "@/panels/panel-registry";

const Icon = withUnistyles(CircleDot);
const presentation = {
  label: (t) => t("panels.recordings.label"),
  subtitle: (t) => t("panels.recordings.subtitle"),
  tooltip: (t) => t("panels.recordings.label"),
  icon: Icon,
} satisfies PanelPresentation;
function RecordingsPanel() {
  const { workspaceId } = usePaneContext();
  return <RecordingsPane workspaceId={workspaceId} />;
}
export const recordingsPanelRegistration = definePanel("recordings", {
  component: RecordingsPanel,
  presentation,
});
