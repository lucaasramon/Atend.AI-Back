/**
 * Pedidos para o telão (aprovação da Mídia):
 *   GET    /api/screen/pending              pedidos esperando (Mídia; a tela consulta a cada poucos segundos)
 *   GET    /api/screen/today                pedidos de hoje (Mídia)
 *   GET    /api/screen/requests/:id         situação de um pedido (quem pediu ou a Mídia)
 *   POST   /api/screen/requests/:id/approve (Mídia) aprova e manda para o Holyrics
 *   POST   /api/screen/requests/:id/reject  (Mídia)
 *   DELETE /api/screen/requests/:id         quem pediu cancela enquanto espera
 */
import { Router, Request, Response, NextFunction } from "express";
import { query, queryOne } from "../db";
import { requireRole } from "../middleware/auth";
import { TZ } from "../services/reminders";
import { REQUEST_SELECT, approve, cancelPending, expireOld, hasMediaAccess, reject } from "../services/screenRequests";

const router = Router();
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const requireTeam = requireRole("admin", "agenda", "viewer");

const requireMedia = [
  requireTeam,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (await hasMediaAccess(req.auth!.userId, req.auth!.role)) return next();
      return res.status(403).json({ error: "Só a equipe da Mídia aprova o que vai para o telão" });
    } catch {
      return res.status(500).json({ error: "Erro interno do servidor" });
    }
  },
];

router.get("/pending", requireMedia, async (_req: Request, res: Response) => {
  try {
    await expireOld();
    return res.json(await query(`${REQUEST_SELECT} WHERE r.status = 'pending' ORDER BY r.requested_at`));
  } catch (error) {
    return res.status(500).json({ error: "Erro interno do servidor" });
  }
});

router.get("/today", requireMedia, async (_req: Request, res: Response) => {
  try {
    await expireOld();
    return res.json(
      await query(
        `${REQUEST_SELECT} WHERE (r.requested_at AT TIME ZONE '${TZ}')::date = (NOW() AT TIME ZONE '${TZ}')::date
          ORDER BY r.requested_at DESC LIMIT 100`
      )
    );
  } catch (error) {
    return res.status(500).json({ error: "Erro interno do servidor" });
  }
});

router.get("/requests/:id", requireTeam, async (req: Request, res: Response) => {
  if (!UUID_RE.test(req.params.id)) return res.status(404).json({ error: "Pedido não encontrado" });
  try {
    await expireOld();
    const r = await queryOne<any>(`${REQUEST_SELECT} WHERE r.id = $1`, [req.params.id]);
    if (!r) return res.status(404).json({ error: "Pedido não encontrado" });
    const mine = (await queryOne("SELECT 1 FROM screen_requests WHERE id = $1 AND requested_by = $2", [r.id, req.auth!.userId])) !== null;
    if (!mine && !(await hasMediaAccess(req.auth!.userId, req.auth!.role))) return res.status(404).json({ error: "Pedido não encontrado" });
    return res.json(r);
  } catch (error) {
    return res.status(500).json({ error: "Erro interno do servidor" });
  }
});

router.post("/requests/:id/approve", requireMedia, async (req: Request, res: Response) => {
  if (!UUID_RE.test(req.params.id)) return res.status(404).json({ error: "Pedido não encontrado" });
  try {
    const r = await approve(req.params.id, req.auth!.userId);
    const now = await queryOne<any>(`${REQUEST_SELECT} WHERE r.id = $1`, [req.params.id]);
    if (!r) {
      const why = now?.status === "approved" ? `${now.decided_by_name || "Outra pessoa da Mídia"} já aprovou`
        : now?.status === "rejected" ? `${now.decided_by_name || "Outra pessoa da Mídia"} já recusou`
        : now?.status === "cancelled" ? "Quem pediu cancelou"
        : "O pedido expirou";
      return res.status(409).json({ error: why, request: now });
    }
    if (r.status === "failed") return res.status(502).json({ error: r.error || "O Holyrics não mostrou", request: now });
    return res.json(now);
  } catch (error) {
    console.error("Screen approve error:", error);
    return res.status(500).json({ error: "Erro interno do servidor" });
  }
});

router.post("/requests/:id/reject", requireMedia, async (req: Request, res: Response) => {
  if (!UUID_RE.test(req.params.id)) return res.status(404).json({ error: "Pedido não encontrado" });
  try {
    const r = await reject(req.params.id, req.auth!.userId);
    const now = await queryOne<any>(`${REQUEST_SELECT} WHERE r.id = $1`, [req.params.id]);
    if (!r) return res.status(409).json({ error: "Esse pedido já foi respondido", request: now });
    return res.json(now);
  } catch (error) {
    return res.status(500).json({ error: "Erro interno do servidor" });
  }
});

router.delete("/requests/:id", requireTeam, async (req: Request, res: Response) => {
  if (!UUID_RE.test(req.params.id)) return res.status(404).json({ error: "Pedido não encontrado" });
  try {
    await cancelPending({ id: req.params.id, userId: req.auth!.userId });
    return res.json(await queryOne(`${REQUEST_SELECT} WHERE r.id = $1`, [req.params.id]));
  } catch (error) {
    return res.status(500).json({ error: "Erro interno do servidor" });
  }
});

export default router;
