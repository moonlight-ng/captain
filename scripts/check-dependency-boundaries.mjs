import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

const apps = ["pilot", "captain", "flight-worker"];
const failures = [];

for (const app of apps) {
  const root = join("apps", app);
  const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  for (const sibling of apps.filter((candidate) => candidate !== app)) {
    if (manifest.dependencies?.[`@agents/${sibling}`] || manifest.devDependencies?.[`@agents/${sibling}`]) {
      failures.push(`${root}/package.json depends on sibling app @agents/${sibling}`);
    }
  }
  for (const file of await sourceFiles(root)) {
    const content = await readFile(file, "utf8");
    for (const sibling of apps.filter((candidate) => candidate !== app)) {
      if (content.includes(`@agents/${sibling}`) || content.includes(`/apps/${sibling}/`)) {
        failures.push(`${file} imports sibling app ${sibling}`);
      }
    }
  }
}

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
