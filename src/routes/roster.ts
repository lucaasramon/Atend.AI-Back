/**
 * Escalas: membros, áreas de serviço, escala por evento e checklist público do membro.
 *   /api/members, /api/areas            (equipe; edição por admin/agenda)
 *   /api/events/:id/roster             (escala do evento)
 *   /api/roster/checklist?token=        (público — link do WhatsApp)
 */
import { Router, Request, Response } from "express";
import { query, queryOne } from "../db";
import { requireRole } from "../middleware/auth";
import { resolveWhatsapp } from "../services/access";
import { placeholderHash, rosterInfo, sendRosterEntry, updateRosterChecklist } from "../services/roster";

const requireEditor = requireRole("admin", "agenda");
const requireReader = requireRole("admin", "agenda", "viewer");

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ids = (v: unknown) => (Array.isArray(v) ? v.filter((x) => typeof x === "string" && UUID_RE.test(x)) : []);

/** WhatsApp como está registrado (sem o 9 extra, quando for o caso); "" = sem WhatsApp */
async function checkNumber(raw: string | undefined): Promise<string | null> {
  if (!raw || !raw.replace(/\D/g, "")) return null;
  const r = await resolveWhatsapp(raw);
  if (!r.exists || !r.jid) throw Object.assign(new Error("Esse número não tem WhatsApp"), { status: 400 });
  return r.jid.split("@")[0];
}

// ---------- Membros ----------
export const membersRouter = Router();

const MEMBER_SELECT = `
  SELECT mb.*, COALESCE(json_agg(json_build_object('id', m.id, 'name', m.name)) FILTER (WHERE m.id IS NOT NULL), '[]') AS ministries
    FROM members mb
    LEFT JOIN member_ministries mm ON mm.member_id = mb.id
    LEFT JOIN ministries m ON m.id = mm.ministry_id`;

async function setMinistries(memberId: string, ministryIds?: string[]) {
  if (!ministryIds) return;
  await query("DELETE FROM member_ministries WHERE member_id = $1", [memberId]);
  if (ministryIds.length) {
    await query("INSERT INTO member_ministries (member_id, ministry_id) SELECT $1, unnest($2::uuid[]) ON CONFLICT DO NOTHING", [memberId, ministryIds]);
  }
}

membersRouter.get("/", requireReader, async (_req: Request, res: Response) => {
  try {
    return res.json(await query(`${MEMBER_SELECT} GROUP BY mb.id ORDER BY mb.active DESC, mb.name`));
  } catch (error) {
    return res.status(500).json({ error: "Erro interno do servidor" });
  }
});

membersRouter.post("/", requireEditor, async (req: Request, res: Response) => {
  const name = String(req.body.name || "").trim();
  if (!name) return res.status(400).json({ error: "Informe o nome" });
  try {
    const whatsapp = await checkNumber(req.body.whatsapp);
    const row = await queryOne<{ id: string }>("INSERT INTO members (name, whatsapp) VALUES ($1, $2) RETURNING id", [name, whatsapp]);
    await setMinistries(row!.id, ids(req.body.ministry_ids));
    return res.status(201).json(await queryOne(`${MEMBER_SELECT} WHERE mb.id = $1 GROUP BY mb.id`, [row!.id]));
  } catch (error: any) {
    return res.status(error.status || 400).json({ error: error.status ? error.message : "Dados inválidos" });
  }
});

membersRouter.patch("/:id", requireEditor, async (req: Request, res: Response) => {
  try {
    const whatsapp = "whatsapp" in req.body ? await checkNumber(req.body.whatsapp) : undefined;
    const row = await queryOne<{ id: string }>(
      `UPDATE members SET name = COALESCE(NULLIF(TRIM($1), ''), name),
              whatsapp = CASE WHEN $2 THEN $3 ELSE whatsapp END,
              active = COALESCE($4, active)
        WHERE id = $5 RETURNING id`,
      [req.body.name ?? null, whatsapp !== undefined, whatsapp ?? null, typeof req.body.active === "boolean" ? req.body.active : null, req.params.id]
    );
    if (!row) return res.status(404).json({ error: "Membro não encontrado" });
    if ("ministry_ids" in req.body) await setMinistries(row.id, ids(req.body.ministry_ids));
    return res.json(await queryOne(`${MEMBER_SELECT} WHERE mb.id = $1 GROUP BY mb.id`, [row.id]));
  } catch (error: any) {
    return res.status(error.status || 400).json({ error: error.status ? error.message : "Dados inválidos" });
  }
});

membersRouter.delete("/:id", requireEditor, async (req: Request, res: Response) => {
  try {
    await query("DELETE FROM members WHERE id = $1", [req.params.id]);
    return res.json({ success: true });
  } catch (error) {
    return res.status(400).json({ error: "Membro inválido" });
  }
});

// ---------- Áreas de serviço ----------
export const areasRouter = Router();

const AREA_SELECT = `
  SELECT a.*, m.name AS ministry_name, m.color AS ministry_color, p.title AS pop_title,
         COALESCE(jsonb_array_length(p.steps), 0) AS steps_count
    FROM service_areas a
    JOIN ministries m ON m.id = a.ministry_id
    LEFT JOIN pops p ON p.id = a.pop_id`;

areasRouter.get("/", requireReader, async (_req: Request, res: Response) => {
  try {
    return res.json(await query(`${AREA_SELECT} ORDER BY m.name, a.name`));
  } catch (error) {
    return res.status(500).json({ error: "Erro interno do servidor" });
  }
});

