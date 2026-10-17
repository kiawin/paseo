import type { Command } from "commander";
import type { PrWatchPayload } from "@getpaseo/protocol/messages";
import { connectToDaemon, resolveAgentId } from "../../utils/client.js";
import type {
  CommandError,
  CommandOptions,
  OutputSchema,
  SingleResult,
} from "../../output/index.js";

type AutofixAction = "on" | "off" | "status";

interface AgentAutofixResult {
  agentId: string;
  state: string;
  pr: string;
  attempts: string;
}

const autofixSchema: OutputSchema<AgentAutofixResult> = {
  idField: "agentId",
  columns: [
    { header: "AGENT ID", field: "agentId" },
    { header: "STATE", field: "state" },
    { header: "PR", field: "pr" },
    { header: "ATTEMPTS", field: "attempts" },
  ],
};

export function parseAutofixAction(value: string | undefined): AutofixAction {
  const action = value ?? "status";
  if (action === "on" || action === "off" || action === "status") return action;
  throw {
    code: "INVALID_ACTION",
    message: `Unknown action: ${action}`,
    details: "Usage: paseo agent autofix <agent-id> [on|off|status]",
  } satisfies CommandError;
}

export function toAutofixResult(agentId: string, watch: PrWatchPayload | null): AgentAutofixResult {
  if (!watch) return { agentId, state: "off", pr: "-", attempts: "-" };
  const state =
    watch.state.kind === "active" ? "on" : `${watch.state.kind} (${watch.state.reason})`;
  return {
    agentId,
    state,
    pr: watch.prUrl ?? (watch.prNumber !== null ? `#${watch.prNumber}` : "-"),
    attempts: `${watch.attemptsForHead}/${watch.maxAttemptsPerHead}`,
  };
}

export async function runAutofixCommand(
  agentIdArg: string,
  actionArg: string | undefined,
  options: CommandOptions,
  _command: Command,
): Promise<SingleResult<AgentAutofixResult>> {
  const action = parseAutofixAction(actionArg);
  const client = await connectToDaemon({ target: options.daemonTarget });

  try {
    // COMPAT(prAutoFix): added in v0.12.x, remove gate after 2028-10-17.
    if (client.getLastServerInfoMessage()?.features?.prAutoFix !== true) {
      throw {
        code: "DAEMON_UPDATE_REQUIRED",
        message: "Update the host to use PR auto-fix.",
      } satisfies CommandError;
    }
    const payload = await client.fetchAgents({ filter: { includeArchived: true } });
    const agentId = resolveAgentId(
      agentIdArg,
      payload.entries.map((entry) => entry.agent),
    );
    if (!agentId) {
      throw {
        code: "AGENT_NOT_FOUND",
        message: `Agent not found: ${agentIdArg}`,
      } satisfies CommandError;
    }
    const watch = await applyAutofixAction(client, agentId, action);
    return { type: "single", data: toAutofixResult(agentId, watch), schema: autofixSchema };
  } catch (error) {
    if (error && typeof error === "object" && "code" in error) throw error;
    const message = error instanceof Error ? error.message : String(error);
    throw { code: "AUTOFIX_FAILED", message } satisfies CommandError;
  } finally {
    await client.close().catch(() => undefined);
  }
}

async function applyAutofixAction(
  client: Awaited<ReturnType<typeof connectToDaemon>>,
  agentId: string,
  action: AutofixAction,
): Promise<PrWatchPayload | null> {
  if (action === "status") return (await client.listAgentPrWatches(agentId))[0] ?? null;
  return client.setAgentPrWatch(agentId, action === "on");
}
