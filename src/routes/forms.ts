/**
 * Formulários públicos (sem login) e a gestão deles no painel:
 *   /api/public/signup            cadastro de membros e visitantes da igreja
 *   /api/public/forms/:slug       inscrição em um evento
 *   /api/people                   (admin) cadastros recebidos
 *   /api/events/forms, /api/events/:eventId/form   formulário de inscrição de cada evento
 */
import crypto from "crypto";
import { Router, Request, Response } from "express";
import { pool, query, queryOne } from "../db";
import { requireAdmin, requireRole } from "../middleware/auth";
import { rateLimit } from "../middleware/rateLimit";
import { normalizePhone } from "../services/access";
import { canManageEvent } from "../services/userAreas";
import { locationLabel } from "../services/eventData";
import { sendDirect } from "../services/notify";
import {
  DEFAULT_TEMPLATE, VERSES, birthdaysRunning, birthdaysToday, getBirthdaySettings, renderBirthday,
} from "../services/birthdays";

const requireEditor = requireRole("admin", "agenda");

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const str = (v: unknown, max = 200) => (typeof v === "string" ? v.trim().slice(0, max) : "");
const oneOf = <T extends string>(v: unknown, list: readonly T[]) => (list.includes(v as T) ? (v as T) : null);

/** WhatsApp só com dígitos (com DDI); null se não parecer um número válido */
function phone(raw: unknown): string | null {
  const n = normalizePhone(str(raw, 30));
  return n.length >= 12 && n.length <= 15 ? n : null;
}

const RELATIONS = ["visitor", "regular", "member"] as const;
const GENDERS = ["M", "F"] as const;
const MARITAL = ["single", "married", "divorced", "widowed"] as const;
const FIELD_TYPES = ["text", "textarea", "number", "date", "select", "yesno"] as const;

export interface FormField {
  id: string;
  label: string;
  type: (typeof FIELD_TYPES)[number];
  options: string[];
  required: boolean;
}

/** Limpa as perguntas extras vindas do painel */
function cleanFields(raw: unknown): FormField[] {
  if (!Array.isArray(raw)) return [];
  return raw.slice(0, 20).flatMap((f: any) => {
    const label = str(f?.label, 120);
    const type = oneOf(f?.type, FIELD_TYPES);
    if (!label || !type) return [];
    const options = type === "select"
      ? Array.from(new Set((Array.isArray(f.options) ? f.options : []).map((o: unknown) => str(o, 80)).filter(Boolean))).slice(0, 30) as string[]
      : [];
    if (type === "select" && options.length < 2) return [];
    const id = /^[a-z0-9_-]{1,40}$/i.test(f?.id || "") ? f.id : crypto.randomBytes(4).toString("hex");
    return [{ id, label, type, options, required: !!f.required }];
  });
}

/** Confere as respostas das perguntas extras; retorna as respostas limpas ou a mensagem de erro */
function checkAnswers(fields: FormField[], raw: any): { answers: Record<string, string> } | { error: string } {
  const answers: Record<string, string> = {};
  for (const f of fields) {
    let v = str(raw?.[f.id], f.type === "textarea" ? 1000 : 200);
    if (f.type === "select" && v && !f.options.includes(v)) v = "";
    if (f.type === "yesno" && v && !["Sim", "Não"].includes(v)) v = "";
    if (f.type === "number" && v && !/^-?\d+([.,]\d+)?$/.test(v)) return { error: `"${f.label}" deve ser um número` };
    if (f.type === "date" && v && !/^\d{4}-\d{2}-\d{2}$/.test(v)) v = "";
    if (f.required && !v) return { error: `Responda: ${f.label}` };
    if (v) answers[f.id] = v;
  }
  return { answers };
}

// ============================================================
// Público
// ============================================================
export const publicFormsRouter = Router();
const limitPost = rateLimit(15, 10 * 60_000);

