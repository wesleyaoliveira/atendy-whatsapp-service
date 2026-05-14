import "dotenv/config";
import express from "express";
import pino from "pino";
import { ensureSchema } from "./db.js";
import { restoreAllSessions, sessionsRouter } from "./sessions.js";

const log = pino({ level: process.env.LOG_LEVEL ?? "info" });
const PORT = Number(process.env.PORT ?? 3000);
const TOKEN = process.env.SERVICE_TOKEN;

if (!TOKEN) {
  log.error("SERVICE_TOKEN env var is required");
  process.exit(1);
}

const app = express();
app.use(express.json({ limit: "10mb" }));

app.get("/health", (_req, res) => res.json({ ok: true }));

// Bearer auth for everything else
app.use((req, res, next) => {
  const auth = req.headers.authorization;
  if (!auth || auth !== `Bearer ${TOKEN}`) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
});

app.use("/sessions", sessionsRouter);

app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  log.error({ err }, "request error");
  res.status(500).json({ error: err.message });
});

(async () => {
  await ensureSchema();
  await restoreAllSessions();
  app.listen(PORT, () => log.info(`atendy-whatsapp-service listening on :${PORT}`));
})().catch((e) => {
  log.error({ err: e }, "fatal startup");
  process.exit(1);
});
