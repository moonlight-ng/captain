import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

/** Deployed Fly apps — must not depend on each other. */
const deployedApps = ["captain", "flight-worker"];
/** Frontend package Captain builds and serves; not a separate Fly app. */
const webApp = "web";
const failures = [];
const captainLegacyRules = [
  /\bFlightAgent(?:Env|Services)\b/u,
  /\b(?:get|create)FlightAgentServices\b/u,
  /\bCaptainResearchClient\b/u,
  /bridge\/captain-client/u,
  /\b(?:CAPTAIN_TO_FLIGHT_AGENT_SECRET|FLIGHT_AGENT_TO_CAPTAIN_SECRET|FLIGHT_AGENT_PUBLIC_URL|FLIGHT_AGENT_BASIC_(?:USERNAME|PASSWORD)|FLIGHT_AGENT_OWNER_AUTH_ENABLED)\b/u,
  /(?:service|agent_id):\s*["']flight-agent["']/u
];

for (const app of deployedApps) {
  const root = join("apps", app);
  const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  const dockerfile = await readFile(join(root, "Dockerfile"), "utf8");
  for (const sibling of deployedApps.filter((candidate) => candidate !== app)) {
    if (
      manifest.dependencies?.[`@agents/${sibling}`] ||
      manifest.devDependencies?.[`@agents/${sibling}`]
    ) {
      failures.push(`${root}/package.json depends on sibling app @agents/${sibling}`);
    }
    if (dockerfile.includes(`apps/${sibling}`)) {
      failures.push(`${root}/Dockerfile copies sibling app ${sibling}`);
    }
  }
  for (const file of await sourceFiles(root)) {
    const content = await readFile(file, "utf8");
    if (content.includes("@agents/pilot") || content.includes("/apps/pilot/")) {
      failures.push(`${file} imports the separate Pilot product`);
    }
    if (app === "captain") {
      for (const rule of captainLegacyRules) {
        if (rule.test(content)) {
          failures.push(`${file} violates the Captain runtime identity boundary (${rule})`);
        }
      }
      if (
        content.includes(`apps/${webApp}/src`)
        || content.includes(`../../${webApp}/src`)
        || content.includes(`../${webApp}/src`)
      ) {
        failures.push(`${file} imports ${webApp} source; keep captain↔web coupled only via build output`);
      }
    }
  }
}

for (const file of await sourceFiles(join("apps", webApp))) {
  const content = await readFile(file, "utf8");
  if (
    content.includes("apps/captain/services")
    || content.includes("apps/captain/agent")
    || content.includes("../../captain/services")
    || content.includes("../../captain/agent")
  ) {
    failures.push(`${file} imports captain server code; web talks to Captain over HTTP only`);
  }
}

await checkDeploymentIdentity("captain", "dr-captain");
await checkDeploymentIdentity("flight-worker", "dr-flight-worker");
await checkCaptainEnvironmentOwnership();

if (failures.length > 0) {
  console.error(failures.join("\n"));
  process.exitCode = 1;
} else {
  console.info("Captain dependency boundaries are valid");
}

async function sourceFiles(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (["node_modules", ".output", ".eve", "dist"].includes(entry.name)) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await sourceFiles(path));
    else if (/\.(?:ts|tsx|js|mjs)$/u.test(entry.name)) files.push(path);
  }
  return files;
}

async function checkDeploymentIdentity(app, expectedName) {
  const file = join("apps", app, "fly.toml");
  const content = await readFile(file, "utf8");
  if (!content.includes(`app = "${expectedName}"`)) {
    failures.push(`${file} must deploy ${app} as ${expectedName}`);
  }
}

async function checkCaptainEnvironmentOwnership() {
  const file = "apps/captain/.env.example";
  const content = await readFile(file, "utf8");
  for (const match of content.matchAll(/^\s*#?\s*([A-Z][A-Z0-9_]+)=/gmu)) {
    if (match[1]?.startsWith("PILOT_")) {
      failures.push(`${file} exposes Pilot runtime setting ${match[1]}`);
    }
  }
}
