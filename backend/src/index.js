import { createServices } from "./bootstrap/createServices.js";
import { createApp } from "./app.js";

const PORT = Number(process.env.PORT) || 3001;

async function bootstrap() {
  const services = await createServices();
  const app = createApp(services);

  app.listen(PORT, () => {
    console.log(`[backend] listening at http://localhost:${PORT}`);
  });
}

bootstrap().catch((error) => {
  console.error("[backend] failed to start", error);
  process.exitCode = 1;
});
