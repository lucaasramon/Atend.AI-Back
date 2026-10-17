import { Router, Request, Response } from "express";
import { query, queryOne } from "../db";
import { requireAdmin, requireRole } from "../middleware/auth";
import { fetchGroups } from "../services/evolution";
import { eventOffsets, getAllowedGroups, getReminderSettings, parseOffsets, renderMessage, reminderSendAt, runReminders } from "../services/reminders";
import { runRemindersIfPastToday } from "../services/scheduler";
import { previewSummary, SummaryKind } from "../services/summaries";

const router = Router();

// Admin e usuário "agenda" podem gerenciar eventos; "viewer" só visualiza
const requireEditor = requireRole("admin", "agenda");
const requireReader = requireRole("admin", "agenda", "viewer");

/** reminder_offsets do corpo: undefined = não mexe; null/"" /[] = volta ao padrão; lista = próprias */
function bodyOffsets(v: unknown): { set: boolean; value: number[] | null } {
  if (v === undefined) return { set: false, value: null };
  const list = parseOffsets(v as any);
  return { set: true, value: list.length ? list : null };
}

const PUBLIC_FIELDS = "id, title, description, location, starts_at, ends_at";

// GET /api/events/public?from=2026-10-01&to=2026-10-31  (sem login — calendário público)
router.get("/public", async (req: Request, res: Response) => {
  const { from, to } = req.query as { from?: string; to?: string };
  try {
    const rows = await query(
      `SELECT ${PUBLIC_FIELDS} FROM events
        WHERE is_public = true
          AND ($1::timestamptz IS NULL OR starts_at >= $1)
          AND ($2::timestamptz IS NULL OR starts_at <= $2)
        ORDER BY starts_at ASC`,
      [from || null, to || null]
    );
    return res.json(rows);
  } catch (error) {
    return res.status(400).json({ error: "Parâmetros de data inválidos" });
  }
});

// GET /api/events/config  (configuração dos lembretes, somente leitura)
router.get("/config", requireReader, async (_req: Request, res: Response) => {
  try {
    const cfg = await getReminderSettings();
    const allowed = await getAllowedGroups();
    const names = await fetchGroups(cfg.instance).catch(() => []);
    return res.json({
      enabled: cfg.enabled,
      offsets: cfg.offsets,
      group_jid: cfg.groupJid,
      groups: allowed.map((id) => ({ id, subject: names.find((g) => g.id === id)?.subject || id })),
    });
  } catch (error) {
    return res.status(500).json({ error: "Erro interno do servidor" });
  }
});

// GET /api/events/conflicts?starts_at=&ends_at=&location=&exclude_id=
// Eventos que se sobrepõem ao horário informado (sem término, considera 2h de duração)
router.get("/conflicts", requireEditor, async (req: Request, res: Response) => {
  const { starts_at, ends_at, location, exclude_id } = req.query as Record<string, string | undefined>;
  if (!starts_at) return res.status(400).json({ error: "starts_at é obrigatório" });
  try {
    const rows = await query<any>(
      `WITH me AS (
         SELECT $1::timestamptz AS s, COALESCE($2::timestamptz, $1::timestamptz + INTERVAL '2 hours') AS e
       )
       SELECT ev.id, ev.title, ev.location, ev.starts_at, ev.ends_at,
              (NULLIF(TRIM($3), '') IS NOT NULL AND LOWER(TRIM(ev.location)) = LOWER(TRIM($3))) AS same_location
         FROM events ev, me
        WHERE ev.id::text <> COALESCE($4, '')
          AND ev.starts_at < me.e
          AND COALESCE(ev.ends_at, ev.starts_at + INTERVAL '2 hours') > me.s
        ORDER BY ev.starts_at`,
      [starts_at, ends_at || null, location || "", exclude_id || null]
    );
    return res.json(
      rows.map((r) => ({ ...r, reason: r.same_location ? "Mesmo local e horário" : "Mesmo horário" }))
    );
  } catch (error) {
    return res.status(400).json({ error: "Parâmetros inválidos" });
  }
});

