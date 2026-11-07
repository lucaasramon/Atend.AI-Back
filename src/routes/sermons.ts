/**
 * Pregações: esboço em blocos (introdução, pontos, ilustração, apelo...) com versículos,
 * usado no painel do púlpito.
 * Quem vê: quem criou e o(s) líder(es) do ministério de Mídia (para preparar a projeção).
 * Quem edita: só quem criou.
 */
import crypto from "crypto";
import { Router, Request, Response } from "express";
import { query, queryOne } from "../db";
import { requireRole } from "../middleware/auth";
import { rateLimit } from "../middleware/rateLimit";
import { holyrics, holyricsConfigured, HolyricsError } from "../services/holyrics";
import { cancelPending, createRequest } from "../services/screenRequests";
import { importSermon, SermonImportError } from "../services/sermonImport";

const router = Router();
/** Toques no telão: folga para o culto, mas segura cliques repetidos sem fim */
const screenLimit = rateLimit(40, 60_000);
/** Importar arquivo usa a IA (custo): alguns por hora já bastam */
const importLimit = rateLimit(15, 60 * 60_000);
const requireTeam = requireRole("admin", "agenda", "viewer");

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const KINDS = ["intro", "point", "illustration", "appeal", "conclusion", "free"] as const;
const str = (v: unknown, max: number) => (typeof v === "string" ? v.slice(0, max) : "");

interface Block {
  id: string;
  kind: (typeof KINDS)[number];
  title: string;
  text: string;
  notes: string;
  minutes: number;
  verses: { ref: string; text: string }[];
  /** Frases que o pastor quer na projeção (telão) */
  phrases: string[];
}

/** Limpa os blocos vindos da tela */
function cleanBlocks(raw: unknown): Block[] {
  if (!Array.isArray(raw)) return [];
  return raw.slice(0, 40).map((b: any) => ({
    id: /^[a-z0-9_-]{1,40}$/i.test(b?.id || "") ? b.id : crypto.randomBytes(4).toString("hex"),
    kind: KINDS.includes(b?.kind) ? b.kind : "free",
    title: str(b?.title, 150).trim(),
    text: str(b?.text, 8000),
    notes: str(b?.notes, 4000),
    minutes: Math.min(240, Math.max(0, Math.round((Number(b?.minutes) || 0) * 2) / 2)),
    verses: (Array.isArray(b?.verses) ? b.verses : [])
      .slice(0, 30)
      .map((v: any) => ({ ref: str(v?.ref, 60).trim(), text: str(v?.text, 3000) }))
      .filter((v: { ref: string; text: string }) => v.ref || v.text.trim()),
    phrases: (Array.isArray(b?.phrases) ? b.phrases : [])
      .slice(0, 30)
      .map((p: unknown) => str(p, 600))
      .filter((p: string) => p.trim()),
  }));
}

/** Líder de algum ministério de Mídia: vê todas as pregações */
async function isMediaLeader(userId: string): Promise<boolean> {
  return !!(await queryOne("SELECT 1 FROM ministries WHERE is_media AND leader_id = $1 LIMIT 1", [userId]));
}

const SELECT = `
  SELECT s.*, u.full_name AS author_name, e.title AS event_title, e.starts_at AS event_starts_at
    FROM sermons s
    JOIN users u ON u.id = s.author_id
    LEFT JOIN events e ON e.id = s.event_id`;

/** Pregação que a pessoa pode ver (ou null) */
async function visible(req: Request, id: string) {
  if (!UUID_RE.test(id)) return null;
  const s = await queryOne<any>(`${SELECT} WHERE s.id = $1`, [id]);
  if (!s) return null;
  const mine = s.author_id === req.auth!.userId;
  if (!mine && !(await isMediaLeader(req.auth!.userId))) return null;
  return { ...s, can_edit: mine, screen_enabled: holyricsConfigured() };
}