// GET /api/public/signup  (ministérios para "gostaria de servir em")
publicFormsRouter.get("/signup", async (_req: Request, res: Response) => {
  try {
    return res.json({ ministries: await query("SELECT id, name, color FROM ministries ORDER BY name") });
  } catch (error) {
    return res.status(500).json({ error: "Erro interno do servidor" });
  }
});

// POST /api/public/signup  (cadastro de membro/visitante)
publicFormsRouter.post("/signup", limitPost, async (req: Request, res: Response) => {
  const b = req.body || {};
  if (str(b.website)) return res.json({ ok: true }); // campo invisível: só robôs preenchem
  const name = str(b.name, 120);
  const whatsapp = phone(b.whatsapp);
  const relation = oneOf(b.relation, RELATIONS);
  const birth = str(b.birth_date, 10);
  if (name.length < 3) return res.status(400).json({ error: "Informe o seu nome completo" });
  if (!whatsapp) return res.status(400).json({ error: "Informe um WhatsApp válido, com DDD" });
  if (!relation) return res.status(400).json({ error: "Diga se você é visitante, frequenta ou é membro" });
  if (!/^\d{4}-\d{2}-\d{2}$/.test(birth) || birth < "1900-01-01" || birth > new Date().toISOString().slice(0, 10)) {
    return res.status(400).json({ error: "Informe a data de nascimento" });
  }
  if (!b.consent) return res.status(400).json({ error: "É preciso concordar com o uso dos dados pela igreja" });
  const email = str(b.email, 120);
  if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return res.status(400).json({ error: "E-mail inválido" });

  try {
    const valid = await query<{ id: string }>("SELECT id FROM ministries WHERE id = ANY($1::uuid[])", [
      (Array.isArray(b.interests) ? b.interests : []).filter((x: unknown) => typeof x === "string" && UUID_RE.test(x)),
    ]);
    const row = await queryOne<{ updated: boolean }>(
      `INSERT INTO people (name, birth_date, whatsapp, email, gender, marital_status, neighborhood, relation, baptized,
                           how_found, wants_contact, interests, notes, consent_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, NOW())
       ON CONFLICT (whatsapp) DO UPDATE SET
         name = EXCLUDED.name, birth_date = EXCLUDED.birth_date, email = EXCLUDED.email, gender = EXCLUDED.gender,
         marital_status = EXCLUDED.marital_status, neighborhood = EXCLUDED.neighborhood, relation = EXCLUDED.relation,
         baptized = EXCLUDED.baptized, how_found = EXCLUDED.how_found, wants_contact = EXCLUDED.wants_contact,
         interests = EXCLUDED.interests, notes = COALESCE(EXCLUDED.notes, people.notes),
         consent_at = NOW(), status = 'new', updated_at = NOW()
       RETURNING (xmax <> 0) AS updated`,
      [
        name, birth, whatsapp, email || null,
        oneOf(b.gender, GENDERS), oneOf(b.marital_status, MARITAL), str(b.neighborhood, 120) || null, relation,
        relation === "visitor" ? null : typeof b.baptized === "boolean" ? b.baptized : null,
        relation === "visitor" ? str(b.how_found, 120) || null : null,
        !!b.wants_contact, JSON.stringify(valid.map((v) => v.id)), str(b.notes, 1000) || null,
      ]
    );
    // Pedido de oração do cadastro vai para a lista do pastor (tela Início)
    const notes = str(b.notes, 1000);
    if (notes) {
      await query(
        `INSERT INTO pastoral_requests (kind, source, person_name, whatsapp, details)
         SELECT 'prayer', 'cadastro', $1, $2, $3
          WHERE NOT EXISTS (SELECT 1 FROM pastoral_requests WHERE source = 'cadastro' AND whatsapp = $2 AND details = $3)`,
        [name, whatsapp, notes]
      );
    }
    return res.status(201).json({ ok: true, updated: !!row?.updated });
  } catch (error) {
    console.error("Signup error:", error);
    return res.status(500).json({ error: "Não foi possível enviar. Tente de novo." });
  }
});

