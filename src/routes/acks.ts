import { Router, Request, Response } from "express";
import { query } from "../db";
import { requireAdmin } from "../middleware/auth";
import { ackInfo, confirmAcks, runEscalations } from "../services/acks";

const router = Router();

// GET /api/acks/info?token=  (público — tela de confirmação aberta pelo link do WhatsApp)
router.get("/info", async (req: Request, res: Response) => {
  const token = String(req.query.token || "");
  if (!token) return res.status(400).json({ error: "Link inválido" });
  try {
    const info = await ackInfo(token);
    if (!info) return res.status(404).json({ error: "Link inválido ou expirado" });
    return res.json(info);
  } catch (error) {
    return res.status(500).json({ error: "Erro interno do servidor" });
  }
});

// POST /api/acks/confirm  { token }  (público — confirma todas as pendências da pessoa)
router.post("/confirm", async (req: Request, res: Response) => {
  const token = String(req.body.token || "");
  if (!token) return res.status(400).json({ error: "Link inválido" });
  try {
    const n = await confirmAcks(token);
    if (n === null) return res.status(404).json({ error: "Link inválido ou expirado" });
    return res.json({ success: true, confirmed: n });
  } catch (error) {
    return res.status(500).json({ error: "Erro interno do servidor" });
  }
});

// GET /api/acks?all=1  (admin — painel: uma linha por evento + ministério)
router.get("/", requireAdmin, async (req: Request, res: Response) => {
  try {
    const rows = await query(
      `SELECT a.event_id, a.ministry_id, e.title, e.starts_at, m.name AS ministry,
              MAX(a.confirmed_at) AS confirmed_at,
              (SELECT u.full_name FROM acknowledgements c JOIN users u ON u.id = c.user_id
                WHERE c.event_id = a.event_id AND c.ministry_id = a.ministry_id AND c.confirmed_at IS NOT NULL
                ORDER BY c.confirmed_at LIMIT 1) AS confirmed_by,
              MAX(a.level) AS level,
              MIN(a.sent_at) AS first_sent_at,
              MAX(a.deadline) AS deadline,
              json_agg(json_build_object('level', a.level, 'user', u.full_name, 'sent', a.sent, 'sent_at', a.sent_at,
                                         'deadline', a.deadline, 'confirmed_at', a.confirmed_at) ORDER BY a.level, a.sent_at) AS steps
         FROM acknowledgements a
         JOIN events e ON e.id = a.event_id
         JOIN ministries m ON m.id = a.ministry_id
         JOIN users u ON u.id = a.user_id
        WHERE ($1 OR e.starts_at > NOW() - INTERVAL '1 day')
        GROUP BY a.event_id, a.ministry_id, e.title, e.starts_at, m.name
        ORDER BY (MAX(a.confirmed_at) IS NULL) DESC, e.starts_at`,
      [req.query.all === "1"]
    );
    return res.json(rows);
  } catch (error) {
    return res.status(500).json({ error: "Erro interno do servidor" });
  }
});

// POST /api/acks/escalate  (admin — roda o escalonamento agora, sem esperar a próxima hora)
router.post("/escalate", requireAdmin, async (_req: Request, res: Response) => {
  try {
    return res.json(await runEscalations());
  } catch (error: any) {
    return res.status(500).json({ error: error.message });
  }
});

export default router;
