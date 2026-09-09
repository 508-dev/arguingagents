#!/usr/bin/env node

import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createPaseoClient } from "@getpaseo/client";
import {
  CURRENT_EXPERIMENT_PATH,
  EXPERIMENTS_ROOT,
  ROOT,
  buildPrompt,
  displayPath,
  experimentDirectory,
  initialState,
  loadState,
  ollamaModelName,
  parseOptions,
  readJson,
  readNotes,
  saveState,
  selectParticipant,
  unloadModel,
  writeReview,
  writeRound,
} from "./experiment.js";

const HELP = `Usage: npm run experiment -- <command> [options]

Commands:
  new SLUG [--name NAME]         Create and select an experiment
  list                           List experiments
  use SLUG                       Select an existing experiment
  status                         Show the experiment state
  run [--model ID] [--role ROLE] Start one round and wait for its answer
  collect                       Reconnect to a running round and collect it
  accept [--notes TEXT]          Accept the current answer; does not start the next
  accept --notes-file PATH       Accept with review notes from a file
  reject [--notes TEXT]          Reject the answer and prepare another attempt
  retry                          Clear a failed attempt after inspecting it
  unload                        Retry a failed GPU unload
  stop                          Mark the experiment complete

Options:
  --experiment SLUG              Use a specific experiment without selecting it

Roles correspond to files in prompts/: propose, respond, or synthesize.`;

async function config() {
  return readJson(join(ROOT, "experiment.json"));
}

function printStatus(slug, state) {
  console.log(`Experiment: ${slug}`);
  console.log(`Status: ${state.status}`);
  console.log(`Next round: ${state.nextRound}, attempt ${state.nextAttempt}`);
  console.log(`Accepted rounds: ${state.acceptedRounds.length}`);
  if (state.active) {
    console.log(`Model: ${state.active.model}`);
    console.log(`Role: ${state.active.role}`);
    console.log(`Agent: ${state.active.agentId ?? "not created"}`);
    console.log(`Output: ${displayPath(state.active.output)}`);
    if (state.active.error) console.log(`Error: ${state.active.error}`);
  }
}

async function connect(configuration) {
  const client = createPaseoClient({ url: configuration.paseoUrl });
  await client.connect();
  return client;
}

async function selectedSlug(options = {}) {
  if (options.experiment) return options.experiment;
  try {
    return (await readFile(CURRENT_EXPERIMENT_PATH, "utf8")).trim();
  } catch (error) {
    if (error.code === "ENOENT") {
      throw new Error("No experiment is selected. Create one with: npm run experiment -- new <slug>");
    }
    throw error;
  }
}

async function selectedExperiment(options = {}) {
  const slug = await selectedSlug(options);
  const directory = experimentDirectory(slug);
  try {
    await readFile(join(directory, "problem.md"), "utf8");
  } catch (error) {
    if (error.code === "ENOENT") throw new Error(`Experiment does not exist: ${slug}`);
    throw error;
  }
  return { slug, directory };
}

async function selectExperiment(slug) {
  const directory = experimentDirectory(slug);
  try {
    await readFile(join(directory, "problem.md"), "utf8");
  } catch (error) {
    if (error.code === "ENOENT") throw new Error(`Experiment does not exist: ${slug}`);
    throw error;
  }
  await writeFile(CURRENT_EXPERIMENT_PATH, `${slug}\n`);
  console.log(`Selected experiment: ${slug}`);
}

async function createExperiment(slug, options) {
  const directory = experimentDirectory(slug);
  await mkdir(EXPERIMENTS_ROOT, { recursive: true });
  try {
    await mkdir(directory);
  } catch (error) {
    if (error.code === "EEXIST") throw new Error(`Experiment already exists: ${slug}`);
    throw error;
  }
  const name = options.name ?? slug.split("-").map((part) => `${part[0].toUpperCase()}${part.slice(1)}`).join(" ");
  await Promise.all([
    writeFile(join(directory, "problem.md"), `# ${name}\n\nDescribe the philosophical problem, definitions, assumptions, and success criteria here.\n`),
    saveState(directory, initialState()),
  ]);
  await writeFile(CURRENT_EXPERIMENT_PATH, `${slug}\n`);
  console.log(`Created and selected experiments/${slug}/`);
  console.log(`Edit experiments/${slug}/problem.md, then run the run command.`);
}