areasRouter.post("/", requireEditor, async (req: Request, res: Response) => {
  const { ministry_id, name, pop_id } = req.body;
  if (!String(name || "").trim() || !ministry_id) return res.status(400).json({ error: "Informe o ministério e o nome da área" });
  try {
    const row = await queryOne<{ id: string }>(
      "INSERT INTO service_areas (ministry_id, name, pop_id) VALUES ($1, $2, $3) RETURNING id",
      [ministry_id, String(name).trim(), pop_id || null]
    );
    return res.status(201).json(await queryOne(`${AREA_SELECT} WHERE a.id = $1`, [row!.id]));
  } catch (error: any) {
    if (error.code === "23505") return res.status(409).json({ error: "Essa área já existe nesse ministério" });
    return res.status(400).json({ error: "Dados inválidos" });
  }
});

areasRouter.patch("/:id", requireEditor, async (req: Request, res: Response) => {
  try {
    const row = await queryOne<{ id: string }>(
      `UPDATE service_areas SET name = COALESCE(NULLIF(TRIM($1), ''), name),
              pop_id = CASE WHEN $2 THEN NULLIF($3, '')::uuid ELSE pop_id END
        WHERE id = $4 RETURNING id`,
      [req.body.name ?? null, "pop_id" in req.body, req.body.pop_id ?? "", req.params.id]
    );
    if (!row) return res.status(404).json({ error: "Área não encontrada" });
    return res.json(await queryOne(`${AREA_SELECT} WHERE a.id = $1`, [row.id]));
  } catch (error: any) {
    if (error.code === "23505") return res.status(409).json({ error: "Essa área já existe nesse ministério" });
    return res.status(400).json({ error: "Dados inválidos" });
  }
});

areasRouter.delete("/:id", requireEditor, async (req: Request, res: Response) => {
  try {
    await query("DELETE FROM service_areas WHERE id = $1", [req.params.id]);
    return res.json({ success: true });
  } catch (error) {
    return res.status(400).json({ error: "Área inválida" });
  }
});

// ---------- Escala do evento (montado em /api/events) ----------
export const eventRosterRouter = Router();

const ROSTER_SELECT = `
  SELECT r.id, r.event_id, r.area_id, r.member_id, r.checked, r.sent_at, r.updated_at,
         a.name AS area, m.name AS ministry, m.color AS ministry_color, mb.name AS member, (mb.whatsapp IS NOT NULL) AS has_whatsapp,
         COALESCE(jsonb_array_length(p.steps), 0) AS steps_count
    FROM roster_entries r
    JOIN service_areas a ON a.id = r.area_id
    JOIN ministries m ON m.id = a.ministry_id
    JOIN members mb ON mb.id = r.member_id
    LEFT JOIN pops p ON p.id = a.pop_id`;

eventRosterRouter.get("/:eventId/roster", requireReader, async (req: Request, res: Response) => {
  try {
    return res.json(await query(`${ROSTER_SELECT} WHERE r.event_id = $1 ORDER BY m.name, a.name, mb.name`, [req.params.eventId]));
  } catch (error) {
    return res.status(400).json({ error: "Evento inválido" });
  }
});

eventRosterRouter.post("/:eventId/roster", requireEditor, async (req: Request, res: Response) => {
  const { area_id, member_id } = req.body;
  if (!area_id || !member_id) return res.status(400).json({ error: "Escolha a área e o membro" });
  try {
    const row = await queryOne<{ id: string }>(
      "INSERT INTO roster_entries (event_id, area_id, member_id, token_hash) VALUES ($1, $2, $3, $4) RETURNING id",
      [req.params.eventId, area_id, member_id, placeholderHash()]
    );
    return res.status(201).json(await queryOne(`${ROSTER_SELECT} WHERE r.id = $1`, [row!.id]));
  } catch (error: any) {
    if (error.code === "23505") return res.status(409).json({ error: "Esse membro já está nessa área do evento" });
    return res.status(400).json({ error: "Dados inválidos" });
  }
});

eventRosterRouter.delete("/roster/:entryId", requireEditor, async (req: Request, res: Response) => {
  try {
    await query("DELETE FROM roster_entries WHERE id = $1", [req.params.entryId]);
    return res.json({ success: true });
  } catch (error) {
    return res.status(400).json({ error: "Escala inválida" });
  }
});

// POST /api/events/roster/:entryId/send  (envia/reenvia o checklist agora)
eventRosterRouter.post("/roster/:entryId/send", requireEditor, async (req: Request, res: Response) => {
  try {
    const ok = await sendRosterEntry(req.params.entryId);
    if (!ok) return res.status(400).json({ error: "Não foi possível enviar (membro sem WhatsApp?)" });
    return res.json(await queryOne(`${ROSTER_SELECT} WHERE r.id = $1`, [req.params.entryId]));
  } catch (error) {
    return res.status(400).json({ error: "Escala inválida" });
  }
});

// ---------- Checklist público do membro ----------
export const publicRosterRouter = Router();

publicRosterRouter.get("/checklist", async (req: Request, res: Response) => {
  try {
    const info = await rosterInfo(String(req.query.token || ""));
    if (!info) return res.status(404).json({ error: "Link inválido ou substituído por um mais novo" });
    return res.json(info);
  } catch (error) {
    return res.status(500).json({ error: "Erro interno do servidor" });
  }
});

publicRosterRouter.patch("/checklist", async (req: Request, res: Response) => {
  const checked = Array.isArray(req.body.checked) ? req.body.checked.filter((n: any) => Number.isInteger(n) && n >= 0) : null;
  if (!checked) return res.status(400).json({ error: "checked deve ser uma lista" });
  try {
    const row = await updateRosterChecklist(String(req.body.token || ""), checked);
    if (!row) return res.status(404).json({ error: "Link inválido ou substituído por um mais novo" });
    return res.json(row);
  } catch (error) {
    return res.status(500).json({ error: "Erro interno do servidor" });
  }
});
