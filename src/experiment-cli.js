#!/usr/bin/env node

import { join } from "node:path";
import { createPaseoClient } from "@getpaseo/client";
import {
  ROOT,
  buildPrompt,
  displayPath,
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
  status                         Show the experiment state
  run [--model ID] [--role ROLE] Start one round and wait for its answer
  collect                       Reconnect to a running round and collect it
  accept [--notes TEXT]          Accept the current answer; does not start the next
  accept --notes-file PATH       Accept with review notes from a file
  reject [--notes TEXT]          Reject the answer and prepare another attempt
  retry                          Clear a failed attempt after inspecting it
  unload                        Retry a failed GPU unload
  stop                          Mark the experiment complete

Roles correspond to files in prompts/: propose, respond, or synthesize.`;

async function config() {
  return readJson(join(ROOT, "experiment.json"));
}

function printStatus(state) {
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

async function finishRound(client, state, configuration) {
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
    await saveState(state);
    throw new Error(state.active.error);
  }

  state.active.output = await writeRound(state.active, result.lastMessage);
  try {
    await unloadModel(state.active.model);
    state.status = "awaiting_review";
    state.active.error = null;
  } catch (error) {
    state.status = "blocked_unload";
    state.active.error = error.message;
  }
  await saveState(state);
  printStatus(state);
  if (state.status === "blocked_unload") throw new Error(state.active.error);
  console.log("Review the Paseo session and round file, then run accept or reject.");
}

async function runRound(options) {
  const [state, configuration] = await Promise.all([loadState(), config()]);
  if (state.status !== "ready") throw new Error(`Cannot run from state ${state.status}`);
  const participant = selectParticipant(
    configuration,
    state.nextRound,
    options.model,
    options.role,
  );
  ollamaModelName(participant.id);
  const prompt = await buildPrompt(state, participant);
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
  await saveState(state);

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
        experiment: "philosophy-debate",
        round: String(state.nextRound),
        role: participant.role,
      },
      prompt,
    });
    state.status = "running";
    state.active.agentId = agent.id;
    await saveState(state);
    console.log(`Paseo agent ${agent.id} is running with ${participant.id}.`);
    await finishRound(client, state, configuration);
  } catch (error) {
    if (state.status === "starting") {
      state.status = "failed";
      state.active.error = error.message;
      try {
        await unloadModel(state.active.model);
      } catch (unloadError) {
        state.active.error = `${state.active.error}; best-effort unload failed: ${unloadError.message}`;
      }
      await saveState(state);
    }
    throw error;
  } finally {
    await client.close();
  }
}

async function collectRound() {
  const [state, configuration] = await Promise.all([loadState(), config()]);
  if (state.status !== "running" || !state.active?.agentId) {
    throw new Error("There is no running Paseo round to collect");
  }
  const client = await connect(configuration);
  try {
    await finishRound(client, state, configuration);
  } finally {
    await client.close();
  }
}

async function review(decision, options) {
  const state = await loadState();
  if (state.status !== "awaiting_review") {
    throw new Error(`Cannot ${decision} from state ${state.status}`);
  }
  const notes = await readNotes(options);
  const reviewPath = await writeReview(state.active, decision, notes);
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
  await saveState(state);
  printStatus(state);
  console.log("No next round was started. Run the run command when you are ready.");
}

async function retryUnload() {
  const state = await loadState();
  if (state.status !== "blocked_unload" || !state.active) {
    throw new Error("The experiment is not blocked on an Ollama unload");
  }
  await unloadModel(state.active.model);
  state.status = "awaiting_review";
  state.active.error = null;
  await saveState(state);
  printStatus(state);
}

async function retryFailed() {
  const state = await loadState();
  if (state.status !== "failed" || !state.active) {
    throw new Error("The experiment does not have a failed attempt to retry");
  }
  await unloadModel(state.active.model);
  state.nextAttempt += 1;
  state.status = "ready";
  state.active = null;
  await saveState(state);
  printStatus(state);
  console.log("The failed Paseo session was preserved. Run the run command when ready.");
}

async function stop() {
  const state = await loadState();
  if (["running", "starting", "blocked_unload"].includes(state.status)) {
    throw new Error(`Cannot stop safely from state ${state.status}`);
  }
  state.status = "complete";
  await saveState(state);
  printStatus(state);
}

async function main() {
  const [command = "status", ...rawOptions] = process.argv.slice(2);
  const options = parseOptions(rawOptions);
  if (options._.length) throw new Error(`Unexpected arguments: ${options._.join(" ")}`);
  switch (command) {
    case "status": printStatus(await loadState()); break;
    case "run": await runRound(options); break;
    case "collect": await collectRound(); break;
    case "accept": await review("accepted", options); break;
    case "reject": await review("rejected", options); break;
    case "retry": await retryFailed(); break;
    case "unload": await retryUnload(); break;
    case "stop": await stop(); break;
    case "help":
    case "--help": console.log(HELP); break;
    default: throw new Error(`Unknown command: ${command}\n\n${HELP}`);
  }
}

main().catch((error) => {
  console.error(`Error: ${error.message}`);
  process.exitCode = 1;
});
