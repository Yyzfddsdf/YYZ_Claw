const fs = require("node:fs/promises");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const esbuild = require("esbuild");

const PROJECT_ROOT = __dirname;
const FRONTEND_ROOT = path.join(PROJECT_ROOT, "frontend");
const FRONTEND_DIST = path.join(FRONTEND_ROOT, "dist");
const FRONTEND_ENTRY = path.join(FRONTEND_ROOT, "src", "main.jsx");
const APP_ICON_FILE = path.join(FRONTEND_ROOT, "src", "assets", "yyz-claw-icon.png");

function resolveModulePath(relativePath) {
  return pathToFileURL(path.join(PROJECT_ROOT, relativePath)).href;
}

async function buildFrontendBundle() {
  await fs.rm(FRONTEND_DIST, { recursive: true, force: true });
  await fs.mkdir(FRONTEND_DIST, { recursive: true });
  await fs.copyFile(APP_ICON_FILE, path.join(FRONTEND_DIST, "favicon.png"));

  await esbuild.build({
    entryPoints: [FRONTEND_ENTRY],
    bundle: true,
    format: "esm",
    target: ["es2020"],
    jsx: "automatic",
    outfile: path.join(FRONTEND_DIST, "app.js"),
    loader: {
      ".js": "jsx",
      ".jsx": "jsx",
      ".css": "css",
      ".woff": "file",
      ".woff2": "file",
      ".ttf": "file",
      ".eot": "file",
      ".otf": "file",
      ".svg": "file",
      ".png": "file",
      ".gif": "file"
    },
    logLevel: "silent"
  });

  const indexHtml = [
    "<!doctype html>",
    "<html lang=\"zh-CN\">",
    "  <head>",
    "    <meta charset=\"UTF-8\" />",
    "    <meta name=\"viewport\" content=\"width=device-width, initial-scale=1.0\" />",
    "    <title>YYZ_CLAW</title>",
    "    <link rel=\"icon\" type=\"image/png\" href=\"/favicon.png\" />",
    "    <link rel=\"stylesheet\" href=\"/app.css\" />",
    "  </head>",
    "  <body>",
    "    <div id=\"root\"></div>",
    "    <script type=\"module\" src=\"/app.js\"></script>",
    "  </body>",
    "</html>",
    ""
  ].join("\n");

  await fs.writeFile(path.join(FRONTEND_DIST, "index.html"), indexHtml, "utf8");
}

async function startService() {
  const buildOnly = process.argv.includes("--build-only");
  const skipFrontendBuild = process.env.YYZ_CLAW_SKIP_FRONTEND_BUILD === "1";
  const port = Number(process.env.PORT) || 3000;

  if (buildOnly || !skipFrontendBuild) {
    await buildFrontendBundle();
    console.log("[service] frontend bundle generated");
  } else {
    console.log("[service] frontend bundle reuse enabled");
  }

  if (buildOnly) {
    return;
  }

  const [{ createServices }, { createApp }] = await Promise.all([
    import(resolveModulePath("backend/src/bootstrap/createServices.js")),
    import(resolveModulePath("backend/src/app.js"))
  ]);
  const { attachWorkspaceTerminalServer } = await import(
    resolveModulePath("backend/src/services/workspace/workspaceTerminalServer.js")
  );

  const services = await createServices();
  const app = createApp(services, { frontendDir: FRONTEND_DIST });

  const server = app.listen(port, () => {
    console.log(`[service] listening at http://localhost:${port}`);
  });
  attachWorkspaceTerminalServer(server, { cwd: PROJECT_ROOT });
}

startService().catch((error) => {
  console.error("[service] startup failed", error);
  process.exitCode = 1;
});
