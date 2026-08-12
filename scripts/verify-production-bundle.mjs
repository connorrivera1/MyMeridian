import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const SERVER_BUILD = fileURLToPath(new URL("../build/server/", import.meta.url));
const FORBIDDEN = [
  "meridian-demo.myshopify.com",
  "Demo store has not been seeded yet",
];

async function javascriptFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) return javascriptFiles(path);
      return entry.isFile() && entry.name.endsWith(".js") ? [path] : [];
    }),
  );
  return nested.flat();
}

const files = await javascriptFiles(SERVER_BUILD);
if (files.length === 0) {
  throw new Error("Production server build contains no JavaScript to inspect.");
}

const leaks = [];
for (const file of files) {
  const source = await readFile(file, "utf8");
  for (const signature of FORBIDDEN) {
    if (source.includes(signature)) leaks.push({ file, signature });
  }
}

if (leaks.length > 0) {
  const details = leaks
    .map(({ file, signature }) => `${file}: ${JSON.stringify(signature)}`)
    .join("\n");
  throw new Error(
    `Development demo authentication leaked into the production bundle:\n${details}`,
  );
}

console.log(
  `Production bundle excludes demo authentication (${files.length} server files inspected).`,
);
