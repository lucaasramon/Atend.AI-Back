/**
 * Escalas: membros, funções de serviço (com POP), escala por evento e checklist público do membro.
 *   /api/members, /api/areas                     (equipe; edição por admin/agenda)
 *   /api/events/rosters?from=&to=                (visão geral: escalas por evento)
 *   /api/events/:id/roster                       (escala do evento)
 *   /api/events/:id/roster/ministry/:ministryId  (salva a escala de uma área de uma vez)
 *   /api/roster/checklist?token=                 (público — link do WhatsApp)
 */
import { Router, Request, Response } from "express";
import { query, queryOne } from "../db";
import { requireRole } from "../middleware/auth";
import { resolveWhatsapp } from "../services/access";
import { placeholderHash, rosterInfo, sendRosterEntry, updateRosterChecklist } from "../services/roster";
import { userMinistryIds } from "../services/userAreas";

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

/** Quem não é admin só monta escala das suas áreas */
async function canEditMinistry(req: Request, ministryId: string): Promise<boolean> {
  if (req.auth!.role === "admin") return true;
  return (await userMinistryIds(req.auth!.userId)).includes(ministryId);
}

// ---------- Membros ----------
export const membersRouter = Router();

const MEMBER_SELECT = `
  SELECT mb.*, (mb.user_id IS NOT NULL) AS is_user, u.church_role,
         COALESCE(json_agg(json_build_object('id', m.id, 'name', m.name, 'color', m.color) ORDER BY m.name)
                  FILTER (WHERE m.id IS NOT NULL), '[]') AS ministries
    FROM members mb
    LEFT JOIN users u ON u.id = mb.user_id
    LEFT JOIN member_ministries mm ON mm.member_id = mb.id
    LEFT JOIN ministries m ON m.id = mm.ministry_id`;
const MEMBER_GROUP = "GROUP BY mb.id, u.church_role";

async function setMinistries(memberId: string, ministryIds?: string[]) {
  if (!ministryIds) return;
  await query("DELETE FROM member_ministries WHERE member_id = $1", [memberId]);
  if (ministryIds.length) {
    await query("INSERT INTO member_ministries (member_id, ministry_id) SELECT $1, unnest($2::uuid[]) ON CONFLICT DO NOTHING", [memberId, ministryIds]);
  }
}

const getMember = (id: string) => queryOne(`${MEMBER_SELECT} WHERE mb.id = $1 ${MEMBER_GROUP}`, [id]);
const LINKED = "Este membro é um usuário da plataforma: altere nome, WhatsApp e áreas na tela Usuários.";

membersRouter.get("/", requireReader, async (_req: Request, res: Response) => {
  try {
    return res.json(await query(`${MEMBER_SELECT} ${MEMBER_GROUP} ORDER BY mb.active DESC, mb.name`));
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
    return res.status(201).json(await getMember(row!.id));
  } catch (error: any) {
    return res.status(error.status || 400).json({ error: error.status ? error.message : "Dados inválidos" });
  }
});

membersRouter.patch("/:id", requireEditor, async (req: Request, res: Response) => {
  try {
    const current = await queryOne<{ user_id: string | null }>("SELECT user_id FROM members WHERE id = $1", [req.params.id]);
    if (!current) return res.status(404).json({ error: "Membro não encontrado" });
    if (current.user_id && ["name", "whatsapp", "ministry_ids"].some((k) => k in req.body)) {
      return res.status(400).json({ error: LINKED });
    }
    const whatsapp = "whatsapp" in req.body ? await checkNumber(req.body.whatsapp) : undefined;
    await query(
      `UPDATE members SET name = COALESCE(NULLIF(TRIM($1), ''), name),
              whatsapp = CASE WHEN $2 THEN $3 ELSE whatsapp END,
              active = COALESCE($4, active)
        WHERE id = $5`,
      [req.body.name ?? null, whatsapp !== undefined, whatsapp ?? null, typeof req.body.active === "boolean" ? req.body.active : null, req.params.id]
    );
    if ("ministry_ids" in req.body) await setMinistries(req.params.id, ids(req.body.ministry_ids));
    return res.json(await getMember(req.params.id));
  } catch (error: any) {
    return res.status(error.status || 400).json({ error: error.status ? error.message : "Dados inválidos" });
  }
});

membersRouter.delete("/:id", requireEditor, async (req: Request, res: Response) => {
  try {
    const current = await queryOne<{ user_id: string | null }>("SELECT user_id FROM members WHERE id = $1", [req.params.id]);
    if (current?.user_id) return res.status(400).json({ error: "Este membro é um usuário da plataforma. Para tirá-lo das escalas, desative-o." });
    await query("DELETE FROM members WHERE id = $1", [req.params.id]);
    return res.json({ success: true });
  } catch (error) {
    return res.status(400).json({ error: "Membro inválido" });
  }
});

// ---------- Funções de serviço (com POP opcional) ----------
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
  if (!String(name || "").trim() || !ministry_id) return res.status(400).json({ error: "Informe a área e o nome da função" });
  try {
    const row = await queryOne<{ id: string }>(
      "INSERT INTO service_areas (ministry_id, name, pop_id) VALUES ($1, $2, $3) RETURNING id",
      [ministry_id, String(name).trim(), pop_id || null]
    );
    return res.status(201).json(await queryOne(`${AREA_SELECT} WHERE a.id = $1`, [row!.id]));
  } catch (error: any) {
    if (error.code === "23505") return res.status(409).json({ error: "Essa função já existe nessa área" });
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
    if (!row) return res.status(404).json({ error: "Função não encontrada" });
    return res.json(await queryOne(`${AREA_SELECT} WHERE a.id = $1`, [row.id]));
  } catch (error: any) {
    if (error.code === "23505") return res.status(409).json({ error: "Essa função já existe nessa área" });
    return res.status(400).json({ error: "Dados inválidos" });
  }
});

