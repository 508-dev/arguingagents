import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { spawn } from "node:child_process";

export const ROOT = resolve(import.meta.dirname, "..");
export const STATE_PATH = join(ROOT, "state.json");

export async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

export async function readOptionalJson(path) {
  try {
    return await readJson(path);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

export function initialState() {
  return {
    version: 1,
    status: "ready",
    nextRound: 1,
    nextAttempt: 1,
    acceptedRounds: [],
    active: null,
  };
}

export async function loadState() {
  return (await readOptionalJson(STATE_PATH)) ?? initialState();
}

export async function saveState(state) {
  const temporary = `${STATE_PATH}.tmp`;
  await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`);
  await rename(temporary, STATE_PATH);
}

export function selectParticipant(config, roundNumber, modelOverride, roleOverride) {
  const configured = config.models[(roundNumber - 1) % config.models.length];
  if (!configured && !modelOverride) throw new Error("experiment.json must define at least one model");
  return {
    id: modelOverride ?? configured.id,
    role: roleOverride ?? configured?.role ?? "respond",
  };
}

export function safeModelName(modelId) {
  return modelId
    .replace(/^ollama\//, "")
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .toLowerCase();
}

export function roundFileName(round, attempt, modelId) {
  return `round-${String(round).padStart(3, "0")}-attempt-${String(attempt).padStart(2, "0")}-${safeModelName(modelId)}.md`;
}

export async function buildPrompt(state, participant) {
  const [problem, roleInstructions] = await Promise.all([
    readFile(join(ROOT, "problem.md"), "utf8"),
    readFile(join(ROOT, "prompts", `${participant.role}.md`), "utf8"),
  ]);

  const accepted = await Promise.all(
    state.acceptedRounds.map(async (round) => {
      const [output, review] = await Promise.all([
        readFile(join(ROOT, round.output), "utf8"),
        round.review ? readFile(join(ROOT, round.review), "utf8") : Promise.resolve(""),
      ]);
      return `## Accepted Round ${round.round}\n\n${output}${review ? `\n\n### Human Review\n\n${review}` : ""}`;
    }),
  );

  return [
    "You are one participant in a sequential philosophical workshop. Return only your contribution in Markdown. You cannot use tools, alter files, or contact other participants.",
    "# Original Problem",
    problem.trim(),
    accepted.length ? "# Accepted Discussion" : "# Accepted Discussion\n\nNo earlier rounds have been accepted.",
    accepted.join("\n\n"),
    `# Your Role: ${participant.role}`,
    roleInstructions.trim(),
  ].filter(Boolean).join("\n\n");
}

export function runCommand(command, args) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", rejectPromise);
    child.on("close", (code) => {
      if (code === 0) resolvePromise({ stdout, stderr });
      else rejectPromise(new Error(`${command} exited with ${code}: ${stderr.trim()}`));
    });
  });
}

export function ollamaModelName(modelId) {
  if (!modelId.startsWith("ollama/")) {
    throw new Error(`Only Ollama models are supported by this CLI: ${modelId}`);
  }
  return modelId.slice("ollama/".length);
}

async function loadedOllamaModels() {
  const response = await fetch("http://127.0.0.1:11434/api/ps");
  if (!response.ok) throw new Error(`Ollama /api/ps returned HTTP ${response.status}`);
  const body = await response.json();
  return (body.models ?? []).flatMap((model) => [model.name, model.model].filter(Boolean));
}

export async function unloadModel(modelId, waitMs = 20_000) {
  const model = ollamaModelName(modelId);
  await runCommand("ollama", ["stop", model]);
  const deadline = Date.now() + waitMs;
  do {
    const loaded = await loadedOllamaModels();
    if (!loaded.includes(model)) return;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 500));
  } while (Date.now() < deadline);
  throw new Error(`Ollama still reports ${model} loaded after ${waitMs / 1000} seconds`);
}

export async function writeRound(active, response) {
  const relativePath = join("rounds", roundFileName(active.round, active.attempt, active.model));
  const absolutePath = join(ROOT, relativePath);
  await mkdir(dirname(absolutePath), { recursive: true });
  const content = [
    `# Round ${active.round}: ${active.role}`,
    `- Model: \`${active.model}\``,
    `- Paseo agent: \`${active.agentId}\``,
    `- Completed: ${new Date().toISOString()}`,
    "",
    response.trim(),
    "",
  ].join("\n");
  await writeFile(absolutePath, content, { flag: "wx" });
  return relativePath;
}

export async function writeReview(active, decision, notes) {
  const relativePath = join(
    "reviews",
    `round-${String(active.round).padStart(3, "0")}-attempt-${String(active.attempt).padStart(2, "0")}.md`,
  );
  const absolutePath = join(ROOT, relativePath);
  await mkdir(dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, [
    `# Review: Round ${active.round}, Attempt ${active.attempt}`,
    `- Decision: ${decision}`,
    `- Reviewed: ${new Date().toISOString()}`,
    "",
    notes || "No additional notes.",
    "",
  ].join("\n"), { flag: "wx" });
  return relativePath;
}

export async function readNotes(options) {
  if (options["notes-file"]) return (await readFile(resolve(ROOT, options["notes-file"]), "utf8")).trim();
  return options.notes ?? "";
}

export function parseOptions(args) {
  const options = { _: [] };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (!argument.startsWith("--")) {
      options._.push(argument);
      continue;
    }
    const key = argument.slice(2);
    const value = args[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`Missing value for --${key}`);
    options[key] = value;
    index += 1;
  }
  return options;
}

export function displayPath(path) {
  return path ? basename(path) : "-";
}
