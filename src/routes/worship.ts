/**
 * Músicas da escala do louvor (Holyrics):
 *   GET    /api/worship/summary?ids=a,b              quantas músicas cada culto tem (para os cartões da escala)
 *   GET    /api/worship/search?q=                    busca na biblioteca do Holyrics (só nome e artista)
 *   GET    /api/worship/events/:eventId              músicas do culto + situação no Holyrics
 *   POST   /api/worship/events/:eventId/songs        { holyrics_id, title, artist }  música da biblioteca
 *   POST   /api/worship/events/:eventId/songs/new    { title, artist }  cria no Holyrics só com o nome
 *   PUT    /api/worship/events/:eventId/order        { ids }  nova ordem (ids das músicas do culto)
 *   DELETE /api/worship/events/:eventId/songs/:id
 *   POST   /api/worship/events/:eventId/sync         tenta enviar de novo ao Holyrics
 *   POST   /api/worship/events/:eventId/adjusted     a Mídia ajustou à mão no Holyrics
 * Ver: toda a equipe. Alterar: admin e quem é da área Louvor.
 */
import { Router, Request, Response, NextFunction } from "express";
import { query, queryOne } from "../db";
import { requireRole } from "../middleware/auth";
import { rateLimit } from "../middleware/rateLimit";
import { holyricsConfigured, HolyricsError } from "../services/holyrics";
import {
  adjustments,
  createSong,
  hasLyrics,
  hasWorshipAccess,
  markAdjusted,
  notifyMediaLater,
  searchLibrary,
  syncEvent,
} from "../services/worship";
import { hasMediaAccess } from "../services/screenRequests";

const router = Router();
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_SONGS = 30;
const requireTeam = requireRole("admin", "agenda", "viewer");
const searchLimit = rateLimit(60, 60_000);

const str = (v: unknown, max: number) => (typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, max) : "");

/** Só admin e quem é da área Louvor */
const requireWorship = [
  requireTeam,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (await hasWorshipAccess(req.auth!.userId, req.auth!.role)) return next();
      return res.status(403).json({ error: "Só a equipe do louvor escolhe as músicas" });
    } catch {
      return res.status(500).json({ error: "Erro interno do servidor" });
    }
  },
];

/** O culto existe? (e o id é válido) */
async function eventOr404(req: Request, res: Response) {
  const id = req.params.eventId;
  if (!UUID_RE.test(id)) {
    res.status(404).json({ error: "Evento não encontrado" });
    return null;
  }
  const ev = await queryOne<{ id: string; title: string; starts_at: string }>("SELECT id, title, starts_at FROM events WHERE id = $1", [id]);
  if (!ev) res.status(404).json({ error: "Evento não encontrado" });
  return ev;
}

/** Resposta padrão: músicas, situação no Holyrics e o que a Mídia precisa ajustar */
async function payload(req: Request, event: { id: string; title: string; starts_at: string }) {
  const [songs, state, adjust, canEdit] = await Promise.all([
    query("SELECT id, holyrics_id, title, artist, lyrics_pending FROM event_songs WHERE event_id = $1 ORDER BY position, created_at", [event.id]),
    queryOne<{ holyrics_event_id: string | null; synced_at: string | null; sync_error: string | null; sent_songs: { id: string }[] }>(
      "SELECT holyrics_event_id, synced_at, sync_error, sent_songs FROM event_holyrics WHERE event_id = $1",
      [event.id]
    ),
    adjustments(event.id),
    hasWorshipAccess(req.auth!.userId, req.auth!.role),
  ]);
  const sent = new Set((state?.sent_songs || []).map((s) => s.id));
  return {
    event,
    can_edit: canEdit,
    holyrics_enabled: holyricsConfigured(),
    songs: songs.map((s: any) => ({ ...s, in_holyrics: sent.has(s.holyrics_id) })),
    sync: { synced_at: state?.synced_at || null, error: state?.sync_error || null, linked: !!state?.holyrics_event_id },
    adjust,
  };
}

