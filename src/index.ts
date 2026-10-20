import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import fs from "fs";
import path from "path";

dotenv.config();

import authRoutes from "./routes/auth";
import profileRoutes from "./routes/profiles";
import leadRoutes from "./routes/leads";
import messageRoutes from "./routes/messages";
import robotRoutes from "./routes/robot";
import notificationRoutes from "./routes/notifications";
import knowledgeRoutes from "./routes/knowledge";
import templateRoutes from "./routes/templates";
import settingsRoutes from "./routes/settings";
import auditRoutes from "./routes/audit";
import billingRoutes from "./routes/billing";
import evolutionRoutes from "./routes/evolution";
import aiRoutes from "./routes/ai";
import webhookRoutes from "./routes/webhook";
import eventRoutes from "./routes/events";
import userRoutes from "./routes/users";
import ministryRoutes from "./routes/ministries";
import locationRoutes from "./routes/locations";
import eventTaskRoutes from "./routes/eventTasks";
import popRoutes from "./routes/pops";
import mediaRoutes from "./routes/media";
import ackRoutes from "./routes/acks";
import { areasRouter, eventRosterRouter, membersRouter, publicRosterRouter } from "./routes/roster";
import { eventFormsRouter, peopleRouter, publicFormsRouter } from "./routes/forms";
import sermonRoutes from "./routes/sermons";
import homeRoutes from "./routes/home";
import { startScheduler } from "./services/scheduler";

const app = express();
const PORT = process.env.PORT || 3001;

// Versão do package.json (fica em /app/package.json no container e na raiz em dev)
const VERSION: string = JSON.parse(
  fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf8")
).version;

// Webhook da Stripe precisa do raw body ANTES do express.json()
app.use("/api/billing/webhook", express.raw({ type: "application/json" }));

app.use(cors({
  origin: (origin, callback) => {
    // Allow requests with no origin (mobile apps, curl, etc.)
    if (!origin) return callback(null, true);
    // Allow any localhost port in development
    if (/^http:\/\/localhost(:\d+)?$/.test(origin)) return callback(null, true);
    // Allow configured frontend URL(s) in production (separadas por vírgula)
    const allowed = (process.env.FRONTEND_URL || "").split(",").map((u) => u.trim().replace(/\/$/, ""));
    if (allowed.includes(origin)) return callback(null, true);
    callback(new Error("Not allowed by CORS"));
  },
  credentials: true,
}));
app.use(express.json({ limit: "10mb" }));

app.use("/api/auth", authRoutes);
app.use("/api/profiles", profileRoutes);
app.use("/api/leads", leadRoutes);
app.use("/api/messages", messageRoutes);
app.use("/api/robot", robotRoutes);
app.use("/api/notifications", notificationRoutes);
app.use("/api/knowledge", knowledgeRoutes);
app.use("/api/templates", templateRoutes);
app.use("/api/settings", settingsRoutes);
app.use("/api/audit", auditRoutes);
app.use("/api/billing", billingRoutes);
app.use("/api/evolution", evolutionRoutes);
app.use("/api/ai", aiRoutes);
app.use("/api/webhook", webhookRoutes);
app.use("/api/events", eventFormsRouter); // /forms e /:eventId/form (antes de eventRoutes)
app.use("/api/events", eventRosterRouter);
app.use("/api/events", eventTaskRoutes); // antes de eventRoutes (rotas /tasks, /people...)
app.use("/api/events", eventRoutes);
app.use("/api/pops", popRoutes);
app.use("/api/media", mediaRoutes);
app.use("/api/acks", ackRoutes);
app.use("/api/members", membersRouter);
app.use("/api/areas", areasRouter);
app.use("/api/roster", publicRosterRouter);
app.use("/api/public", publicFormsRouter); // formulários públicos (cadastro e inscrições)
app.use("/api/people", peopleRouter);
app.use("/api/sermons", sermonRoutes);
app.use("/api/home", homeRoutes);
app.use("/api/users", userRoutes);
app.use("/api/ministries", ministryRoutes);
app.use("/api/locations", locationRoutes);

app.get("/api/health", (_req, res) => {
  res.json({ status: "ok", version: VERSION, timestamp: new Date().toISOString() });
});

app.listen(PORT, () => {
  console.log(`Backend v${VERSION} rodando na porta ${PORT}`);
  startScheduler();
});

export default app;