areasRouter.delete("/:id", requireEditor, async (req: Request, res: Response) => {
  try {
    await query("DELETE FROM service_areas WHERE id = $1", [req.params.id]);
    return res.json({ success: true });
  } catch (error) {
    return res.status(400).json({ error: "Função inválida" });
  }
});

// ---------- Escala do evento (montado em /api/events) ----------
export const eventRosterRouter = Router();

const ROSTER_SELECT = `
  SELECT r.id, r.event_id, r.ministry_id, r.area_id, r.member_id, r.task, r.checked, r.sent_at, r.updated_at,
         m.name AS ministry, m.color AS ministry_color, a.name AS area,
         mb.name AS member, (mb.whatsapp IS NOT NULL) AS has_whatsapp,
         COALESCE(jsonb_array_length(p.steps), 0) AS steps_count
    FROM roster_entries r
    JOIN ministries m ON m.id = r.ministry_id
    JOIN members mb ON mb.id = r.member_id
    LEFT JOIN service_areas a ON a.id = r.area_id
    LEFT JOIN pops p ON p.id = a.pop_id`;
const ROSTER_ORDER = "ORDER BY m.name, COALESCE(r.task, a.name, ''), mb.name";

// GET /api/events/rosters?from=&to=  (visão geral: eventos do período com as escalas de todas as áreas)
eventRosterRouter.get("/rosters", requireReader, async (req: Request, res: Response) => {
  const from = (req.query.from as string) || new Date().toISOString();
  const to = (req.query.to as string) || new Date(Date.now() + 28 * 86400e3).toISOString();
  try {
    const events = await query<any>(
      `SELECT e.id, e.title, e.starts_at, e.ends_at, e.category, e.status,
              COALESCE((SELECT json_agg(json_build_object('id', mi.id, 'name', mi.name, 'color', mi.color) ORDER BY mi.name)
                          FROM event_ministries em JOIN ministries mi ON mi.id = em.ministry_id WHERE em.event_id = e.id), '[]') AS ministries
         FROM events e
        WHERE e.status <> 'rejected' AND e.starts_at >= $1 AND e.starts_at <= $2
        ORDER BY e.starts_at`,
      [from, to]
    );
    const entries = events.length
      ? await query<any>(`${ROSTER_SELECT} WHERE r.event_id = ANY($1) ${ROSTER_ORDER}`, [events.map((e) => e.id)])
      : [];
    return res.json(events.map((e) => ({ ...e, roster: entries.filter((r) => r.event_id === e.id) })));
  } catch (error) {
    return res.status(400).json({ error: "Período inválido" });
  }
});

eventRosterRouter.get("/:eventId/roster", requireReader, async (req: Request, res: Response) => {
  try {
    return res.json(await query(`${ROSTER_SELECT} WHERE r.event_id = $1 ${ROSTER_ORDER}`, [req.params.eventId]));
  } catch (error) {
    return res.status(400).json({ error: "Evento inválido" });
  }
});

// PUT /api/events/:eventId/roster/ministry/:ministryId  { entries: [{ member_id, task?, area_id? }] }
// Salva a escala completa da área no evento: inclui os novos, atualiza a função e remove quem saiu.
eventRosterRouter.put("/:eventId/roster/ministry/:ministryId", requireEditor, async (req: Request, res: Response) => {
  const { eventId, ministryId } = req.params;
  const list: any[] = Array.isArray(req.body.entries) ? req.body.entries : [];
  if (list.some((e) => !UUID_RE.test(e?.member_id || ""))) return res.status(400).json({ error: "Membro inválido" });
  try {
    if (!(await canEditMinistry(req, ministryId))) {
      return res.status(403).json({ error: "Você só pode montar escalas das suas áreas." });
    }
    const keep = list.map((e) => e.member_id);
    await query(
      "DELETE FROM roster_entries WHERE event_id = $1 AND ministry_id = $2 AND NOT (member_id = ANY($3::uuid[]))",
      [eventId, ministryId, keep]
    );
    for (const e of list) {
      const task = String(e.task || "").trim() || null;
      const areaId = UUID_RE.test(e.area_id || "") ? e.area_id : null;
      await query(
        `INSERT INTO roster_entries (event_id, ministry_id, member_id, task, area_id, token_hash)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (event_id, ministry_id, member_id) DO UPDATE SET task = EXCLUDED.task, area_id = EXCLUDED.area_id`,
        [eventId, ministryId, e.member_id, task, areaId, placeholderHash()]
      );
    }
    return res.json(await query(`${ROSTER_SELECT} WHERE r.event_id = $1 AND r.ministry_id = $2 ${ROSTER_ORDER}`, [eventId, ministryId]));
  } catch (error) {
    console.error("Save roster error:", error);
    return res.status(400).json({ error: "Dados inválidos" });
  }
});

eventRosterRouter.delete("/roster/:entryId", requireEditor, async (req: Request, res: Response) => {
  try {
    const entry = await queryOne<{ ministry_id: string }>("SELECT ministry_id FROM roster_entries WHERE id = $1", [req.params.entryId]);
    if (entry && !(await canEditMinistry(req, entry.ministry_id))) {
      return res.status(403).json({ error: "Você só pode alterar escalas das suas áreas." });
    }
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