/** Depois de mudar a lista: envia ao Holyrics (se estiver ligado) e responde com a situação atualizada */
async function afterChange(req: Request, res: Response, event: { id: string; title: string; starts_at: string }, status = 200) {
  if (holyricsConfigured()) await syncEvent(event.id);
  return res.status(status).json(await payload(req, event));
}

router.get("/summary", requireTeam, async (req: Request, res: Response) => {
  const ids = String(req.query.ids || "").split(",").filter((x) => UUID_RE.test(x)).slice(0, 200);
  if (!ids.length) return res.json([]);
  try {
    const rows = await query(
      `SELECT e.id AS event_id,
              (SELECT COUNT(*)::int FROM event_songs s WHERE s.event_id = e.id) AS count,
              h.sync_error IS NOT NULL AS has_error
         FROM events e LEFT JOIN event_holyrics h ON h.event_id = e.id
        WHERE e.id = ANY($1::uuid[])`,
      [ids]
    );
    return res.json(rows);
  } catch (error) {
    return res.status(500).json({ error: "Erro interno do servidor" });
  }
});

router.get("/search", requireWorship, searchLimit, async (req: Request, res: Response) => {
  const q = str(req.query.q, 80);
  if (q.length < 2) return res.json([]);
  try {
    return res.json(await searchLibrary(q));
  } catch (error) {
    if (error instanceof HolyricsError) return res.status(502).json({ error: error.message });
    console.error("Worship search error:", error);
    return res.status(500).json({ error: "Erro interno do servidor" });
  }
});

router.get("/events/:eventId", requireTeam, async (req: Request, res: Response) => {
  try {
    const event = await eventOr404(req, res);
    if (!event) return;
    // Músicas criadas só com o nome: confere se a Mídia já pôs a letra no Holyrics
    if (holyricsConfigured()) {
      const pending = await query<{ id: string; holyrics_id: string }>(
        "SELECT id, holyrics_id FROM event_songs WHERE event_id = $1 AND lyrics_pending LIMIT 10",
        [event.id]
      );
      for (const p of pending) {
        if (await hasLyrics(p.holyrics_id).catch(() => false)) {
          await query("UPDATE event_songs SET lyrics_pending = false WHERE holyrics_id = $1", [p.holyrics_id]);
        }
      }
    }
    return res.json(await payload(req, event));
  } catch (error) {
    console.error("Worship event error:", error);
    return res.status(500).json({ error: "Erro interno do servidor" });
  }
});

/** Põe a música no fim da lista do culto */
async function addSong(req: Request, res: Response, eventId: string, song: { id: string; title: string; artist: string }, pending: boolean) {
  const count = await queryOne<{ n: number; max: number }>(
    "SELECT COUNT(*)::int AS n, COALESCE(MAX(position), -1)::int AS max FROM event_songs WHERE event_id = $1",
    [eventId]
  );
  if (count!.n >= MAX_SONGS) {
    res.status(400).json({ error: `No máximo ${MAX_SONGS} músicas por culto` });
    return false;
  }
  const row = await queryOne(
    `INSERT INTO event_songs (event_id, position, holyrics_id, title, artist, lyrics_pending, added_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT (event_id, holyrics_id) DO NOTHING RETURNING id`,
    [eventId, count!.max + 1, song.id, song.title, song.artist || null, pending, req.auth!.userId]
  );
  if (!row) {
    res.status(409).json({ error: `"${song.title}" já está na lista deste culto` });
    return false;
  }
  return true;
}

