/**
 * Tela Início: o que é de cada pessoa (pendências, escala, eventos da área),
 * o que todos veem (aniversariantes, inscrições abertas, pedidos de oração/visita)
 * e o bloco pastoral (números, visitantes a procurar, pedidos recebidos).
 */
import { Router, Request, Response } from "express";
import { query, queryOne } from "../db";
import { requireRole } from "../middleware/auth";
import { normalizePhone } from "../services/access";
import { localDate } from "../services/reminders";

const router = Router();
const requireTeam = requireRole("admin", "agenda", "viewer");

/** Funções na igreja que veem o bloco pastoral (além dos administradores) */
export const PASTOR_ROLES = ["Apóstolo(a)", "Bispo(a)", "Pastor(a)", "Pastor(a) auxiliar"];

async function isPastor(req: Request): Promise<boolean> {
  if (req.auth!.role === "admin") return true;
  const u = await queryOne<{ church_role: string | null }>("SELECT church_role FROM users WHERE id = $1", [req.auth!.userId]);
  return !!u?.church_role && PASTOR_ROLES.includes(u.church_role);
}

const str = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : "");

// GET /api/home
router.get("/", requireTeam, async (req: Request, res: Response) => {
  const me = req.auth!.userId;
  try {
    const user = await queryOne<{ full_name: string | null; email: string }>("SELECT full_name, email FROM users WHERE id = $1", [me]);
    const pastor = await isPastor(req);
    const today = localDate(new Date());

    const [tasks, acks, roster, events, birthdays, forms, myRequests] = await Promise.all([
      // Tarefas de checklist de evento atribuídas a mim
      query(
        `SELECT t.id, t.title, t.due_date, e.id AS event_id, e.title AS event_title, e.starts_at
           FROM event_tasks t JOIN events e ON e.id = t.event_id
          WHERE t.assignee_id = $1 AND t.done = false AND e.status <> 'rejected'
            AND e.starts_at > NOW() - INTERVAL '1 day'
          ORDER BY t.due_date NULLS LAST, e.starts_at
          LIMIT 30`,
        [me]
      ),
      // Confirmações que ainda não respondi
      query(
        `SELECT a.id, e.title, e.starts_at, m.name AS ministry, a.deadline
           FROM acknowledgements a
           JOIN events e ON e.id = a.event_id
           JOIN ministries m ON m.id = a.ministry_id
          WHERE a.user_id = $1 AND a.confirmed_at IS NULL AND e.starts_at > NOW()
            AND NOT EXISTS (SELECT 1 FROM acknowledgements c
                             WHERE c.event_id = a.event_id AND c.ministry_id = a.ministry_id AND c.confirmed_at IS NOT NULL)
          ORDER BY e.starts_at`,
        [me]
      ),
      // Minhas próximas escalas (com o checklist da função)
      query(
        `SELECT r.id, r.task, r.checked, a.name AS area, m.name AS ministry, m.color AS ministry_color,
                e.id AS event_id, e.title AS event_title, e.starts_at, e.location,
                p.title AS pop_title, COALESCE(p.steps, '[]') AS steps
           FROM roster_entries r
           JOIN members mb ON mb.id = r.member_id
           JOIN events e ON e.id = r.event_id
           JOIN ministries m ON m.id = r.ministry_id
           LEFT JOIN service_areas a ON a.id = r.area_id
           LEFT JOIN pops p ON p.id = a.pop_id
          WHERE mb.user_id = $1 AND e.status <> 'rejected' AND e.starts_at > NOW() - INTERVAL '3 hours'
          ORDER BY e.starts_at
          LIMIT 3`,
        [me]
      ),
      // Próximos 7 dias: eventos das minhas áreas (sem área = todos)
      query(
        `SELECT e.id, e.title, e.starts_at, e.location, e.status,
                COALESCE((SELECT json_agg(json_build_object('name', mi.name, 'color', mi.color) ORDER BY mi.name)
                            FROM event_ministries em JOIN ministries mi ON mi.id = em.ministry_id WHERE em.event_id = e.id), '[]') AS ministries
           FROM events e
          WHERE e.status <> 'rejected' AND e.starts_at > NOW() AND e.starts_at < NOW() + INTERVAL '7 days'
            AND (NOT EXISTS (SELECT 1 FROM user_ministries um WHERE um.user_id = $1)
                 OR EXISTS (SELECT 1 FROM event_ministries em JOIN user_ministries um ON um.ministry_id = em.ministry_id
                             WHERE em.event_id = e.id AND um.user_id = $1)
                 OR NOT EXISTS (SELECT 1 FROM event_ministries em WHERE em.event_id = e.id))
          ORDER BY e.starts_at
          LIMIT 20`,
        [me]
      ),
      // Aniversariantes dos próximos 7 dias (Cadastros)
      query(
        `WITH d AS (SELECT generate_series($1::date, $1::date + 6, '1 day')::date AS day)
         SELECT p.id, p.name, to_char(d.day, 'YYYY-MM-DD') AS day,
                EXTRACT(YEAR FROM d.day)::int - EXTRACT(YEAR FROM p.birth_date)::int AS age
           FROM people p JOIN d ON to_char(p.birth_date, 'MM-DD') = to_char(d.day, 'MM-DD')
          WHERE p.birth_date IS NOT NULL
          ORDER BY d.day, p.name`,
        [today]
      ),
      // Inscrições abertas
      query(
        `SELECT f.slug, COALESCE(f.title, e.title) AS title, e.starts_at, f.capacity, f.closes_at,
                (SELECT COUNT(*)::int FROM event_registrations r WHERE r.form_id = f.id AND r.status = 'confirmed') AS confirmed
           FROM event_forms f JOIN events e ON e.id = f.event_id
          WHERE f.is_open AND e.status <> 'rejected' AND COALESCE(f.closes_at, e.starts_at) > NOW()
          ORDER BY e.starts_at`
      ),
      // Meus pedidos de oração/visita
      query(
        `SELECT id, kind, person_name, status, created_at, handled_at
           FROM pastoral_requests WHERE requested_by = $1
          ORDER BY created_at DESC LIMIT 10`,
        [me]
      ),
    ]);

    let pastoral = null;
    if (pastor) {
      const [counts, contact, requests] = await Promise.all([
        queryOne(
          `SELECT COUNT(*) FILTER (WHERE relation = 'member')::int  AS member,
                  COUNT(*) FILTER (WHERE relation = 'regular')::int AS regular,
                  COUNT(*) FILTER (WHERE relation = 'visitor')::int AS visitor,
                  COUNT(*) FILTER (WHERE relation = 'member'  AND created_at >= date_trunc('month', NOW() AT TIME ZONE 'America/Sao_Paulo') AT TIME ZONE 'America/Sao_Paulo')::int AS member_new,
                  COUNT(*) FILTER (WHERE relation = 'regular' AND created_at >= date_trunc('month', NOW() AT TIME ZONE 'America/Sao_Paulo') AT TIME ZONE 'America/Sao_Paulo')::int AS regular_new,
                  COUNT(*) FILTER (WHERE relation = 'visitor' AND created_at >= date_trunc('month', NOW() AT TIME ZONE 'America/Sao_Paulo') AT TIME ZONE 'America/Sao_Paulo')::int AS visitor_new
             FROM people`
        ),
        query(
          `SELECT id, name, whatsapp, neighborhood, how_found, notes, created_at
             FROM people
            WHERE relation = 'visitor' AND wants_contact AND contacted_at IS NULL
            ORDER BY created_at`
        ),
        query(
          `SELECT r.*, u.full_name AS requested_by_name
             FROM pastoral_requests r LEFT JOIN users u ON u.id = r.requested_by
            WHERE r.status = 'open'
            ORDER BY r.created_at`
        ),
      ]);
      pastoral = {
        counts,
        contact_pending: contact,
        prayers: requests.filter((r: any) => r.kind === "prayer"),
        visits: requests.filter((r: any) => r.kind === "visit"),
      };
    }

    return res.json({
      name: user?.full_name || user?.email || "",
      is_pastor: pastor,
      tasks,
      acks,
      roster,
      events,
      birthdays,
      forms,
      my_requests: myRequests,
      pastoral,
    });
  } catch (error) {
    console.error("Home error:", error);
    return res.status(500).json({ error: "Erro interno do servidor" });
  }
});

