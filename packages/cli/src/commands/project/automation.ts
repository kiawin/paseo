import type { Command } from "commander";
import type { ProjectPrAutomation } from "@getpaseo/protocol/messages";
import type { CommandError, CommandOptions, SingleResult } from "../../output/index.js";
import { buildDaemonConnectionCommandError, connectToDaemon } from "../../utils/client.js";

interface ProjectAutomationResult {
  projectId: string;
  autoReview: string;
  reviewer: string;
  reReview: string;
  postReviews: string;
  autoFixAgentPrs: string;
}

const projectAutomationSchema = {
  idField: "projectId" as const,
  columns: [
    { header: "PROJECT ID", field: "projectId" as const, width: 20 },
    { header: "AUTO-REVIEW", field: "autoReview" as const, width: 12 },
    { header: "REVIEWER", field: "reviewer" as const, width: 20 },
    { header: "RE-REVIEW", field: "reReview" as const, width: 10 },
    { header: "POST REVIEWS", field: "postReviews" as const, width: 13 },
    { header: "AUTO-FIX AGENT PRS", field: "autoFixAgentPrs" as const, width: 18 },
  ],
};

const DEFAULT_AUTOMATION: ProjectPrAutomation = {
  autoReview: false,
  reviewProvider: null,
  postReviews: false,
  autoFixAgentPullRequests: false,
};

export function parseOnOff(value: string, usage: string): boolean {
  if (value === "on") return true;
  if (value === "off") return false;
  throw {
    code: "INVALID_ACTION",
    message: `Expected on or off, got: ${value}`,
    details: usage,
  } satisfies CommandError;
}

export function parseReReview(value: string): "request" | "push" {
  if (value === "request" || value === "push") return value;
  throw {
    code: "INVALID_OPTIONS",
    message: `--rereview takes request or push, got: ${value}`,
  } satisfies CommandError;
}

export function applyAutoReviewChange(
  current: ProjectPrAutomation,
  change: {
    enabled: boolean;
    provider?: string;
    profile?: string;
    postReviews?: boolean;
    reReviewOn?: string;
  },
): ProjectPrAutomation {
  if (change.provider?.trim() && change.profile?.trim()) {
    throw {
      code: "INVALID_OPTIONS",
      message: "--provider and --profile both choose the reviewer; pass one",
    } satisfies CommandError;
  }
  return {
    ...current,
    autoReview: change.enabled,
    reviewProvider: change.provider?.trim() || current.reviewProvider,
    // A provider replaces the profile; a profile (by name or id) wins over the provider.
    ...(change.provider?.trim() ? { reviewProfileId: null } : {}),
    ...(change.profile?.trim() ? { reviewProfileId: change.profile.trim() } : {}),
    postReviews: change.postReviews ?? current.postReviews,
    ...(change.reReviewOn !== undefined ? { reReviewOn: parseReReview(change.reReviewOn) } : {}),
  };
}

function toResult(projectId: string, settings: ProjectPrAutomation): ProjectAutomationResult {
  const onOff = (value: boolean) => (value ? "on" : "off");
  return {
    projectId,
    autoReview: onOff(settings.autoReview),
    reviewer: settings.reviewProfileId
      ? `profile ${settings.reviewProfileId}`
      : (settings.reviewProvider ?? "-"),
    reReview: settings.reReviewOn ?? "request",
    postReviews: onOff(settings.postReviews),
    autoFixAgentPrs: onOff(settings.autoFixAgentPullRequests),
  };
}

async function updateProjectAutomation(
  projectId: string,
  options: CommandOptions,
  update: (current: ProjectPrAutomation) => ProjectPrAutomation,
): Promise<SingleResult<ProjectAutomationResult>> {
  const client = await connectToDaemon({ target: options.daemonTarget }).catch((error: unknown) => {
    throw buildDaemonConnectionCommandError({ target: options.daemonTarget, error });
  });

  try {
    // COMPAT(prAutoFix): added in v0.12.x, remove gate after 2028-10-17.
    if (client.getLastServerInfoMessage()?.features?.prAutoFix !== true) {
      throw {
        code: "DAEMON_UPDATE_REQUIRED",
        message: "Update the host to use pull request automation.",
      } satisfies CommandError;
    }
    const { projects } = await client.listProjects();
    const project = projects.find((entry) => entry.projectId === projectId);
    if (!project) {
      throw {
        code: "PROJECT_NOT_FOUND",
        message: `Project not found: ${projectId}`,
      } satisfies CommandError;
    }
    const applied = await client.setProjectPrAutomation(
      projectId,
      update(project.projectPrAutomation ?? DEFAULT_AUTOMATION),
    );
    return { type: "single", data: toResult(projectId, applied), schema: projectAutomationSchema };
  } catch (error) {
    if (error && typeof error === "object" && "code" in error) throw error;
    const message = error instanceof Error ? error.message : String(error);
    throw { code: "PROJECT_AUTOMATION_FAILED", message } satisfies CommandError;
  } finally {
    await client.close().catch(() => undefined);
  }
}

export function runAutoReviewCommand(
  projectId: string,
  stateArg: string,
  options: CommandOptions & {
    provider?: string;
    profile?: string;
    postReviews?: boolean;
    rereview?: string;
  },
  _command: Command,
): Promise<SingleResult<ProjectAutomationResult>> {
  const enabled = parseOnOff(
    stateArg,
    "Usage: paseo project autoreview <project-id> <on|off> [--provider <provider>]",
  );
  return updateProjectAutomation(projectId, options, (current) =>
    applyAutoReviewChange(current, {
      enabled,
      ...(options.provider !== undefined ? { provider: options.provider } : {}),
      ...(options.profile !== undefined ? { profile: options.profile } : {}),
      ...(options.postReviews !== undefined ? { postReviews: options.postReviews } : {}),
      ...(options.rereview !== undefined ? { reReviewOn: options.rereview } : {}),
    }),
  );
}

export function runAutoFixAgentPrsCommand(
  projectId: string,
  stateArg: string,
  options: CommandOptions,
  _command: Command,
): Promise<SingleResult<ProjectAutomationResult>> {
  const enabled = parseOnOff(stateArg, "Usage: paseo project autofix <project-id> <on|off>");
  return updateProjectAutomation(projectId, options, (current) => ({
    ...current,
    autoFixAgentPullRequests: enabled,
  }));
}