async function listExperiments() {
  let entries;
  try {
    entries = await readdir(EXPERIMENTS_ROOT, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") entries = [];
    else throw error;
  }
  let current = null;
  try {
    current = (await readFile(CURRENT_EXPERIMENT_PATH, "utf8")).trim();
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const slugs = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
  if (!slugs.length) {
    console.log("No experiments found.");
    return;
  }
  for (const slug of slugs) {
    const state = await loadState(experimentDirectory(slug));
    console.log(`${slug === current ? "*" : " "} ${slug} (${state.status}, ${state.acceptedRounds.length} accepted)`);
  }
}

async function finishRound(client, experiment, state, configuration) {
  const agent = client.agents.ref(state.active.agentId);
  const result = await agent.waitForFinish(configuration.timeoutMinutes * 60_000);
  if (result.status !== "idle" || !result.lastMessage) {
    state.active.error = result.error ?? `Paseo returned ${result.status} without an answer`;
    if (result.status === "timeout" || result.status === "permission") {
      state.status = "running";
    } else {
      try {
        await unloadModel(state.active.model);
        state.status = "failed";
      } catch (error) {
        state.status = "blocked_unload";
        state.active.error = `${state.active.error}; unload failed: ${error.message}`;
      }
    }
    await saveState(experiment.directory, state);
    throw new Error(state.active.error);
  }

  state.active.output = await writeRound(experiment.directory, state.active, result.lastMessage);
  try {
    await unloadModel(state.active.model);
    state.status = "awaiting_review";
    state.active.error = null;
  } catch (error) {
    state.status = "blocked_unload";
    state.active.error = error.message;
  }
  await saveState(experiment.directory, state);
  printStatus(experiment.slug, state);
  if (state.status === "blocked_unload") throw new Error(state.active.error);
  console.log("Review the Paseo session and round file, then run accept or reject.");
}

async function runRound(options) {
  const experiment = await selectedExperiment(options);
  const [state, configuration] = await Promise.all([loadState(experiment.directory), config()]);
  if (state.status !== "ready") throw new Error(`Cannot run from state ${state.status}`);
  const participant = selectParticipant(
    configuration,
    state.nextRound,
    options.model,
    options.role,
  );
  ollamaModelName(participant.id);
  const prompt = await buildPrompt(experiment.directory, state, participant);
  state.status = "starting";
  state.active = {
    round: state.nextRound,
    attempt: state.nextAttempt,
    model: participant.id,
    role: participant.role,
    agentId: null,
    output: null,
    error: null,
    startedAt: new Date().toISOString(),
  };
  await saveState(experiment.directory, state);

  const client = await connect(configuration);
  try {
    const workspace = client.workspaces.ref(configuration.workspaceId);
    const agent = await workspace.agents.create({
      config: {
        provider: `opencode/${participant.id}`,
        modeId: "plan",
        options: { permission: "deny" },
      },
      title: `Philosophy round ${state.nextRound}: ${participant.role}`,
      labels: {
        experiment: experiment.slug,
        round: String(state.nextRound),
        role: participant.role,
      },
      prompt,
    });
    state.status = "running";
    state.active.agentId = agent.id;
    await saveState(experiment.directory, state);
    console.log(`Paseo agent ${agent.id} is running with ${participant.id}.`);
    await finishRound(client, experiment, state, configuration);
  } catch (error) {
    if (state.status === "starting") {
      state.status = "failed";
      state.active.error = error.message;
      try {
        await unloadModel(state.active.model);
      } catch (unloadError) {
        state.active.error = `${state.active.error}; best-effort unload failed: ${unloadError.message}`;
      }
      await saveState(experiment.directory, state);
    }
    throw error;
  } finally {
    await client.close();
  }
}

async function collectRound(options) {
  const experiment = await selectedExperiment(options);
  const [state, configuration] = await Promise.all([loadState(experiment.directory), config()]);
  if (state.status !== "running" || !state.active?.agentId) {
    throw new Error("There is no running Paseo round to collect");
  }
  const client = await connect(configuration);
  try {
    await finishRound(client, experiment, state, configuration);
  } finally {
    await client.close();
  }
}

async function review(decision, options) {
  const experiment = await selectedExperiment(options);
  const state = await loadState(experiment.directory);
  if (state.status !== "awaiting_review") {
    throw new Error(`Cannot ${decision} from state ${state.status}`);
  }
  const notes = await readNotes(options);
  const reviewPath = await writeReview(experiment.directory, state.active, decision, notes);
  if (decision === "accepted") {
    state.acceptedRounds.push({
      round: state.active.round,
      attempt: state.active.attempt,
      model: state.active.model,
      role: state.active.role,
      output: state.active.output,
      review: reviewPath,
    });
    state.nextRound += 1;
    state.nextAttempt = 1;
  } else {
    state.nextAttempt += 1;
  }
  state.status = "ready";
  state.active = null;
  await saveState(experiment.directory, state);
  printStatus(experiment.slug, state);
  console.log("No next round was started. Run the run command when you are ready.");
}

async function retryUnload(options) {
  const experiment = await selectedExperiment(options);
  const state = await loadState(experiment.directory);
  if (state.status !== "blocked_unload" || !state.active) {
    throw new Error("The experiment is not blocked on an Ollama unload");
  }
  await unloadModel(state.active.model);
  state.status = "awaiting_review";
  state.active.error = null;
  await saveState(experiment.directory, state);
  printStatus(experiment.slug, state);
}

async function retryFailed(options) {
  const experiment = await selectedExperiment(options);
  const state = await loadState(experiment.directory);
  if (state.status !== "failed" || !state.active) {
    throw new Error("The experiment does not have a failed attempt to retry");
  }
  await unloadModel(state.active.model);
  state.nextAttempt += 1;
  state.status = "ready";
  state.active = null;
  await saveState(experiment.directory, state);
  printStatus(experiment.slug, state);
  console.log("The failed Paseo session was preserved. Run the run command when ready.");
}

async function stop(options) {
  const experiment = await selectedExperiment(options);
  const state = await loadState(experiment.directory);
  if (["running", "starting", "blocked_unload"].includes(state.status)) {
    throw new Error(`Cannot stop safely from state ${state.status}`);
  }
  state.status = "complete";
  await saveState(experiment.directory, state);
  printStatus(experiment.slug, state);
}

async function main() {
  const [command = "status", ...rawOptions] = process.argv.slice(2);
  const options = parseOptions(rawOptions);
  if (!["new", "use"].includes(command) && options._.length) {
    throw new Error(`Unexpected arguments: ${options._.join(" ")}`);
  }
  switch (command) {
    case "new": {
      if (options._.length !== 1) throw new Error("Usage: npm run experiment -- new <slug> [--name NAME]");
      await createExperiment(options._[0], options);
      break;
    }
    case "use": {
      if (options._.length !== 1) throw new Error("Usage: npm run experiment -- use <slug>");
      await selectExperiment(options._[0]);
      break;
    }
    case "list": {
      await listExperiments();
      break;
    }
    case "status": {
      const experiment = await selectedExperiment(options);
      printStatus(experiment.slug, await loadState(experiment.directory));
      break;
    }
    case "run": await runRound(options); break;
    case "collect": await collectRound(options); break;
    case "accept": await review("accepted", options); break;
    case "reject": await review("rejected", options); break;
    case "retry": await retryFailed(options); break;
    case "unload": await retryUnload(options); break;
    case "stop": await stop(options); break;
    case "help":
    case "--help": console.log(HELP); break;
    default: throw new Error(`Unknown command: ${command}\n\n${HELP}`);
  }
}

main().catch((error) => {
  console.error(`Error: ${error.message}`);
  process.exitCode = 1;
});