// POST /api/home/tasks/:id  { done }  (só a pessoa responsável pela tarefa)
router.post("/tasks/:id", requireTeam, async (req: Request, res: Response) => {
  const done = req.body?.done !== false;
  try {
    const row = await queryOne(
      `UPDATE event_tasks SET done = $1,
              done_at = CASE WHEN $1 THEN NOW() ELSE NULL END,
              done_by = CASE WHEN $1 THEN $2::uuid ELSE NULL END
        WHERE id = $3 AND assignee_id = $2 RETURNING id`,
      [done, req.auth!.userId, req.params.id]
    );
    return row ? res.json({ success: true }) : res.status(404).json({ error: "Tarefa não encontrada" });
  } catch (error) {
    return res.status(400).json({ error: "Tarefa inválida" });
  }
});

// POST /api/home/acks/:id/confirm  (confirma uma confirmação minha)
router.post("/acks/:id/confirm", requireTeam, async (req: Request, res: Response) => {
  try {
    const row = await queryOne(
      "UPDATE acknowledgements SET confirmed_at = NOW() WHERE id = $1 AND user_id = $2 AND confirmed_at IS NULL RETURNING id",
      [req.params.id, req.auth!.userId]
    );
    return row ? res.json({ success: true }) : res.status(404).json({ error: "Confirmação não encontrada" });
  } catch (error) {
    return res.status(400).json({ error: "Confirmação inválida" });
  }
});

