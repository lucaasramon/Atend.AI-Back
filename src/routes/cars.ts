/**
 * Placa de carro no telão (quem está na escala do dia e o admin):
 *   GET    /api/cars              chamadas de hoje + pedidos esperando a Mídia + se o telão está ligado
 *   POST   /api/cars/call         { plate }  pede para mostrar a placa no telão (a Mídia aprova; fica 1 minuto)
 *   POST   /api/cars/:id/stop     tira a placa do telão antes do tempo
 */
import { Router, Request, Response, NextFunction } from "express";
import { query, queryOne } from "../db";
import { requireRole } from "../middleware/auth";
import { rateLimit } from "../middleware/rateLimit";
import { holyricsConfigured, HolyricsError } from "../services/holyrics";
import { CALL_SECONDS, carsText, refreshScreenAlert } from "../services/screenAlert";
import { PLATE_RE, cleanPlate, servingToday } from "../services/cars";
import { TZ } from "../services/reminders";
import { REQUEST_SELECT, createRequest, expireOld } from "../services/screenRequests";

const router = Router();
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const callLimit = rateLimit(30, 60_000);

/** Só quem está na escala de hoje (ou o admin); guarda o evento do dia em res.locals.eventId */
const requireServing = [
  requireRole("admin", "agenda", "viewer"),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const eventId = await servingToday(req.auth!.userId, req.auth!.role);
      if (eventId === null) return res.status(403).json({ error: "Esta tela é para quem está na escala de hoje" });
      res.locals.eventId = eventId || null;
      return next();
    } catch {
      return res.status(500).json({ error: "Erro interno do servidor" });
    }
  },
];

const SELECT = `
  SELECT c.id, c.plate, c.called_at, u.full_name AS called_by_name,
         CASE WHEN c.stopped_at IS NULL AND c.called_at > NOW() - make_interval(secs => ${CALL_SECONDS})
              THEN CEIL(EXTRACT(EPOCH FROM (c.called_at + make_interval(secs => ${CALL_SECONDS}) - NOW())))::int END AS calling_left_sec
    FROM car_calls c
    LEFT JOIN users u ON u.id = c.called_by`;

function screenError(res: Response, error: unknown) {
  if (error instanceof HolyricsError) return res.status(502).json({ error: error.message });
  console.error("Cars screen error:", error);
  return res.status(500).json({ error: "Erro interno do servidor" });
}

router.get("/", requireServing, async (_req: Request, res: Response) => {
  try {
    await expireOld();
    const [calls, requests] = await Promise.all([
      query(
        `${SELECT} WHERE (c.called_at AT TIME ZONE '${TZ}')::date = (NOW() AT TIME ZONE '${TZ}')::date
          ORDER BY c.called_at DESC LIMIT 50`
      ),
      // Pedidos que ainda esperam a Mídia, ou que não foram (recusado, expirado...) nos últimos 10 minutos
      query(
        `${REQUEST_SELECT} WHERE r.kind = 'car' AND r.status <> 'approved' AND r.requested_at > NOW() - INTERVAL '10 minutes'
          ORDER BY r.requested_at DESC`
      ),
    ]);
    return res.json({ calls, requests, screen_enabled: holyricsConfigured(), call_seconds: CALL_SECONDS });
  } catch (error) {
    return res.status(500).json({ error: "Erro interno do servidor" });
  }
});

router.post("/call", requireServing, callLimit, async (req: Request, res: Response) => {
  const plate = cleanPlate(req.body?.plate);
  if (!PLATE_RE.test(plate)) {
    return res.status(400).json({ error: "Confira a placa: 3 letras e 4 números (ex.: ABC-1234 ou ABC1D23)" });
  }
  try {
    // Não vai direto: vira um pedido para a Mídia aprovar (a chamada é registrada quando aprovar)
    const request = await createRequest({ kind: "car", text: carsText([plate]), payload: { plate, event_id: res.locals.eventId }, userId: req.auth!.userId });
    return res.status(201).json({ request, screen_text: carsText([plate]) });
  } catch (error) {
    return screenError(res, error);
  }
});

router.post("/:id/stop", requireServing, callLimit, async (req: Request, res: Response) => {
  if (!UUID_RE.test(req.params.id)) return res.status(404).json({ error: "Chamada não encontrada" });
  try {
    const row = await queryOne("UPDATE car_calls SET stopped_at = NOW() WHERE id = $1 AND stopped_at IS NULL RETURNING id", [req.params.id]);
    if (!row) return res.status(404).json({ error: "Essa placa já saiu do telão" });
    await refreshScreenAlert();
    return res.json({ call: await queryOne(`${SELECT} WHERE c.id = $1`, [req.params.id]) });
  } catch (error) {
    return screenError(res, error);
  }
});

export default router;
