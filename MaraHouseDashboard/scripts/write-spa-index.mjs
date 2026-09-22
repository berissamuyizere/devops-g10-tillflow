import { readdir, writeFile, copyFile, access } from "node:fs/promises";
import { constants } from "node:fs";
import { join } from "node:path";

const publicDir = join(process.cwd(), "dist", "client");
const assetsDir = join(publicDir, "assets");
const indexPath = join(publicDir, "index.html");
const shellPath = join(publicDir, "_shell.html");

async function exists(path) {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

if (await exists(indexPath)) {
  console.log("index.html already present");
  process.exit(0);
}

if (await exists(shellPath)) {
  await copyFile(shellPath, indexPath);
  console.log("copied _shell.html -> dist/client/index.html");
  process.exit(0);
}

const files = await readdir(assetsDir);
const css = files.find((name) => name.startsWith("styles-") && name.endsWith(".css"));
const js = files.find((name) => name.startsWith("index-") && name.endsWith(".js"));

if (!css || !js) {
  throw new Error(
    `SPA assets missing in ${assetsDir}: css=${css ?? "none"} js=${js ?? "none"}`,
  );
}

const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>TillFlow</title>
    <link rel="icon" href="/favicon.ico" />
    <link rel="stylesheet" href="/assets/${css}" />
  </head>
  <body>
    <script type="module" src="/assets/${js}"></script>
  </body>
</html>
`;

await writeFile(indexPath, html);
console.log(`wrote dist/client/index.html -> ${js} + ${css}`);
