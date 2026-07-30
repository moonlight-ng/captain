import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, resolve } from "node:path";

const options = parseArgs(process.argv.slice(2));
const agent = requiredOption(options, "agent");
if (!["captain", "concierge", "curiosity-study"].includes(agent)) {
  throw new Error("--agent must be captain, concierge, or curiosity-study");
}

const runId = requiredOption(options, "run-id");
const failedRunUrl = requiredOption(options, "failed-run-url");
const repairWorkflowUrl = optionalOption(options, "repair-workflow-url");
const sourceWorkflowConclusion = optionalOption(
  options,
  "source-workflow-conclusion"
);
const sourceWorkflowStartedAt = optionalOption(
  options,
  "source-workflow-started-at"
);
const sourceWorkflowCompletedAt = optionalOption(
  options,
  "source-workflow-completed-at"
);
const reportPath = resolve(requiredOption(options, "report"));
const outputDir = resolve(
  options.get("output-dir") ?? "apps/captain/agent-improvements"
);
const report = (await readFile(reportPath, "utf8"))
  .replace(/\s+/g, " ")
  .trim();

if (!report) {
  throw new Error(`Codex report is empty: ${reportPath}`);
}

const filesChanged = changedFiles(outputDir);
if (filesChanged.length === 0) {
  throw new Error("Cannot record an improvement without changed files");
}

const record = {
  version: 1,
  id: `${agent}:${runId}`,
  agent,
  recordedAt: new Date().toISOString(),
  failedRunUrl,
  ...(repairWorkflowUrl
    ? { repairWorkflowUrl, verificationStatus: "passed" }
    : {}),
  ...(sourceWorkflowConclusion ? { sourceWorkflowConclusion } : {}),
  ...durationFields(sourceWorkflowStartedAt, sourceWorkflowCompletedAt),
  summary: report.slice(0, 4_000),
  filesChanged
};

await mkdir(outputDir, { recursive: true });
const outputPath = resolve(outputDir, `${agent}-${runId}.json`);
await writeFile(outputPath, `${JSON.stringify(record, null, 2)}\n`, "utf8");
console.log(`Wrote ${basename(outputPath)}`);

function changedFiles(outputRoot) {
  const status = execFileSync(
    "git",
    ["status", "--porcelain=v1", "--untracked-files=all"],
    { encoding: "utf8" }
  );
  const relativeOutput = outputRoot
    .replace(`${process.cwd()}/`, "")
    .replace(/\/?$/, "/");

  return status
    .split("\n")
    .filter(Boolean)
    .map((line) => line.slice(3))
    .map((path) => path.split(" -> ").at(-1))
    .filter(
      (path) =>
        path &&
        !path.startsWith(".codex-artifacts/") &&
        !path.startsWith(relativeOutput)
    )
    .sort();
}

function parseArgs(args) {
  const parsed = new Map();
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index];
    const value = args[index + 1];
    if (!name?.startsWith("--") || !value) {
      throw new Error(`Invalid argument near ${name ?? "(end)"}`);
    }
    parsed.set(name.slice(2), value);
  }
  return parsed;
}

function requiredOption(options, name) {
  const value = options.get(name);
  if (!value) throw new Error(`Missing --${name}`);
  return value;
}

function optionalOption(options, name) {
  return options.get(name)?.trim() || undefined;
}

function durationFields(startedAt, completedAt) {
  if (!startedAt || !completedAt) return {};
  const started = Date.parse(startedAt);
  const completed = Date.parse(completedAt);
  if (!Number.isFinite(started) || !Number.isFinite(completed)) {
    throw new Error("Workflow timestamps must be valid ISO timestamps");
  }
  return { sourceWorkflowDurationMs: Math.max(0, completed - started) };
}