router.post("/events/:eventId/songs", requireWorship, async (req: Request, res: Response) => {
  const holyricsId = str(req.body?.holyrics_id, 40);
  const title = str(req.body?.title, 200);
  if (!/^[0-9A-Za-z_-]{1,40}$/.test(holyricsId) || !title) return res.status(400).json({ error: "Música inválida" });
  try {
    const event = await eventOr404(req, res);
    if (!event) return;
    if (!(await addSong(req, res, event.id, { id: holyricsId, title, artist: str(req.body?.artist, 200) }, false))) return;
    return afterChange(req, res, event, 201);
  } catch (error) {
    console.error("Worship add error:", error);
    return res.status(500).json({ error: "Erro interno do servidor" });
  }
});

router.post("/events/:eventId/songs/new", requireWorship, async (req: Request, res: Response) => {
  const title = str(req.body?.title, 200);
  const artist = str(req.body?.artist, 200);
  if (title.length < 2) return res.status(400).json({ error: "Escreva o nome da música" });
  try {
    const event = await eventOr404(req, res);
    if (!event) return;
    if (!holyricsConfigured()) return res.status(400).json({ error: "O Holyrics ainda não está ligado à plataforma. Avise o administrador." });
    const song = await createSong(title, artist);
    if (!(await addSong(req, res, event.id, song, true))) return;
    return afterChange(req, res, event, 201);
  } catch (error) {
    if (error instanceof HolyricsError) return res.status(502).json({ error: error.message });
    console.error("Worship create error:", error);
    return res.status(500).json({ error: "Não foi possível criar a música no Holyrics" });
  }
});

router.put("/events/:eventId/order", requireWorship, async (req: Request, res: Response) => {
  const ids: string[] = (Array.isArray(req.body?.ids) ? req.body.ids : []).filter((x: unknown) => typeof x === "string" && UUID_RE.test(x));
  try {
    const event = await eventOr404(req, res);
    if (!event) return;
    await query(
      `UPDATE event_songs s SET position = o.pos - 1
         FROM unnest($2::uuid[]) WITH ORDINALITY AS o(id, pos)
        WHERE s.id = o.id AND s.event_id = $1`,
      [event.id, ids]
    );
    notifyMediaLater(event.id);
    return afterChange(req, res, event);
  } catch (error) {
    console.error("Worship order error:", error);
    return res.status(500).json({ error: "Erro interno do servidor" });
  }
});

router.delete("/events/:eventId/songs/:id", requireWorship, async (req: Request, res: Response) => {
  if (!UUID_RE.test(req.params.id)) return res.status(404).json({ error: "Música não encontrada" });
  try {
    const event = await eventOr404(req, res);
    if (!event) return;
    const row = await queryOne("DELETE FROM event_songs WHERE id = $1 AND event_id = $2 RETURNING id", [req.params.id, event.id]);
    if (!row) return res.status(404).json({ error: "Música não encontrada" });
    notifyMediaLater(event.id);
    return res.json(await payload(req, event));
  } catch (error) {
    console.error("Worship delete error:", error);
    return res.status(500).json({ error: "Erro interno do servidor" });
  }
});

router.post("/events/:eventId/sync", requireWorship, async (req: Request, res: Response) => {
  try {
    const event = await eventOr404(req, res);
    if (!event) return;
    return afterChange(req, res, event);
  } catch (error) {
    return res.status(500).json({ error: "Erro interno do servidor" });
  }
});

/** A Mídia (ou o louvor/admin) confirma que ajustou à mão no Holyrics */
router.post("/events/:eventId/adjusted", requireTeam, async (req: Request, res: Response) => {
  try {
    const event = await eventOr404(req, res);
    if (!event) return;
    const media = await hasMediaAccess(req.auth!.userId, req.auth!.role);
    if (!media && !(await hasWorshipAccess(req.auth!.userId, req.auth!.role))) {
      return res.status(403).json({ error: "Só a Mídia, o louvor ou o administrador confirmam o ajuste" });
    }
    await markAdjusted(event.id);
    return afterChange(req, res, event);
  } catch (error) {
    return res.status(500).json({ error: "Erro interno do servidor" });
  }
});

export default router;