interface FormRow {
  id: string;
  event_id: string;
  slug: string;
  title: string | null;
  description: string | null;
  is_open: boolean;
  capacity: number | null;
  closes_at: Date | null;
  fields: FormField[];
}

/** Formulário + evento + vagas, como o público vê */
async function publicForm(slug: string) {
  const f = await queryOne<FormRow & { event_title: string; event_description: string | null; starts_at: Date; ends_at: Date | null; location: string | null; event_status: string; confirmed: number; waitlist: number }>(
    `SELECT f.*, e.title AS event_title, e.description AS event_description, e.starts_at, e.ends_at, e.location, e.status AS event_status,
            (SELECT COUNT(*)::int FROM event_registrations r WHERE r.form_id = f.id AND r.status = 'confirmed') AS confirmed,
            (SELECT COUNT(*)::int FROM event_registrations r WHERE r.form_id = f.id AND r.status = 'waitlist') AS waitlist
       FROM event_forms f JOIN events e ON e.id = f.event_id
      WHERE f.slug = $1`,
    [slug]
  );
  if (!f) return null;
  const locations = await query<{ id: string; name: string }>(
    "SELECT l.id, l.name FROM event_locations el JOIN locations l ON l.id = el.location_id WHERE el.event_id = $1 ORDER BY l.name",
    [f.event_id]
  );
  const deadline = f.closes_at || f.starts_at;
  const state = f.event_status === "rejected" || !f.is_open ? "closed" : new Date(deadline) <= new Date() ? "ended" : "open";
  return {
    row: f,
    info: {
      title: f.title || f.event_title,
      description: f.description ?? f.event_description,
      event_title: f.event_title,
      starts_at: f.starts_at,
      ends_at: f.ends_at,
      location: locationLabel({ location: f.location, locations: locations as any }),
      state,
      closes_at: f.closes_at,
      capacity: f.capacity,
      spots_left: f.capacity == null ? null : Math.max(0, f.capacity - f.confirmed),
      fields: f.fields,
    },
  };
}

// GET /api/public/forms/:slug
publicFormsRouter.get("/forms/:slug", async (req: Request, res: Response) => {
  try {
    const f = await publicForm(req.params.slug);
    if (!f) return res.status(404).json({ error: "Formulário não encontrado" });
    return res.json(f.info);
  } catch (error) {
    return res.status(500).json({ error: "Erro interno do servidor" });
  }
});

// POST /api/public/forms/:slug  { name, whatsapp, answers }
publicFormsRouter.post("/forms/:slug", limitPost, async (req: Request, res: Response) => {
  const b = req.body || {};
  try {
    const f = await publicForm(req.params.slug);
    if (!f) return res.status(404).json({ error: "Formulário não encontrado" });
    if (str(b.website)) return res.json({ status: "confirmed" });
    if (f.info.state !== "open") return res.status(400).json({ error: "As inscrições estão encerradas" });
    const name = str(b.name, 120);
    const whatsapp = phone(b.whatsapp);
    if (name.length < 3) return res.status(400).json({ error: "Informe o seu nome completo" });
    if (!whatsapp) return res.status(400).json({ error: "Informe um WhatsApp válido, com DDD" });
    const checked = checkAnswers(f.row.fields, b.answers);
    if ("error" in checked) return res.status(400).json({ error: checked.error });

    // Trava por formulário: duas inscrições ao mesmo tempo não passam do limite de vagas
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [f.row.id]);
      const existing = (await client.query("SELECT id, status FROM event_registrations WHERE form_id = $1 AND whatsapp = $2", [f.row.id, whatsapp])).rows[0];
      let status: string;
      if (existing) {
        status = existing.status;
        await client.query("UPDATE event_registrations SET name = $1, answers = $2, updated_at = NOW() WHERE id = $3", [name, JSON.stringify(checked.answers), existing.id]);
      } else {
        const { rows } = await client.query("SELECT COUNT(*)::int AS n FROM event_registrations WHERE form_id = $1 AND status = 'confirmed'", [f.row.id]);
        status = f.row.capacity != null && rows[0].n >= f.row.capacity ? "waitlist" : "confirmed";
        await client.query(
          "INSERT INTO event_registrations (form_id, name, whatsapp, answers, status) VALUES ($1, $2, $3, $4, $5)",
          [f.row.id, name, whatsapp, JSON.stringify(checked.answers), status]
        );
      }
      await client.query("COMMIT");
      return res.status(201).json({ status, updated: !!existing });
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  } catch (error) {
    console.error("Event registration error:", error);
    return res.status(500).json({ error: "Não foi possível enviar. Tente de novo." });
  }
});