// GET /api/sermons  (as minhas; o líder da Mídia vê as de todos)
router.get("/", requireTeam, async (req: Request, res: Response) => {
  try {
    const media = await isMediaLeader(req.auth!.userId);
    const rows = await query<any>(
      `${SELECT} WHERE ($2::boolean OR s.author_id = $1)
        ORDER BY (s.preached_at IS NOT NULL), COALESCE(e.starts_at, s.preached_at, s.updated_at) DESC`,
      [req.auth!.userId, media]
    );
    return res.json({
      media_leader: media,
      sermons: rows.map((s) => ({ ...s, can_edit: s.author_id === req.auth!.userId })),
    });
  } catch (error) {
    return res.status(500).json({ error: "Erro interno do servidor" });
  }
});

router.get("/:id", requireTeam, async (req: Request, res: Response) => {
  try {
    const s = await visible(req, req.params.id);
    return s ? res.json(s) : res.status(404).json({ error: "Pregação não encontrada" });
  } catch (error) {
    return res.status(500).json({ error: "Erro interno do servidor" });
  }
});

function body(req: Request) {
  const b = req.body || {};
  return {
    title: str(b.title, 200).trim(),
    bible_text: str(b.bible_text, 200).trim() || null,
    event_id: UUID_RE.test(b.event_id || "") ? b.event_id : null,
    blocks: cleanBlocks(b.blocks),
  };
}

router.post("/", requireTeam, async (req: Request, res: Response) => {
  const b = body(req);
  if (!b.title) return res.status(400).json({ error: "Dê um título à pregação" });
  try {
    const row = await queryOne<{ id: string }>(
      "INSERT INTO sermons (author_id, title, bible_text, event_id, blocks) VALUES ($1, $2, $3, $4, $5) RETURNING id",
      [req.auth!.userId, b.title, b.bible_text, b.event_id, JSON.stringify(b.blocks)]
    );
    return res.status(201).json(await visible(req, row!.id));
  } catch (error) {
    console.error("Create sermon error:", error);
    return res.status(400).json({ error: "Dados inválidos" });
  }
});

router.put("/:id", requireTeam, async (req: Request, res: Response) => {
  const b = body(req);
  if (!b.title) return res.status(400).json({ error: "Dê um título à pregação" });
  try {
    const row = await queryOne(
      `UPDATE sermons SET title = $1, bible_text = $2, event_id = $3, blocks = $4, updated_at = NOW()
        WHERE id = $5 AND author_id = $6 RETURNING id`,
      [b.title, b.bible_text, b.event_id, JSON.stringify(b.blocks), req.params.id, req.auth!.userId]
    );
    if (!row) return res.status(404).json({ error: "Só quem criou a pregação pode alterar" });
    return res.json(await visible(req, req.params.id));
  } catch (error) {
    console.error("Update sermon error:", error);
    return res.status(400).json({ error: "Dados inválidos" });
  }
});

// POST /api/sermons/import  { filename, data (base64), event_id? }
// A IA lê o arquivo (PDF, Word, PowerPoint, foto...) e cria a pregação já em blocos.
router.post("/import", requireTeam, importLimit, async (req: Request, res: Response) => {
  const filename = str(req.body?.filename, 200).trim() || "pregacao";
  const data = typeof req.body?.data === "string" ? req.body.data.replace(/^data:[^,]*,/, "") : "";
  if (!data) return res.status(400).json({ error: "Envie o arquivo da pregação" });
  try {
    const imported = await importSermon(filename, Buffer.from(data, "base64"));
    const blocks = cleanBlocks(imported.blocks);
    const event_id = UUID_RE.test(req.body?.event_id || "") ? req.body.event_id : null;
    const row = await queryOne<{ id: string }>(
      "INSERT INTO sermons (author_id, title, bible_text, event_id, blocks) VALUES ($1, $2, $3, $4, $5) RETURNING id",
      [req.auth!.userId, imported.title.slice(0, 200), imported.bible_text.slice(0, 200) || null, event_id, JSON.stringify(blocks)]
    );
    return res.status(201).json({
      sermon: await visible(req, row!.id),
      summary: {
        blocks: blocks.length,
        verses: blocks.reduce((n, b) => n + b.verses.length, 0),
        phrases: blocks.reduce((n, b) => n + b.phrases.length, 0),
        projection_markers: imported.projection_markers,
        dropped_phrases: imported.dropped_phrases,
      },
    });
  } catch (error) {
    if (error instanceof SermonImportError) return res.status(error.status).json({ error: error.message });
    console.error("Import sermon error:", error);
    return res.status(500).json({ error: "Erro interno do servidor" });
  }
});