// PATCH /api/home/roster/:id  { checked: number[] }  (checklist da minha escala)
router.patch("/roster/:id", requireTeam, async (req: Request, res: Response) => {
  const checked = Array.isArray(req.body?.checked) ? req.body.checked.filter((n: unknown) => Number.isInteger(n) && (n as number) >= 0) : null;
  if (!checked) return res.status(400).json({ error: "checked deve ser uma lista" });
  try {
    const row = await queryOne(
      `UPDATE roster_entries r SET checked = $1, updated_at = NOW()
         FROM members mb
        WHERE r.id = $2 AND mb.id = r.member_id AND mb.user_id = $3
        RETURNING r.checked`,
      [JSON.stringify(Array.from(new Set(checked))), req.params.id, req.auth!.userId]
    );
    return row ? res.json(row) : res.status(404).json({ error: "Escala não encontrada" });
  } catch (error) {
    return res.status(400).json({ error: "Escala inválida" });
  }
});

// POST /api/home/requests  { kind: prayer|visit, person_name, whatsapp?, address?, preferred_time?, details? }
router.post("/requests", requireTeam, async (req: Request, res: Response) => {
  const b = req.body || {};
  const kind = b.kind === "visit" ? "visit" : b.kind === "prayer" ? "prayer" : null;
  if (!kind) return res.status(400).json({ error: "Tipo de pedido inválido" });
  const person = str(b.person_name, 120);
  const details = str(b.details, 2000);
  const address = str(b.address, 300);
  if (!person) return res.status(400).json({ error: "Informe para quem é o pedido" });
  if (kind === "prayer" && !details) return res.status(400).json({ error: "Escreva o pedido de oração" });
  if (kind === "visit" && !address) return res.status(400).json({ error: "Informe o endereço da visita" });
  const digits = str(b.whatsapp, 30).replace(/\D/g, "");
  try {
    const row = await queryOne(
      `INSERT INTO pastoral_requests (kind, requested_by, person_name, whatsapp, address, preferred_time, details)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id, kind, person_name, status, created_at`,
      [kind, req.auth!.userId, person, digits ? normalizePhone(digits) : null, address || null, str(b.preferred_time, 120) || null, details || null]
    );
    return res.status(201).json(row);
  } catch (error) {
    console.error("Pastoral request error:", error);
    return res.status(400).json({ error: "Dados inválidos" });
  }
});

// POST /api/home/requests/:id/done  (pastor: orado / visita feita)
router.post("/requests/:id/done", requireTeam, async (req: Request, res: Response) => {
  try {
    if (!(await isPastor(req))) return res.status(403).json({ error: "Acesso negado" });
    const row = await queryOne(
      "UPDATE pastoral_requests SET status = 'done', handled_by = $1, handled_at = NOW() WHERE id = $2 RETURNING id",
      [req.auth!.userId, req.params.id]
    );
    return row ? res.json({ success: true }) : res.status(404).json({ error: "Pedido não encontrado" });
  } catch (error) {
    return res.status(400).json({ error: "Pedido inválido" });
  }
});

// POST /api/home/people/:id/contacted  (pastor: visitante já procurado)
router.post("/people/:id/contacted", requireTeam, async (req: Request, res: Response) => {
  try {
    if (!(await isPastor(req))) return res.status(403).json({ error: "Acesso negado" });
    const row = await queryOne(
      "UPDATE people SET contacted_at = NOW(), contacted_by = $1 WHERE id = $2 RETURNING id",
      [req.auth!.userId, req.params.id]
    );
    return row ? res.json({ success: true }) : res.status(404).json({ error: "Cadastro não encontrado" });
  } catch (error) {
    return res.status(400).json({ error: "Cadastro inválido" });
  }
});

export default router;
