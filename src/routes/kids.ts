/**
 * Sala das crianças (professoras e admin):
 *   GET    /api/kids/events                          eventos de ontem até as próximas 2 semanas
 *   GET    /api/kids/events/:eventId/children        crianças registradas no evento
 *   POST   /api/kids/events/:eventId/children        { name, code? }  código automático se não vier
 *   PUT    /api/kids/children/:id                    { name, code }
 *   DELETE /api/kids/children/:id
 *   POST   /api/kids/children/:id/call               pede para chamar o responsável no telão (a Mídia aprova; só o código aparece)
 *   DELETE /api/kids/children/:id/call               para de chamar (ou cancela o pedido que ainda espera a Mídia)
 */
import { Router, Request, Response, NextFunction } from "express";
import { query, queryOne } from "../db";
import { requireRole } from "../middleware/auth";
import { rateLimit } from "../middleware/rateLimit";
import { holyricsConfigured, HolyricsError } from "../services/holyrics";
import { CALL_SECONDS, callText, hasKidsAccess, refreshScreenCall } from "../services/kids";
import { cancelPending, createRequest, expireOld } from "../services/screenRequests";

const router = Router();
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CODE_RE = /^[A-Z0-9]{1,6}$/;
const callLimit = rateLimit(40, 60_000);

/** Só admin e quem é da área das crianças */
const requireKids = [
  requireRole("admin", "agenda", "viewer"),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (await hasKidsAccess(req.auth!.userId, req.auth!.role)) return next();
      return res.status(403).json({ error: "Esta tela é só para a equipe das crianças" });
    } catch {
      return res.status(500).json({ error: "Erro interno do servidor" });
    }
  },
];

const cleanName = (v: unknown) => (typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, 80) : "");
const cleanCode = (v: unknown) => (typeof v === "string" || typeof v === "number" ? String(v).trim().toUpperCase() : "");

const CHILD_COLUMNS = `
  k.id, k.event_id, k.code, k.child_name, k.call_count,
  CASE WHEN k.called_at > NOW() - make_interval(secs => ${CALL_SECONDS}) THEN k.called_at END AS calling_since,
  CASE WHEN k.called_at > NOW() - make_interval(secs => ${CALL_SECONDS})
       THEN CEIL(EXTRACT(EPOCH FROM (k.called_at + make_interval(secs => ${CALL_SECONDS}) - NOW())))::int END AS calling_left_sec,
  -- Último pedido para o telão (esperando a Mídia, recusado, expirado...) dos últimos 10 minutos
  (SELECT json_build_object('id', r.id, 'status', r.status, 'error', r.error, 'requested_at', r.requested_at, 'decided_by', d.full_name)
     FROM screen_requests r LEFT JOIN users d ON d.id = r.decided_by
    WHERE r.kind = 'kid' AND r.ref_id = k.id AND r.requested_at > NOW() - INTERVAL '10 minutes'
    ORDER BY r.requested_at DESC LIMIT 1) AS request`;

const listChildren = (eventId: string) =>
  query(
    `SELECT ${CHILD_COLUMNS} FROM kids_checkins k WHERE k.event_id = $1
      ORDER BY (k.code ~ '^[0-9]+$') DESC, CASE WHEN k.code ~ '^[0-9]+$' THEN k.code::int END, k.code`,
    [eventId]
  );

const getChild = (id: string) => queryOne<any>(`SELECT ${CHILD_COLUMNS} FROM kids_checkins k WHERE k.id = $1`, [id]);

/** Mensagem para quando o código já é de outra criança */
async function codeTaken(eventId: string, code: string, exceptId?: string) {
  const other = await queryOne<{ child_name: string }>(
    "SELECT child_name FROM kids_checkins WHERE event_id = $1 AND code = $2 AND ($3::uuid IS NULL OR id <> $3)",
    [eventId, code, exceptId || null]
  );
  return other ? `O código ${code} já é de ${other.child_name}. Escolha outro.` : null;
}

function screenError(res: Response, error: unknown) {
  if (error instanceof HolyricsError) return res.status(502).json({ error: error.message });
  console.error("Kids screen error:", error);
  return res.status(500).json({ error: "Erro interno do servidor" });
}

router.get("/events", requireKids, async (_req: Request, res: Response) => {
  try {
    const events = await query(
      `SELECT e.id, e.title, e.starts_at, e.ends_at,
              (SELECT COUNT(*)::int FROM kids_checkins k WHERE k.event_id = e.id) AS children_count
         FROM events e
        WHERE e.status <> 'rejected'
          AND e.starts_at >= NOW() - INTERVAL '1 day'
          AND e.starts_at <= NOW() + INTERVAL '14 days'
        ORDER BY e.starts_at`
    );
    return res.json({ events, screen_enabled: holyricsConfigured(), call_seconds: CALL_SECONDS });
  } catch (error) {
    return res.status(500).json({ error: "Erro interno do servidor" });
  }
});

router.get("/events/:eventId/children", requireKids, async (req: Request, res: Response) => {
  if (!UUID_RE.test(req.params.eventId)) return res.status(404).json({ error: "Evento não encontrado" });
  try {
    await expireOld();
    return res.json(await listChildren(req.params.eventId));
  } catch (error) {
    return res.status(500).json({ error: "Erro interno do servidor" });
  }
});

