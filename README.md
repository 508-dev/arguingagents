# Philosophy Debate CLI

Run sequential philosophical experiments using local Ollama models as fresh OpenCode agents. Paseo hosts each session for remote monitoring; each directory under `experiments/` carries one problem and its accepted argument between otherwise independent models.

## Setup

1. Install dependencies with `npm install`.
2. Create an experiment with `npm run experiment -- new <slug>`.
3. Edit `experiments/<slug>/problem.md`.
4. Adjust the shared model order or roles in `experiment.json` if desired.
5. Check the selected experiment with `npm run experiment -- status`.

The configured models are already installed in this machine's Ollama library. New OpenCode sessions load the project-local `opencode.json`, which makes them selectable without changing the global OpenCode configuration.

## Manage Experiments

Create and automatically select a new experiment:

```bash
npm run experiment -- new personal-identity --name "Personal Identity"
```

List all chains or switch the selected chain:

```bash
npm run experiment -- list
npm run experiment -- use simulation-problem
```

Most commands operate on the selected experiment. Use `--experiment <slug>` to target another chain without changing the selection:

```bash
npm run experiment -- status --experiment personal-identity
```

The first completed chain is preserved under `experiments/simulation-problem/`.

## Run A Round

```bash
npm run experiment -- run
```

The command creates an agent in the existing Paseo philosophy workspace, waits for the response, saves it under the selected experiment's `rounds/`, asks Ollama to unload the model, and verifies the model is absent from Ollama's process list. The Paseo session remains available for review.

For fully remote operation, open a terminal tab in that same Paseo workspace and run these commands there. The terminal controls the state machine while each generated agent appears as its own reviewable Paseo session.

If the terminal disconnects while the agent continues in Paseo, reconnect and run:

```bash
npm run experiment -- collect
```

If a provider finishes without a usable answer, inspect its preserved Paseo session and reset the failed attempt with:

```bash
npm run experiment -- retry
```

This increments the attempt number and returns to `ready`; it still does not launch another model.

## Review Gate

Accept the response as-is:

```bash
npm run experiment -- accept
```

Accept it with comments that the next model will receive:

```bash
npm run experiment -- accept --notes "Keep the distinction in section two, but test its second premise."
```

For longer comments, write a Markdown file and use `--notes-file PATH`. Rejecting preserves the attempt but keeps the same round number:

```bash
npm run experiment -- reject --notes "This does not address the stipulated counterexample."
```

Neither decision starts another model. After reviewing the resulting status, explicitly run `npm run experiment -- run` again.

Use another installed model or role for one round with `--model` and `--role`:

```bash
npm run experiment -- run --model ollama/gpt-oss:20b --role respond
```

## Safety States

- `ready`: a human may start one round.
- `running`: a Paseo agent is active or waiting to be collected.
- `awaiting_review`: output is saved and Ollama verified the unload.
- `blocked_unload`: output is saved, but GPU unloading was not verified. Resolve Ollama and run `npm run experiment -- unload`.
- `failed`: the Paseo turn failed and requires inspection.
- `complete`: the experiment was stopped.

Check state at any time with `npm run experiment -- status`. Each experiment has its own `problem.md`, `state.json`, `rounds/`, and `reviews/`. Raw round files and reviews are created with exclusive writes so retries cannot overwrite prior contributions.
