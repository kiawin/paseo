import type { Command } from "commander";
import type { CommandError, CommandOptions, SingleResult } from "../../output/index.js";
import { buildDaemonConnectionCommandError, connectToDaemon } from "../../utils/client.js";

interface ProjectReviewResult {
  prUrl: string;
  agentId: string;
  workspaceId: string;
}

const projectReviewSchema = {
  idField: "agentId" as const,
  columns: [
    { header: "PR", field: "prUrl" as const, width: 50 },
    { header: "REVIEWER", field: "agentId" as const, width: 38 },
    { header: "WORKSPACE", field: "workspaceId" as const, width: 22 },
  ],
};

export function parsePrNumber(value: string): number {
  const prNumber = Number(value.replace(/^#/, ""));
  if (Number.isInteger(prNumber) && prNumber > 0) return prNumber;
  throw {
    code: "INVALID_PR_NUMBER",
    message: `Not a pull request number: ${value}`,
  } satisfies CommandError;
}

export async function runReviewCommand(
  projectId: string,
  prNumberArg: string,
  options: CommandOptions & { provider?: string },
  _command: Command,
): Promise<SingleResult<ProjectReviewResult>> {
  const prNumber = parsePrNumber(prNumberArg);
  const client = await connectToDaemon({ target: options.daemonTarget }).catch((error: unknown) => {
    throw buildDaemonConnectionCommandError({ target: options.daemonTarget, error });
  });

  try {
    // COMPAT(prAutoFix): added in v0.12.x, remove gate after 2028-10-17.
    if (client.getLastServerInfoMessage()?.features?.prAutoFix !== true) {
      throw {
        code: "DAEMON_UPDATE_REQUIRED",
        message: "Update the host to review pull requests.",
      } satisfies CommandError;
    }
    const review = await client.startPrReview({
      projectId,
      prNumber,
      ...(options.provider ? { provider: options.provider } : {}),
    });
    return {
      type: "single",
      data: {
        prUrl: review.prUrl,
        agentId: review.agentId,
        workspaceId: review.workspaceId ?? "-",
      },
      schema: projectReviewSchema,
    };
  } catch (error) {
    if (error && typeof error === "object" && "code" in error) throw error;
    const message = error instanceof Error ? error.message : String(error);
    throw { code: "PROJECT_REVIEW_FAILED", message } satisfies CommandError;
  } finally {
    await client.close().catch(() => undefined);
  }
}
