/**
 * Mensagens automáticas (só admin):
 *   GET   /api/notices         todas as mensagens que a plataforma envia sozinha, com quem recebe
 *   PATCH /api/notices/:key    { enabled?, recipients? }  liga/desliga e escolhe quem recebe (null = padrão)
 */
import { Router, Request, Response } from "express";
import { query } from "../db";
import { requireAdmin } from "../middleware/auth";
import { messageDef, messagesOverview, setMessageEnabled, setMessageRecipients } from "../services/messages";

const router = Router();
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const audit = (adminId: string, action: string, details: object) =>
  query(`INSERT INTO audit_logs (admin_id, action, target_type, details) VALUES ($1, $2, 'message', $3)`, [adminId, action, JSON.stringify(details)]);

/** Pessoas da equipe que podem receber (para escolher na tela) */
const teamPeople = () =>
  query<{ id: string; name: string; role: string; has_whatsapp: boolean }>(
    `SELECT id, COALESCE(full_name, email) AS name, role, whatsapp IS NOT NULL AS has_whatsapp
       FROM users WHERE role IN ('admin', 'agenda', 'viewer') ORDER BY COALESCE(full_name, email)`
  );

router.get("/", requireAdmin, async (_req: Request, res: Response) => {
  try {
    const [messages, people] = await Promise.all([messagesOverview(), teamPeople()]);
    return res.json({ messages, people });
  } catch (error) {
    console.error("Notices error:", error);
    return res.status(500).json({ error: "Erro interno do servidor" });
  }
});

router.patch("/:key", requireAdmin, async (req: Request, res: Response) => {
  const def = messageDef(req.params.key);
  if (!def) return res.status(404).json({ error: "Mensagem não encontrada" });
  const b = req.body || {};
  try {
    if (typeof b.enabled === "boolean") {
      if (def.essential && !b.enabled) return res.status(400).json({ error: "Esta mensagem não pode ser desligada: sem ela ninguém consegue entrar." });
      await setMessageEnabled(def.key, b.enabled, req.auth!.userId);
      await audit(req.auth!.userId, b.enabled ? "message_on" : "message_off", { key: def.key, title: def.title });
    }
    if ("recipients" in b) {
      if (!def.defaultRecipients) return res.status(400).json({ error: "Nesta mensagem quem recebe é definido pelo próprio envio" });
      let ids: string[] | null = null;
      if (Array.isArray(b.recipients)) {
        ids = [...new Set(b.recipients.filter((x: unknown) => typeof x === "string" && UUID_RE.test(x)))].slice(0, 50) as string[];
        const valid = await query<{ id: string }>("SELECT id FROM users WHERE id = ANY($1::uuid[]) AND role IN ('admin', 'agenda', 'viewer')", [ids]);
        ids = ids.filter((id) => valid.some((v) => v.id === id));
        if (!ids.length) return res.status(400).json({ error: "Escolha pelo menos uma pessoa (ou volte para o padrão)" });
      }
      await setMessageRecipients(def.key, ids, req.auth!.userId);
      await audit(req.auth!.userId, "message_recipients", { key: def.key, title: def.title, recipients: ids });
    }
    const all = await messagesOverview();
    return res.json(all.find((m) => m.key === def.key));
  } catch (error) {
    console.error("Notice update error:", error);
    return res.status(500).json({ error: "Erro interno do servidor" });
  }
});

export default router;