// ============================================================
// Painel: cadastros recebidos (admin)
// ============================================================
export const peopleRouter = Router();

peopleRouter.get("/", requireAdmin, async (_req: Request, res: Response) => {
  try {
    return res.json(await query("SELECT * FROM people ORDER BY created_at DESC"));
  } catch (error) {
    return res.status(500).json({ error: "Erro interno do servidor" });
  }
});

peopleRouter.get("/new-count", requireAdmin, async (_req: Request, res: Response) => {
  try {
    const r = await queryOne<{ count: number }>("SELECT COUNT(*)::int AS count FROM people WHERE status = 'new'");
    return res.json({ count: r?.count || 0 });
  } catch (error) {
    return res.status(500).json({ error: "Erro interno do servidor" });
  }
});

// GET /api/people/birthdays  (configuração dos parabéns + aniversariantes de hoje)
peopleRouter.get("/birthdays", requireAdmin, async (_req: Request, res: Response) => {
  try {
    const cfg = await getBirthdaySettings();
    const today = await birthdaysToday();
    return res.json({
      enabled: cfg.enabled,
      church: cfg.church,
      gap_min: cfg.gapMin,
      gap_max: cfg.gapMax,
      template: cfg.template || DEFAULT_TEMPLATE,
      verse: cfg.verse,
      default_template: DEFAULT_TEMPLATE,
      verses: VERSES,
      running: birthdaysRunning(),
      today: today.map((p) => ({ id: p.id, name: p.name, birth_date: p.birth_date, sent_at: p.sent_at })),
    });
  } catch (error) {
    return res.status(500).json({ error: "Erro interno do servidor" });
  }
});