// GET /api/events/summaries/preview?kind=weekly|monthly  (admin — prévia do resumo atual)
router.get("/summaries/preview", requireAdmin, async (req: Request, res: Response) => {
  const kind = (req.query.kind === "monthly" ? "monthly" : "weekly") as SummaryKind;
  try {
    return res.json(await previewSummary(kind));
  } catch (error) {
    return res.status(500).json({ error: "Erro interno do servidor" });
  }
});

// GET /api/events/groups  (admin — todos os grupos do robô, indicando os liberados)
router.get("/groups", requireAdmin, async (_req: Request, res: Response) => {
  try {
    const cfg = await getReminderSettings();
    const allowed = await getAllowedGroups();
    const groups = await fetchGroups(cfg.instance);
    return res.json(
      groups
        .map((g) => ({
          id: g.id,
          subject: g.subject,
          size: g.size,
          allowed: allowed.includes(g.id),
          is_default: g.id === cfg.groupJid,
        }))
        .sort((a, b) => a.subject.localeCompare(b.subject, "pt-BR"))
    );
  } catch (error: any) {
    return res.status(500).json({ error: error.message || "Erro ao listar grupos" });
  }
});

// PUT /api/events/allowed-groups  (admin — define quais grupos podem receber mensagens)
// Body: { groups: string[] }
router.put("/allowed-groups", requireAdmin, async (req: Request, res: Response) => {
  const groups: unknown = req.body?.groups;
  if (!Array.isArray(groups) || !groups.every((g) => typeof g === "string" && /^\d+@g\.us$/.test(g))) {
    return res.status(400).json({ error: "groups deve ser uma lista de IDs de grupo (xxx@g.us)" });
  }

  try {
    const cfg = await getReminderSettings();
    const current = await getAllowedGroups();
    const removed = current.filter((g) => !groups.includes(g));

    if (cfg.groupJid && removed.includes(cfg.groupJid)) {
      return res.status(400).json({ error: "O grupo padrão não pode ser bloqueado. Escolha outro grupo padrão antes." });
    }

    if (removed.length) {
      const inUse = await query<{ title: string }>(
        "SELECT title FROM events WHERE starts_at > NOW() AND group_jid = ANY($1) ORDER BY starts_at LIMIT 5",
        [removed]
      );
      if (inUse.length) {
        return res.status(400).json({
          error: `Há eventos futuros usando esse grupo: ${inUse.map((e) => e.title).join(", ")}. Mude o grupo deles antes.`,
        });
      }
    }

    await query(
      `INSERT INTO system_settings (key, value, updated_at) VALUES ('allowed_groups', $1, NOW())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
      [Array.from(new Set(groups as string[])).join(",")]
    );
    await query(
      `INSERT INTO audit_logs (admin_id, action, target_type, details) VALUES ($1, 'update_allowed_groups', 'whatsapp', $2)`,
      [req.auth!.userId, JSON.stringify({ groups })]
    );
    return res.json({ success: true, groups });
  } catch (error) {
    return res.status(500).json({ error: "Erro interno do servidor" });
  }
});

// GET /api/events  (admin — todos os eventos, com lembretes já enviados)
router.get("/", requireReader, async (_req: Request, res: Response) => {
  try {
    const rows = await query(
      `SELECT e.*,
              COALESCE(json_agg(json_build_object('offset_days', r.offset_days, 'status', r.status, 'sent_at', r.sent_at))
                FILTER (WHERE r.event_id IS NOT NULL), '[]') AS reminders
         FROM events e
         LEFT JOIN event_reminders_sent r ON r.event_id = e.id
        GROUP BY e.id
        ORDER BY e.starts_at ASC`
    );
    return res.json(rows);
  } catch (error) {
    return res.status(500).json({ error: "Erro interno do servidor" });
  }
});

// POST /api/events
router.post("/", requireEditor, async (req: Request, res: Response) => {
  const { title, description, location, starts_at, ends_at, is_public, group_jid } = req.body;
  const offsets = bodyOffsets(req.body.reminder_offsets);
  if (!title || !starts_at) return res.status(400).json({ error: "title e starts_at são obrigatórios" });
  if (group_jid && !(await getAllowedGroups()).includes(group_jid)) {
    return res.status(400).json({ error: "group_jid não permitido: use um grupo de allowed_groups" });
  }

  try {
    const row = await queryOne(
      `INSERT INTO events (title, description, location, starts_at, ends_at, is_public, group_jid, reminder_offsets, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
      [title, description || null, location || null, starts_at, ends_at || null, is_public ?? true, group_jid || null, offsets.value, req.auth!.userId]
    );
    runRemindersIfPastToday();
    return res.status(201).json(row);
  } catch (error) {
    return res.status(400).json({ error: "Dados inválidos" });
  }
});

// PATCH /api/events/:id
router.patch("/:id", requireEditor, async (req: Request, res: Response) => {
  const { title, description, location, starts_at, ends_at, is_public, group_jid } = req.body;
  const offsets = bodyOffsets(req.body.reminder_offsets);
  if (group_jid && !(await getAllowedGroups()).includes(group_jid)) {
    return res.status(400).json({ error: "group_jid não permitido: use um grupo de allowed_groups" });
  }
  try {
    const before = await queryOne<{ starts_at: Date }>("SELECT starts_at FROM events WHERE id = $1", [req.params.id]);
    if (!before) return res.status(404).json({ error: "Evento não encontrado" });

    const updated = await queryOne<{ starts_at: Date }>(
      `UPDATE events SET
         title = COALESCE($1, title),
         description = COALESCE($2, description),
         location = COALESCE($3, location),
         starts_at = COALESCE($4, starts_at),
         ends_at = CASE WHEN $11 THEN $5::timestamptz ELSE ends_at END,
         is_public = COALESCE($6, is_public),
         group_jid = CASE WHEN $8::text IS NULL THEN group_jid ELSE NULLIF($8, '') END,
         reminder_offsets = CASE WHEN $9 THEN $10::int[] ELSE reminder_offsets END
       WHERE id = $7 RETURNING *`,
      [title ?? null, description ?? null, location ?? null, starts_at ?? null, ends_at ?? null, is_public ?? null, req.params.id, group_jid ?? null, offsets.set, offsets.value, "ends_at" in req.body]
    );

    // Evento remarcado: zera os lembretes para que sejam reenviados com a nova data
    if (new Date(before.starts_at).getTime() !== new Date(updated!.starts_at).getTime()) {
      await query("DELETE FROM event_reminders_sent WHERE event_id = $1", [req.params.id]);
    }

    runRemindersIfPastToday();
    return res.json(updated);
  } catch (error) {
    return res.status(400).json({ error: "Dados inválidos" });
  }
});

// DELETE /api/events/:id
router.delete("/:id", requireEditor, async (req: Request, res: Response) => {
  try {
    await query("DELETE FROM events WHERE id = $1", [req.params.id]);
    return res.json({ success: true });
  } catch (error) {
    return res.status(500).json({ error: "Erro interno do servidor" });
  }
});

// GET /api/events/:id/preview  (admin — mostra como ficará a mensagem de cada antecedência)
router.get("/:id/preview", requireReader, async (req: Request, res: Response) => {
  try {
    const ev = await queryOne<any>("SELECT * FROM events WHERE id = $1", [req.params.id]);
    if (!ev) return res.status(404).json({ error: "Evento não encontrado" });
    const cfg = await getReminderSettings();
    return res.json(
      eventOffsets(ev, cfg).map((off) => ({
        offset_days: off,
        send_at: reminderSendAt(ev.starts_at, off),
        message: renderMessage(cfg.template, ev, off),
      }))
    );
  } catch (error) {
    return res.status(500).json({ error: "Erro interno do servidor" });
  }
});

// POST /api/events/reminders/run  (admin — força uma rodada de lembretes agora)
router.post("/reminders/run", requireAdmin, async (_req: Request, res: Response) => {
  try {
    return res.json(await runReminders());
  } catch (error: any) {
    return res.status(500).json({ error: error.message || "Erro ao executar lembretes" });
  }
});

export default router;
