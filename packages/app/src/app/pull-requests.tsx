import { HostRouteBootstrapBoundary } from "@/components/host-route-bootstrap-boundary";
import { PullRequestsScreen } from "@/screens/pull-requests-screen";

export default function PullRequestsRoute() {
  return (
    <HostRouteBootstrapBoundary>
      <PullRequestsScreen />
    </HostRouteBootstrapBoundary>
  );
}
