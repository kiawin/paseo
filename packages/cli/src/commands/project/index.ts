import { Command } from "commander";
import { withOutput } from "../../output/index.js";
import { addJsonAndDaemonHostOptions } from "../../utils/command-options.js";
import { runCreateCommand } from "./create.js";
import { runDeleteCommand } from "./delete.js";
import { runLsCommand } from "./ls.js";
import { runRenameCommand } from "./rename.js";
import { runAutoFixAgentPrsCommand, runAutoReviewCommand } from "./automation.js";

export function createProjectCommand(): Command {
  const project = new Command("project").description("Manage projects");

  addJsonAndDaemonHostOptions(
    project
      .command("create")
      .description("Register a project directory")
      .argument("[path]", "Project directory (default: current directory)"),
  ).action(withOutput(runCreateCommand));

  addJsonAndDaemonHostOptions(project.command("ls").description("List projects")).action(
    withOutput(runLsCommand),
  );

  addJsonAndDaemonHostOptions(
    project
      .command("rename")
      .description("Set a project's user-visible name")
      .argument("<project-id>", "Project id")
      .argument("[name]", "New project name")
      .option("--reset", "Clear the custom name and use the directory name")
      .allowExcessArguments(false),
  ).action(withOutput(runRenameCommand));

  addJsonAndDaemonHostOptions(
    project
      .command("delete")
      .description("Delete a project and its workspaces")
      .argument("<project-id>", "Project id"),
  ).action(withOutput(runDeleteCommand));

  addJsonAndDaemonHostOptions(
    project
      .command("autoreview")
      .description("Review PRs automatically when your review is requested (GitHub)")
      .argument("<project-id>", "Project id")
      .argument("<state>", "on or off")
      .option("--provider <provider>", "Reviewer agent provider, as provider or provider/model")
      .option("--post-reviews", "Let reviewers post a comment-only review on the PR")
      .option("--no-post-reviews", "Keep review findings in Paseo"),
  ).action(withOutput(runAutoReviewCommand));

  addJsonAndDaemonHostOptions(
    project
      .command("autofix")
      .description("Watch PRs that agents open from this project's worktrees for auto-fix")
      .argument("<project-id>", "Project id")
      .argument("<state>", "on or off"),
  ).action(withOutput(runAutoFixAgentPrsCommand));

  return project;
}
