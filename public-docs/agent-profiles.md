---
title: Agent profiles
description: Save agent settings for one-click selection and use notes to guide delegation for UI work, planning, and reviews.
nav: Agent profiles
order: 32
category: Orchestration
---

# Agent profiles

Save the settings you use together as a named profile. Choose **UI work**, **Planning**, or **Review** when creating an agent instead of selecting its model, thinking level, and mode each time.

- **For you:** one selection applies the saved provider, model, mode, thinking level, and available feature settings.
- **For the agent you start:** profile instructions are added to its system prompt.
- **For an orchestrating agent:** profile notes explain when to choose those settings for delegated work.

## Create a profile

1. Open **Settings → your host → Agents → Agent profiles**.
2. Select **New profile** and give it a name, such as **UI work**.
3. Choose its provider, model, mode, thinking level, and any available features.
4. Fill in **When to use** with the kind of work this profile should handle.
5. Optionally fill in **Instructions** with what every agent started from this profile should follow.
6. Select **Save**.

Profiles are saved on that host. The available settings depend on the provider and model you choose.

## Apply settings in one click

When creating an agent, open the model picker and select a saved profile under **Profiles**. Paseo applies its settings together; you can still adjust them before sending your prompt.

Changing a saved profile affects future selections. It does not update agents you already launched.

## Start agents with instructions

**Instructions** are written for the agent you start, where **When to use** is written for the agent choosing a profile. When you select a profile with instructions for a new agent, the composer shows a **{profile} instructions** pill, and the instructions go into the new agent's system prompt when you send your first message. Select the pill to drop them.

The instructions stay with the draft when you change its model or mode afterwards. Selecting another profile replaces them, or removes them if that profile has none.

A system prompt is set only when an agent starts. Selecting a profile for a running agent applies its settings and leaves the agent's instructions unchanged. Pull request reviewers started from a profile also get its instructions.

Use the host's **System prompt** under **Settings → your host → Orchestration** for text every agent on the host should get.

## Guide delegation with notes

The **When to use** field is the profile's notes. Paseo exposes these notes through its tools so an orchestrating agent can read them before choosing how to launch a worker.

Give each profile a clear specialty:

| Profile  | Example notes                                                                                |
| -------- | -------------------------------------------------------------------------------------------- |
| UI work  | Use for components, layout, styling, and visual polish.                                      |
| Planning | Use for architecture, investigating root causes, and comparing implementation approaches.    |
| Review   | Use for independent review of diffs, correctness, missing tests, and unnecessary complexity. |

Each profile can use a different provider and model, or different settings for the same model.

After [enabling Paseo tools](/docs/orchestration#get-started), ask:

> Check my Paseo profiles and their notes. Choose one for the settings-page UI change, then use a review profile for an independent review of the diff.

The orchestrator reads the profiles, selects settings for each task, and launches the workers. Notes guide that choice; put the worker's actual assignment in its task prompt.

The bundled [Paseo skill](/docs/skills#paseo-paseo-reference) instructs agents to check profiles and read their notes before delegating. If none fit, it directs the agent to discover configured providers and models and tell you about the fallback.

See [Common workflows](/docs/orchestration-workflows) for delegation examples or the [MCP reference](/docs/mcp#agent-profiles) for the tool interface.
