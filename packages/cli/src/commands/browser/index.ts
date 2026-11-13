import { Command } from "commander";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type {
  BrowserAutomationCommand,
  BrowserToolsResponsePayload,
} from "@getpaseo/protocol/browser-automation/rpc-schemas";
import {
  withOutput,
  type CommandError,
  type CommandOptions,
  type ListResult,
  type OutputSchema,
  type SingleResult,
} from "../../output/index.js";
import { connectToDaemon } from "../../utils/client.js";
import { resolveCallerAgentId } from "../../utils/caller-agent.js";
import { addJsonAndDaemonHostOptions } from "../../utils/command-options.js";

type BrowserToolsResult = Extract<BrowserToolsResponsePayload, { ok: true }>["result"];
type TabRow = Extract<BrowserToolsResult, { command: "list_tabs" }>["tabs"][number];
type RecordStartRow = Extract<BrowserToolsResult, { command: "record_start" }>;
type RecordStopRow = Extract<BrowserToolsResult, { command: "record_stop" }>;

interface RecordStartOptions extends CommandOptions {
  audio?: boolean;
}

const tabSchema: OutputSchema<TabRow> = {
  idField: "browserId",
  columns: [
    { header: "BROWSER ID", field: "browserId" },
    { header: "TITLE", field: "title", width: 32 },
    { header: "URL", field: "url", width: 48 },
    { header: "ACTIVE", field: "isActive" },
    { header: "HOST", field: (row) => row.browserHost.label },
  ],
};

const recordStartSchema: OutputSchema<RecordStartRow> = {
  idField: "recordingId",
  columns: [
    { header: "RECORDING ID", field: "recordingId" },
    { header: "BROWSER ID", field: "browserId" },
    { header: "AUDIO", field: "audio" },
  ],
};

const recordStopSchema: OutputSchema<RecordStopRow> = {
  idField: "recordingId",
  columns: [
    { header: "RECORDING ID", field: "recordingId" },
    { header: "STATUS", field: "status" },
    { header: "COMPLETE", field: "complete" },
    { header: "GAPS", field: (row) => row.gaps.join("; ") },
  ],
};

async function execute<TCommand extends BrowserToolsResult["command"]>(
  options: CommandOptions,
  command: BrowserAutomationCommand & { command: TCommand },
  { requireAgent }: { requireAgent: boolean },
): Promise<Extract<BrowserToolsResult, { command: TCommand }>> {
  const client: DaemonClient = await connectToDaemon({ target: options.daemonTarget });
  try {
    if (client.getLastServerInfoMessage()?.features?.browserRecording !== true) {
      throw {
        code: "UNSUPPORTED_BY_HOST",
        message: "This daemon does not support browser commands.",
        details: "Update the host to a newer Paseo version.",
      } satisfies CommandError;
    }
    const agentId = await resolveCallerAgentId(client);
    if (requireAgent && !agentId) {
      throw {
        code: "AGENT_REQUIRED",
        message: "Browser recording must run inside a Paseo agent on this host.",
      } satisfies CommandError;
    }
    const response = await client.executeBrowserTools({
      command,
      ...(agentId ? { agentId } : {}),
    });
    if (!response.ok) {
      throw { code: response.error.code, message: response.error.message } satisfies CommandError;
    }
    if (response.result.command !== command.command) {
      throw {
        code: "BROWSER_UNEXPECTED_RESULT",
        message: `Expected a ${command.command} result, got ${response.result.command}.`,
      } satisfies CommandError;
    }
    return response.result as Extract<BrowserToolsResult, { command: TCommand }>;
  } finally {
    await client.close().catch(() => undefined);
  }
}

async function runTabs(options: CommandOptions, _command: Command): Promise<ListResult<TabRow>> {
  const result = await execute(
    options,
    { command: "list_tabs", args: {} },
    { requireAgent: false },
  );
  return { type: "list", data: result.tabs, schema: tabSchema };
}

async function runRecordStart(
  browserId: string,
  options: RecordStartOptions,
  _command: Command,
): Promise<SingleResult<RecordStartRow>> {
  const result = await execute(
    options,
    {
      command: "record_start",
      args: { browserId, ...(options.audio ? { audio: true } : {}) },
    },
    { requireAgent: true },
  );
  return { type: "single", data: result, schema: recordStartSchema };
}

async function runRecordStop(
  browserId: string,
  options: CommandOptions,
  _command: Command,
): Promise<SingleResult<RecordStopRow>> {
  const result = await execute(
    options,
    { command: "record_stop", args: { browserId } },
    { requireAgent: true },
  );
  return { type: "single", data: result, schema: recordStopSchema };
}

export function createBrowserCommand(): Command {
  const browser = new Command("browser").description("Use Paseo browser tabs");
  addJsonAndDaemonHostOptions(
    browser.command("tabs").description("List Paseo browser tabs"),
  ).action(withOutput(runTabs));

  const record = new Command("record").description(
    "Record a browser tab as QA evidence. Recordings can contain cookies, tokens and private data",
  );
  addJsonAndDaemonHostOptions(
    record
      .command("start")
      .description("Start recording a browser tab")
      .argument("<browserId>", "Browser tab ID from `paseo browser tabs`")
      .option("--audio", "Also record tab audio"),
  ).action(withOutput(runRecordStart));
  addJsonAndDaemonHostOptions(
    record
      .command("stop")
      .description(
        "Stop this agent's recording and start copying it to this host. Paseo messages the agent when the copy finishes",
      )
      .argument("<browserId>", "Browser tab ID the recording started on"),
  ).action(withOutput(runRecordStop));
  browser.addCommand(record);
  return browser;
}