// POST /api/sermons/:id/preached  { started_at, ended_at, block_times: [{id, seconds}] }  (painel do púlpito)
router.post("/:id/preached", requireTeam, async (req: Request, res: Response) => {
  const started = new Date(req.body?.started_at);
  const ended = new Date(req.body?.ended_at);
  if (isNaN(started.getTime()) || isNaN(ended.getTime()) || ended < started) {
    return res.status(400).json({ error: "Horários inválidos" });
  }
  const times = (Array.isArray(req.body?.block_times) ? req.body.block_times : [])
    .slice(0, 40)
    .map((t: any) => ({ id: str(t?.id, 40), seconds: Math.max(0, Math.round(Number(t?.seconds) || 0)) }));
  const duration = times.reduce((n: number, t: { seconds: number }) => n + t.seconds, 0);
  try {
    const row = await queryOne(
      `UPDATE sermons SET preached_at = $1, duration_sec = $2, block_times = $3, updated_at = NOW()
        WHERE id = $4 AND author_id = $5 RETURNING id`,
      [started, duration, JSON.stringify(times), req.params.id, req.auth!.userId]
    );
    if (!row) return res.status(404).json({ error: "Pregação não encontrada" });
    return res.json(await visible(req, req.params.id));
  } catch (error) {
    return res.status(400).json({ error: "Pregação inválida" });
  }
});

/** Resposta para erros do telão: mensagem pronta para o pastor */
function screenError(res: Response, error: unknown) {
  if (error instanceof HolyricsError) return res.status(502).json({ error: error.message });
  console.error("Sermon screen error:", error);
  return res.status(500).json({ error: "Erro interno do servidor" });
}

// POST /api/sermons/:id/screen  { text }  pede para mostrar a frase no telão (a Mídia aprova)
// Só vai frase salva da pregação: ninguém manda texto solto para o telão.
router.post("/:id/screen", requireTeam, screenLimit, async (req: Request, res: Response) => {
  const text = str(req.body?.text, 600).trim();
  if (!text) return res.status(400).json({ error: "Frase vazia" });
  try {
    const s = await visible(req, req.params.id);
    if (!s) return res.status(404).json({ error: "Pregação não encontrada" });
    const saved = (s.blocks as Block[]).some((b) => (b.phrases || []).some((p) => p.trim() === text));
    if (!saved) return res.status(400).json({ error: "Salve a pregação antes de mandar esta frase para o telão" });
    if (!holyricsConfigured()) return res.status(400).json({ error: "O telão ainda não foi configurado. Avise o administrador." });
    // Uma frase por vez esperando: a nova substitui a anterior que ainda não foi aprovada
    await cancelPending({ kind: "phrase", refId: s.id, userId: req.auth!.userId });
    const request = await createRequest({ kind: "phrase", text, refId: s.id, payload: { text }, userId: req.auth!.userId });
    return res.json({ request });
  } catch (error) {
    return screenError(res, error);
  }
});

// DELETE /api/sermons/:id/screen  tira a frase do telão (e cancela a que ainda espera a Mídia)
router.delete("/:id/screen", requireTeam, screenLimit, async (req: Request, res: Response) => {
  try {
    const s = await visible(req, req.params.id);
    if (!s) return res.status(404).json({ error: "Pregação não encontrada" });
    await cancelPending({ kind: "phrase", refId: s.id });
    await holyrics("CloseCurrentQuickPresentation").catch((e) => {
      // Sem apresentação rápida aberta (ainda não tinha sido aprovada): tudo certo
      if (!(e instanceof HolyricsError)) throw e;
    });
    return res.json({ showing: null });
  } catch (error) {
    return screenError(res, error);
  }
});

router.delete("/:id", requireTeam, async (req: Request, res: Response) => {
  try {
    const row = await queryOne("DELETE FROM sermons WHERE id = $1 AND author_id = $2 RETURNING id", [req.params.id, req.auth!.userId]);
    if (!row) return res.status(404).json({ error: "Só quem criou a pregação pode excluir" });
    return res.json({ success: true });
  } catch (error) {
    return res.status(400).json({ error: "Pregação inválida" });
  }
});

export default router;