router.post("/events/:eventId/children", requireKids, async (req: Request, res: Response) => {
  const eventId = req.params.eventId;
  const name = cleanName(req.body?.name);
  let code = cleanCode(req.body?.code);
  if (!UUID_RE.test(eventId)) return res.status(404).json({ error: "Evento não encontrado" });
  if (name.length < 2) return res.status(400).json({ error: "Escreva o nome da criança" });
  if (code && !CODE_RE.test(code)) return res.status(400).json({ error: "O código pode ter só números e letras, até 6" });
  try {
    if (!(await queryOne("SELECT 1 FROM events WHERE id = $1", [eventId]))) return res.status(404).json({ error: "Evento não encontrado" });
    if (code) {
      const taken = await codeTaken(eventId, code);
      if (taken) return res.status(409).json({ error: taken });
    }
    // Código automático: o próximo número livre (tenta de novo se outra professora pegou o mesmo ao mesmo tempo)
    for (let attempt = 0; attempt < 3; attempt++) {
      const auto = !code;
      if (auto) {
        const next = await queryOne<{ n: number }>(
          "SELECT COALESCE(MAX(code::int), 0) + 1 AS n FROM kids_checkins WHERE event_id = $1 AND code ~ '^[0-9]{1,6}$'",
          [eventId]
        );
        code = String(next!.n);
      }
      try {
        const row = await queryOne<{ id: string }>(
          "INSERT INTO kids_checkins (event_id, code, child_name, created_by) VALUES ($1, $2, $3, $4) RETURNING id",
          [eventId, code, name, req.auth!.userId]
        );
        return res.status(201).json(await getChild(row!.id));
      } catch (e: any) {
        if (e.code !== "23505") throw e;
        if (!auto) return res.status(409).json({ error: (await codeTaken(eventId, code)) || "Esse código já está em uso" });
        code = "";
      }
    }
    return res.status(409).json({ error: "Não foi possível gerar o código. Tente de novo." });
  } catch (error) {
    console.error("Kids add error:", error);
    return res.status(500).json({ error: "Erro interno do servidor" });
  }
});

router.put("/children/:id", requireKids, async (req: Request, res: Response) => {
  const name = cleanName(req.body?.name);
  const code = cleanCode(req.body?.code);
  if (!UUID_RE.test(req.params.id)) return res.status(404).json({ error: "Criança não encontrada" });
  if (name.length < 2) return res.status(400).json({ error: "Escreva o nome da criança" });
  if (!CODE_RE.test(code)) return res.status(400).json({ error: "O código pode ter só números e letras, até 6" });
  try {
    const child = await getChild(req.params.id);
    if (!child) return res.status(404).json({ error: "Criança não encontrada" });
    const taken = await codeTaken(child.event_id, code, child.id);
    if (taken) return res.status(409).json({ error: taken });
    await query("UPDATE kids_checkins SET child_name = $1, code = $2, updated_at = NOW() WHERE id = $3", [name, code, child.id]);
    // Se estava chamando com o código antigo, o telão passa a mostrar o novo
    if (child.calling_since && child.code !== code) await refreshScreenCall().catch(() => {});
    return res.json(await getChild(child.id));
  } catch (error) {
    console.error("Kids edit error:", error);
    return res.status(500).json({ error: "Erro interno do servidor" });
  }
});

router.delete("/children/:id", requireKids, async (req: Request, res: Response) => {
  if (!UUID_RE.test(req.params.id)) return res.status(404).json({ error: "Criança não encontrada" });
  try {
    const row = await queryOne<{ calling: boolean }>(
      `DELETE FROM kids_checkins WHERE id = $1
        RETURNING (called_at > NOW() - make_interval(secs => ${CALL_SECONDS})) AS calling`,
      [req.params.id]
    );
    if (!row) return res.status(404).json({ error: "Criança não encontrada" });
    if (row.calling) await refreshScreenCall().catch(() => {});
    return res.json({ success: true });
  } catch (error) {
    return res.status(500).json({ error: "Erro interno do servidor" });
  }
});

router.post("/children/:id/call", requireKids, callLimit, async (req: Request, res: Response) => {
  if (!UUID_RE.test(req.params.id)) return res.status(404).json({ error: "Criança não encontrada" });
  try {
    const child = await getChild(req.params.id);
    if (!child) return res.status(404).json({ error: "Criança não encontrada" });
    // Não vai direto: vira um pedido para a Mídia aprovar
    await createRequest({ kind: "kid", text: callText([child.code]), refId: child.id, userId: req.auth!.userId });
    return res.json({ child: await getChild(child.id), screen_text: callText([child.code]) });
  } catch (error) {
    return screenError(res, error);
  }
});

router.delete("/children/:id/call", requireKids, callLimit, async (req: Request, res: Response) => {
  if (!UUID_RE.test(req.params.id)) return res.status(404).json({ error: "Criança não encontrada" });
  try {
    await cancelPending({ kind: "kid", refId: req.params.id });
    const row = await queryOne<{ was: string | null }>(
      "UPDATE kids_checkins k SET called_at = NULL FROM (SELECT called_at AS was FROM kids_checkins WHERE id = $1) o WHERE k.id = $1 RETURNING o.was",
      [req.params.id]
    );
    if (!row) return res.status(404).json({ error: "Criança não encontrada" });
    if (row.was) await refreshScreenCall();
    return res.json({ child: await getChild(req.params.id) });
  } catch (error) {
    return screenError(res, error);
  }
});

export default router;
