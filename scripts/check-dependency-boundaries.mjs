import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

const apps = ["pilot", "captain", "flight-worker"];
const failures = [];
const identityRules = {
  pilot: [
    /\bCaptain(?:Env|Services|Principal)\b/u,
    /\b(?:get|create)CaptainServices\b/u,
    /captain_principal/u,
    /captain-telegram-webhook/u,
    /["'`]captain\./u,
    /\bCAPTAIN_(?!BASE_URL\b|TO_PILOT_SECRET\b)/u,
    /(?:service|agent_id):\s*["']captain["']/u
  ],
  captain: [
    /\bFlightAgent(?:Env|Services)\b/u,
    /\b(?:get|create)FlightAgentServices\b/u,
    /\bCaptainResearchClient\b/u,
    /bridge\/captain-client/u,
    /\b(?:CAPTAIN_TO_FLIGHT_AGENT_SECRET|FLIGHT_AGENT_TO_CAPTAIN_SECRET|FLIGHT_AGENT_PUBLIC_URL|FLIGHT_AGENT_BASIC_(?:USERNAME|PASSWORD)|FLIGHT_AGENT_OWNER_AUTH_ENABLED)\b/u,
    /(?:service|agent_id):\s*["']flight-agent["']/u
  ]
};

for (const app of apps) {
  const root = join("apps", app);
  const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  const dockerfile = await readFile(join(root, "Dockerfile"), "utf8");
  for (const sibling of apps.filter((candidate) => candidate !== app)) {
    if (manifest.dependencies?.[`@agents/${sibling}`] || manifest.devDependencies?.[`@agents/${sibling}`]) {
      failures.push(`${root}/package.json depends on sibling app @agents/${sibling}`);
    }
    if (dockerfile.includes(`apps/${sibling}`)) {
      failures.push(`${root}/Dockerfile copies sibling app ${sibling}`);
    }
  }
  for (const file of await sourceFiles(root)) {
    const content = await readFile(file, "utf8");
    for (const sibling of apps.filter((candidate) => candidate !== app)) {
      if (content.includes(`@agents/${sibling}`) || content.includes(`/apps/${sibling}/`)) {
        failures.push(`${file} imports sibling app ${sibling}`);
      }
    }
    for (const rule of identityRules[app] ?? []) {
      if (rule.test(content)) {
        failures.push(`${file} violates the ${app} runtime identity boundary (${rule})`);
      }
    }
  }
}

// Product identities are Pilot and Captain, while the original Fly app names
// stay stable during migration to preserve DNS, webhooks, volumes, and rollback.
await checkDeploymentIdentity("pilot", "opemipo-captain");
await checkDeploymentIdentity("captain", "opemipo-flight-agent");
await checkEnvironmentOwnership("pilot", new Set([
  "CAPTAIN_BASE_URL",
  "CAPTAIN_TO_PILOT_SECRET"
]));
await checkEnvironmentOwnership("captain", new Set([
  "PILOT_BASE_URL",
  "PILOT_TO_CAPTAIN_SECRET"
]));

if (failures.length > 0) {
  console.error(failures.join("\n"));
  process.exitCode = 1;
} else {
  console.info("Application dependency boundaries are valid");
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

async function checkEnvironmentOwnership(app, allowedRemoteKeys) {
  const file = join("apps", app, ".env.example");
  const content = await readFile(file, "utf8");
  const foreignPrefix = app === "pilot" ? "CAPTAIN_" : "PILOT_";
  for (const match of content.matchAll(/^\s*#?\s*([A-Z][A-Z0-9_]+)=/gmu)) {
    const name = match[1];
    if (name.startsWith(foreignPrefix) && !allowedRemoteKeys.has(name)) {
      failures.push(`${file} exposes foreign runtime setting ${name}`);
    }
  }
}
