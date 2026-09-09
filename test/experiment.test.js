import test from "node:test";
import assert from "node:assert/strict";
import {
  initialState,
  experimentDirectory,
  ollamaModelName,
  parseOptions,
  roundFileName,
  selectParticipant,
} from "../src/experiment.js";

test("initial state requires an explicit first run", () => {
  assert.deepEqual(initialState(), {
    version: 1,
    status: "ready",
    nextRound: 1,
    nextAttempt: 1,
    acceptedRounds: [],
    active: null,
  });
});

test("experiment directory names cannot escape their parent", () => {
  assert.match(experimentDirectory("simulation-problem"), /experiments\/simulation-problem$/);
  assert.throws(() => experimentDirectory("../outside"), /lowercase letters/);
  assert.throws(() => experimentDirectory("Simulation Problem"), /lowercase letters/);
});

test("participants rotate without starting automatically", () => {
  const config = { models: [
    { id: "ollama/a", role: "propose" },
    { id: "ollama/b", role: "respond" },
  ] };
  assert.deepEqual(selectParticipant(config, 1), { id: "ollama/a", role: "propose" });
  assert.deepEqual(selectParticipant(config, 3), { id: "ollama/a", role: "propose" });
  assert.deepEqual(selectParticipant(config, 2, "ollama/c", "synthesize"), {
    id: "ollama/c",
    role: "synthesize",
  });
});

test("round filenames preserve rejected attempts", () => {
  assert.equal(
    roundFileName(2, 3, "ollama/deepseek-r1:32b"),
    "round-002-attempt-03-deepseek-r1-32b.md",
  );
});

test("only Ollama model IDs can be unloaded", () => {
  assert.equal(ollamaModelName("ollama/model:tag"), "model:tag");
  assert.throws(() => ollamaModelName("llama.cpp/model"), /Only Ollama/);
});

test("CLI options require values", () => {
  assert.deepEqual(parseOptions(["--role", "respond", "--notes", "Looks good"]), {
    _: [],
    role: "respond",
    notes: "Looks good",
  });
  assert.throws(() => parseOptions(["--role"]), /Missing value/);
});
