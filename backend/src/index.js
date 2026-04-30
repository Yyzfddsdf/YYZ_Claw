import { createServices } from "./bootstrap/createServices.js";
import { createApp } from "./app.js";
import { PROJECT_ROOT } from "./config/paths.js";
import { attachWorkspaceTerminalServer } from "./services/workspace/workspaceTerminalServer.js";

const PORT = Number(process.env.PORT) || 3001;

async function bootstrap() {
  const services = await createServices();
  const app = createApp(services);

  const server = app.listen(PORT, () => {
    console.log(`[backend] listening at http://localhost:${PORT}`);
  });
  attachWorkspaceTerminalServer(server, { cwd: PROJECT_ROOT });
}

bootstrap().catch((error) => {
  console.error("[backend] failed to start", error);
  process.exitCode = 1;
});