// PUT /api/people/birthdays  { enabled, church, gap_min, gap_max, template }
peopleRouter.put("/birthdays", requireAdmin, async (req: Request, res: Response) => {
  const b = req.body || {};
  const gapMin = Number(b.gap_min);
  const gapMax = Number(b.gap_max);
  if (!Number.isFinite(gapMin) || !Number.isFinite(gapMax) || gapMin < 1 || gapMax < gapMin || gapMax > 240) {
    return res.status(400).json({ error: "Intervalo inválido: use de 1 a 240 minutos, com o mínimo menor ou igual ao máximo" });
  }
  const church = str(b.church, 120);
  if (!church) return res.status(400).json({ error: "Informe o nome da igreja" });
  const template = str(b.template, 2000);
  if (!template.includes("{nome}")) return res.status(400).json({ error: "A mensagem precisa ter {nome}" });
  try {
    const values: Record<string, string> = {
      birthday_enabled: b.enabled === false ? "false" : "true",
      birthday_church: church,
      birthday_gap_min: String(gapMin),
      birthday_gap_max: String(gapMax),
      birthday_template: template === DEFAULT_TEMPLATE ? "" : template,
      birthday_verse: str(b.verse, 600),
    };
    for (const [key, value] of Object.entries(values)) {
      await query(
        `INSERT INTO system_settings (key, value, updated_at) VALUES ($1, $2, NOW())
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
        [key, value]
      );
    }
    return res.json({ success: true });
  } catch (error) {
    console.error("Save birthday settings error:", error);
    return res.status(500).json({ error: "Erro interno do servidor" });
  }
});

// POST /api/people/birthdays/test  { church, template }  (manda um exemplo para o WhatsApp de quem pediu)
peopleRouter.post("/birthdays/test", requireAdmin, async (req: Request, res: Response) => {
  try {
    const me = await queryOne<{ full_name: string | null; whatsapp: string | null }>("SELECT full_name, whatsapp FROM users WHERE id = $1", [req.auth!.userId]);
    if (!me?.whatsapp) return res.status(400).json({ error: "Seu usuário não tem WhatsApp cadastrado (Usuários → editar)." });
    const cfg = await getBirthdaySettings();
    const text = renderBirthday(
      {
        church: str(req.body?.church, 120) || cfg.church,
        template: str(req.body?.template, 2000) || cfg.template,
        verse: typeof req.body?.verse === "string" ? str(req.body.verse, 600) : cfg.verse,
      },
      me.full_name || "Irmão(ã)"
    );
    if (!(await sendDirect(me.whatsapp, text))) return res.status(502).json({ error: "Não foi possível enviar agora. Tente de novo." });
    return res.json({ success: true });
  } catch (error) {
    return res.status(500).json({ error: "Erro interno do servidor" });
  }
});

peopleRouter.patch("/:id", requireAdmin, async (req: Request, res: Response) => {
  const status = oneOf(req.body.status, ["new", "seen"] as const);
  if (!status) return res.status(400).json({ error: "Status inválido" });
  try {
    const row = await queryOne("UPDATE people SET status = $1 WHERE id = $2 RETURNING *", [status, req.params.id]);
    return row ? res.json(row) : res.status(404).json({ error: "Cadastro não encontrado" });
  } catch (error) {
    return res.status(400).json({ error: "Cadastro inválido" });
  }
});

// POST /api/people/:id/member  (inclui a pessoa nos membros das escalas, com as áreas de interesse)
peopleRouter.post("/:id/member", requireAdmin, async (req: Request, res: Response) => {
  try {
    const p = await queryOne<{ id: string; name: string; whatsapp: string; interests: string[]; member_id: string | null }>(
      "SELECT id, name, whatsapp, interests, member_id FROM people WHERE id = $1",
      [req.params.id]
    );
    if (!p) return res.status(404).json({ error: "Cadastro não encontrado" });
    let memberId = p.member_id;
    if (!memberId) {
      // Já existe como membro? (mesmo DDD e mesmos 8 últimos dígitos: cobre o número com ou sem o 9)
      const found = await queryOne<{ id: string }>(
        "SELECT id FROM members WHERE left(whatsapp, 4) = left($1, 4) AND right(whatsapp, 8) = right($1, 8) LIMIT 1",
        [p.whatsapp]
      );
      memberId = found?.id || (await queryOne<{ id: string }>("INSERT INTO members (name, whatsapp) VALUES ($1, $2) RETURNING id", [p.name, p.whatsapp]))!.id;
    }
    if (p.interests.length) {
      await query(
        "INSERT INTO member_ministries (member_id, ministry_id) SELECT $1, unnest($2::uuid[]) ON CONFLICT DO NOTHING",
        [memberId, p.interests]
      );
    }
    return res.json(await queryOne("UPDATE people SET member_id = $1, status = 'seen' WHERE id = $2 RETURNING *", [memberId, p.id]));
  } catch (error) {
    console.error("Person to member error:", error);
    return res.status(400).json({ error: "Não foi possível incluir nas escalas" });
  }
});

peopleRouter.delete("/:id", requireAdmin, async (req: Request, res: Response) => {
  try {
    await query("DELETE FROM people WHERE id = $1", [req.params.id]);
    return res.json({ success: true });
  } catch (error) {
    return res.status(400).json({ error: "Cadastro inválido" });
  }
});

// ============================================================
// Painel: formulário de inscrição de cada evento
// ============================================================
export const eventFormsRouter = Router();

const FORM_COUNTS = `
  (SELECT COUNT(*)::int FROM event_registrations r WHERE r.form_id = f.id AND r.status = 'confirmed') AS confirmed,
  (SELECT COUNT(*)::int FROM event_registrations r WHERE r.form_id = f.id AND r.status = 'waitlist') AS waitlist`;

/** Quem pode editar: admin, quem criou o evento ou quem é de uma área do evento */
const CAN_EDIT = `($2::boolean OR e.created_by = $1 OR EXISTS (
  SELECT 1 FROM event_ministries em JOIN user_ministries um ON um.ministry_id = em.ministry_id
   WHERE em.event_id = e.id AND um.user_id = $1)) AS can_edit`;

// GET /api/events/forms  (todos os formulários, com o evento e as contagens)
eventFormsRouter.get("/forms", requireEditor, async (req: Request, res: Response) => {
  try {
    return res.json(
      await query(
        `SELECT f.id, f.event_id, f.slug, f.title, f.is_open, f.capacity, f.closes_at, f.created_at,
                e.title AS event_title, e.starts_at, ${FORM_COUNTS}, ${CAN_EDIT}
           FROM event_forms f JOIN events e ON e.id = f.event_id
          ORDER BY (e.starts_at < NOW()), CASE WHEN e.starts_at < NOW() THEN NULL ELSE e.starts_at END, e.starts_at DESC`,
        [req.auth!.userId, req.auth!.role === "admin"]
      )
    );
  } catch (error) {
    return res.status(500).json({ error: "Erro interno do servidor" });
  }
});

// GET /api/events/:eventId/form  (formulário + inscritos)
eventFormsRouter.get("/:eventId/form", requireEditor, async (req: Request, res: Response) => {
  if (!UUID_RE.test(req.params.eventId)) return res.status(400).json({ error: "Evento inválido" });
  try {
    const form = await queryOne(`SELECT f.*, ${FORM_COUNTS} FROM event_forms f WHERE f.event_id = $1`, [req.params.eventId]);
    const registrations = form
      ? await query("SELECT * FROM event_registrations WHERE form_id = $1 ORDER BY status, created_at", [form.id])
      : [];
    const can_edit = await canManageEvent(req.auth!.userId, req.auth!.role, req.params.eventId);
    return res.json({ form, registrations, can_edit });
  } catch (error) {
    return res.status(400).json({ error: "Evento inválido" });
  }
});

// PUT /api/events/:eventId/form  (cria ou altera)
eventFormsRouter.put("/:eventId/form", requireEditor, async (req: Request, res: Response) => {
  const { eventId } = req.params;
  if (!UUID_RE.test(eventId)) return res.status(400).json({ error: "Evento inválido" });
  const b = req.body || {};
  const capacity = b.capacity === null || b.capacity === "" || b.capacity === undefined ? null : parseInt(b.capacity);
  if (capacity !== null && (!Number.isFinite(capacity) || capacity < 1 || capacity > 100000)) {
    return res.status(400).json({ error: "Limite de vagas inválido" });
  }
  const closesAt = b.closes_at ? new Date(b.closes_at) : null;
  if (closesAt && isNaN(closesAt.getTime())) return res.status(400).json({ error: "Data de encerramento inválida" });
  try {
    if (!(await canManageEvent(req.auth!.userId, req.auth!.role, eventId))) {
      return res.status(403).json({ error: "Você só pode criar inscrições para eventos das suas áreas." });
    }
    const form = await queryOne<{ id: string; capacity: number | null }>(
      `INSERT INTO event_forms (event_id, slug, title, description, is_open, capacity, closes_at, fields, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (event_id) DO UPDATE SET
         title = EXCLUDED.title, description = EXCLUDED.description, is_open = EXCLUDED.is_open,
         capacity = EXCLUDED.capacity, closes_at = EXCLUDED.closes_at, fields = EXCLUDED.fields, updated_at = NOW()
       RETURNING id, capacity`,
      [
        eventId, crypto.randomBytes(6).toString("base64url"), str(b.title, 150) || null, str(b.description, 2000) || null,
        b.is_open !== false, capacity, closesAt, JSON.stringify(cleanFields(b.fields)), req.auth!.userId,
      ]
    );
    await promoteWaitlist(form!.id);
    return res.json(await queryOne(`SELECT f.*, ${FORM_COUNTS} FROM event_forms f WHERE f.id = $1`, [form!.id]));
  } catch (error) {
    console.error("Save event form error:", error);
    return res.status(400).json({ error: "Dados inválidos" });
  }
});

eventFormsRouter.delete("/:eventId/form", requireEditor, async (req: Request, res: Response) => {
  try {
    if (!(await canManageEvent(req.auth!.userId, req.auth!.role, req.params.eventId))) {
      return res.status(403).json({ error: "Você só pode alterar eventos das suas áreas." });
    }
    await query("DELETE FROM event_forms WHERE event_id = $1", [req.params.eventId]);
    return res.json({ success: true });
  } catch (error) {
    return res.status(400).json({ error: "Evento inválido" });
  }
});

/** Abriu vaga (alguém saiu ou o limite aumentou): passa os primeiros da lista de espera para confirmados */
async function promoteWaitlist(formId: string) {
  await query(
    `UPDATE event_registrations SET status = 'confirmed', updated_at = NOW()
      WHERE id IN (
        SELECT r.id FROM event_registrations r, event_forms f
         WHERE f.id = $1 AND r.form_id = f.id AND r.status = 'waitlist'
         ORDER BY r.created_at
         LIMIT (SELECT CASE WHEN f2.capacity IS NULL THEN 100000
                            ELSE GREATEST(0, f2.capacity - (SELECT COUNT(*) FROM event_registrations c WHERE c.form_id = f2.id AND c.status = 'confirmed')) END
                  FROM event_forms f2 WHERE f2.id = $1))`,
    [formId]
  );
}

/** Inscrição + evento dela, conferindo se quem pede pode mexer */
async function registrationFor(req: Request) {
  const r = await queryOne<{ id: string; form_id: string; event_id: string }>(
    "SELECT r.id, r.form_id, f.event_id FROM event_registrations r JOIN event_forms f ON f.id = r.form_id WHERE r.id = $1",
    [req.params.id]
  );
  if (!r) return { error: 404 as const };
  if (!(await canManageEvent(req.auth!.userId, req.auth!.role, r.event_id))) return { error: 403 as const };
  return { r };
}

// PATCH /api/events/form-registrations/:id  { status }  (confirmar quem está na lista de espera, ou o contrário)
eventFormsRouter.patch("/form-registrations/:id", requireEditor, async (req: Request, res: Response) => {
  const status = oneOf(req.body.status, ["confirmed", "waitlist"] as const);
  if (!status) return res.status(400).json({ error: "Status inválido" });
  try {
    const found = await registrationFor(req);
    if ("error" in found) return res.status(found.error!).json({ error: found.error === 404 ? "Inscrição não encontrada" : "Acesso negado" });
    return res.json(await queryOne("UPDATE event_registrations SET status = $1, updated_at = NOW() WHERE id = $2 RETURNING *", [status, found.r.id]));
  } catch (error) {
    return res.status(400).json({ error: "Inscrição inválida" });
  }
});

eventFormsRouter.delete("/form-registrations/:id", requireEditor, async (req: Request, res: Response) => {
  try {
    const found = await registrationFor(req);
    if ("error" in found) return res.status(found.error!).json({ error: found.error === 404 ? "Inscrição não encontrada" : "Acesso negado" });
    await query("DELETE FROM event_registrations WHERE id = $1", [found.r.id]);
    await promoteWaitlist(found.r.form_id);
    return res.json({ success: true });
  } catch (error) {
    return res.status(400).json({ error: "Inscrição inválida" });
  }
});
