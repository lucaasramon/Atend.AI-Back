import { Router, Request, Response } from "express";
import { query, queryOne } from "../db";
import { requireAdmin, requireRole } from "../middleware/auth";
import { fetchGroups } from "../services/evolution";
import { EVENT_COLUMNS, locationLabel } from "../services/eventData";
import { adminIds, appUrl, notifyUsers } from "../services/notify";
import { eventOffsets, getAllowedGroups, getReminderSettings, parseOffsets, renderMessage, reminderSendAt, runReminders, TZ } from "../services/reminders";
import { runRemindersIfPastToday } from "../services/scheduler";
import { previewSummary, SummaryKind } from "../services/summaries";

const router = Router();

// Admin e usuário "agenda" podem gerenciar eventos; "viewer" só visualiza
const requireEditor = requireRole("admin", "agenda");
const requireReader = requireRole("admin", "agenda", "viewer");

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** reminder_offsets do corpo: undefined = não mexe; null/"" /[] = volta ao padrão; lista = próprias */
function bodyOffsets(v: unknown): { set: boolean; value: number[] | null } {
  if (v === undefined) return { set: false, value: null };
  const list = parseOffsets(v as any);
  return { set: true, value: list.length ? list : null };
}

/** Lista de ids do corpo: undefined = não mexe; senão lista válida (pode ser vazia) */
function bodyIds(v: unknown): string[] | undefined {
  if (v === undefined) return undefined;
  if (!Array.isArray(v)) return [];
  return Array.from(new Set(v.filter((x) => typeof x === "string" && UUID_RE.test(x))));
}

async function approvalRequired(): Promise<boolean> {
  const row = await queryOne<{ value: string }>("SELECT value FROM system_settings WHERE key = 'approval_required'");
  return row?.value !== "false";
}

/** Substitui os ministérios/locais do evento (quando enviados) */
async function setLinks(eventId: string, ministryIds?: string[], locationIds?: string[]) {
  if (ministryIds) {
    await query("DELETE FROM event_ministries WHERE event_id = $1", [eventId]);
    if (ministryIds.length) {
      await query(
        "INSERT INTO event_ministries (event_id, ministry_id) SELECT $1, unnest($2::uuid[]) ON CONFLICT DO NOTHING",
        [eventId, ministryIds]
      );
    }
  }
  if (locationIds) {
    await query("DELETE FROM event_locations WHERE event_id = $1", [eventId]);
    if (locationIds.length) {
      await query(
        "INSERT INTO event_locations (event_id, location_id) SELECT $1, unnest($2::uuid[]) ON CONFLICT DO NOTHING",
        [eventId, locationIds]
      );
    }
  }
}

const fullEvent = (id: string) =>
  queryOne<any>(
    `SELECT ${EVENT_COLUMNS},
            c.full_name AS created_by_name, a.full_name AS approved_by_name,
            COALESCE((SELECT json_agg(json_build_object('offset_days', r.offset_days, 'status', r.status, 'sent_at', r.sent_at))
                        FROM event_reminders_sent r WHERE r.event_id = e.id), '[]') AS reminders
       FROM events e
       LEFT JOIN users c ON c.id = e.created_by
       LEFT JOIN users a ON a.id = e.approved_by
      WHERE e.id = $1`,
    [id]
  );

const whenText = (d: Date) =>
  new Date(d).toLocaleString("pt-BR", { timeZone: TZ, weekday: "short", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });

/** Avisa os admins (com WhatsApp) que há evento esperando aprovação */
async function notifyApprovers(ev: any, changed: boolean) {
  const who = ev.created_by_name ? ` por ${ev.created_by_name}` : "";
  const where = locationLabel(ev);
  const text = [
    changed ? "✏️ *Evento alterado — precisa de nova aprovação*" : "📝 *Novo evento aguardando aprovação*",
    "",
    `*${ev.title}*`,
    `🗓️ ${whenText(ev.starts_at)}${where ? `\n📍 ${where}` : ""}`,
    `👤 Cadastrado${who}`,
    "",
    `Aprovar ou recusar: ${appUrl()}/admin/aprovacoes`,
  ].join("\n");
  await notifyUsers(await adminIds(), text);
}

const PUBLIC_FIELDS = "id, title, description, location, starts_at, ends_at";

// GET /api/events/public?from=2026-10-01&to=2026-10-31  (sem login — calendário público)
router.get("/public", async (req: Request, res: Response) => {
  const { from, to } = req.query as { from?: string; to?: string };
  try {
    const rows = await query<any>(
      `SELECT ${EVENT_COLUMNS} FROM events e
        WHERE e.is_public = true AND e.status = 'approved'
          AND ($1::timestamptz IS NULL OR e.starts_at >= $1)
          AND ($2::timestamptz IS NULL OR e.starts_at <= $2)
        ORDER BY e.starts_at ASC`,
      [from || null, to || null]
    );
    const fields = PUBLIC_FIELDS.split(", ");
    return res.json(
      rows.map((r) => ({
        ...Object.fromEntries(fields.map((f) => [f, r[f]])),
        location: locationLabel(r) || null,
        ministries: r.ministries.map((m: any) => m.name),
      }))
    );
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
      approval_required: await approvalRequired(),
    });
  } catch (error) {
    return res.status(500).json({ error: "Erro interno do servidor" });
  }
});

// GET /api/events/conflicts?starts_at=&ends_at=&location=&location_ids=a,b&ministry_ids=a,b&exclude_id=
// Eventos que se sobrepõem ao horário informado (sem término, considera 2h de duração)
router.get("/conflicts", requireEditor, async (req: Request, res: Response) => {
  const q = req.query as Record<string, string | undefined>;
  if (!q.starts_at) return res.status(400).json({ error: "starts_at é obrigatório" });
  const ids = (v?: string) => (v || "").split(",").filter((x) => UUID_RE.test(x));
  try {
    const rows = await query<any>(
      `WITH me AS (
         SELECT $1::timestamptz AS s, COALESCE($2::timestamptz, $1::timestamptz + INTERVAL '2 hours') AS e
       )
       SELECT ev.id, ev.title, ev.location, ev.starts_at, ev.ends_at, ev.status,
              (NULLIF(TRIM($3), '') IS NOT NULL AND LOWER(TRIM(ev.location)) = LOWER(TRIM($3)))
                OR EXISTS (SELECT 1 FROM event_locations el WHERE el.event_id = ev.id AND el.location_id = ANY($5::uuid[]))
                AS same_location,
              EXISTS (SELECT 1 FROM event_ministries em WHERE em.event_id = ev.id AND em.ministry_id = ANY($6::uuid[]))
                AS same_ministry
         FROM events ev, me
        WHERE ev.id::text <> COALESCE($4, '')
          AND ev.status <> 'rejected'
          AND ev.starts_at < me.e
          AND COALESCE(ev.ends_at, ev.starts_at + INTERVAL '2 hours') > me.s
        ORDER BY ev.starts_at`,
      [q.starts_at, q.ends_at || null, q.location || "", q.exclude_id || null, ids(q.location_ids), ids(q.ministry_ids)]
    );
    return res.json(
      rows.map((r) => ({
        ...r,
        reason: r.same_location
          ? "Mesmo local e horário"
          : r.same_ministry
            ? "Mesmo ministério no mesmo horário"
            : "Mesmo horário",
      }))
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
      const ministries = await query<{ name: string }>("SELECT name FROM ministries WHERE group_jid = ANY($1)", [removed]);
      if (ministries.length) {
        return res.status(400).json({
          error: `Esse grupo é de um ministério: ${ministries.map((m) => m.name).join(", ")}. Troque o grupo do ministério antes.`,
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

// GET /api/events/pending-count  (admin — quantos eventos aguardam aprovação)
router.get("/pending-count", requireAdmin, async (_req: Request, res: Response) => {
  try {
    const row = await queryOne<{ count: string }>("SELECT COUNT(*) AS count FROM events WHERE status = 'pending'");
    return res.json({ count: parseInt(row!.count) });
  } catch (error) {
    return res.status(500).json({ error: "Erro interno do servidor" });
  }
});

// GET /api/events  (todos os eventos, com ministérios, locais e lembretes já enviados)
router.get("/", requireReader, async (_req: Request, res: Response) => {
  try {
    const rows = await query(
      `SELECT ${EVENT_COLUMNS},
              c.full_name AS created_by_name, a.full_name AS approved_by_name,
              COALESCE((SELECT json_agg(json_build_object('offset_days', r.offset_days, 'status', r.status, 'sent_at', r.sent_at))
                          FROM event_reminders_sent r WHERE r.event_id = e.id), '[]') AS reminders
         FROM events e
         LEFT JOIN users c ON c.id = e.created_by
         LEFT JOIN users a ON a.id = e.approved_by
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

  let createdId: string | undefined;
  try {
    const isAdmin = req.auth!.role === "admin";
    const approved = isAdmin || !(await approvalRequired());
    const row = await queryOne<{ id: string }>(
      `INSERT INTO events (title, description, location, starts_at, ends_at, is_public, group_jid, reminder_offsets,
                           created_by, status, approved_by, approved_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::varchar, $11, CASE WHEN $10::varchar = 'approved' THEN NOW() END) RETURNING id`,
      [
        title, description || null, location || null, starts_at, ends_at || null, is_public ?? true,
        group_jid || null, offsets.value, req.auth!.userId,
        approved ? "approved" : "pending", approved && isAdmin ? req.auth!.userId : null,
      ]
    );
    createdId = row!.id;
    await setLinks(row!.id, bodyIds(req.body.ministry_ids), bodyIds(req.body.location_ids));
    const ev = await fullEvent(row!.id);

    if (approved) runRemindersIfPastToday();
    else notifyApprovers(ev, false).catch((err) => console.error("notifyApprovers:", err));
    return res.status(201).json(ev);
  } catch (error) {
    console.error("Create event error:", error);
    // Falhou ao vincular ministérios/locais: não deixa o evento pela metade
    if (createdId) await query("DELETE FROM events WHERE id = $1", [createdId]).catch(() => {});
    return res.status(400).json({ error: "Dados inválidos" });
  }
});

// PATCH /api/events/:id
router.patch("/:id", requireEditor, async (req: Request, res: Response) => {
  const { title, description, location, starts_at, ends_at, is_public, group_jid } = req.body;
  const offsets = bodyOffsets(req.body.reminder_offsets);
  const ministryIds = bodyIds(req.body.ministry_ids);
  const locationIds = bodyIds(req.body.location_ids);
  if (group_jid && !(await getAllowedGroups()).includes(group_jid)) {
    return res.status(400).json({ error: "group_jid não permitido: use um grupo de allowed_groups" });
  }
  try {
    const before = await fullEvent(req.params.id);
    if (!before) return res.status(404).json({ error: "Evento não encontrado" });

    await queryOne(
      `UPDATE events SET
         title = COALESCE($1, title),
         description = COALESCE($2, description),
         location = COALESCE($3, location),
         starts_at = COALESCE($4, starts_at),
         ends_at = CASE WHEN $11 THEN $5::timestamptz ELSE ends_at END,
         is_public = COALESCE($6, is_public),
         group_jid = CASE WHEN $8::text IS NULL THEN group_jid ELSE NULLIF($8, '') END,
         reminder_offsets = CASE WHEN $9 THEN $10::int[] ELSE reminder_offsets END
       WHERE id = $7`,
      [title ?? null, description ?? null, location ?? null, starts_at ?? null, ends_at ?? null, is_public ?? null,
       req.params.id, group_jid ?? null, offsets.set, offsets.value, "ends_at" in req.body]
    );
    await setLinks(req.params.id, ministryIds, locationIds);
    let ev = await fullEvent(req.params.id);

    // Evento remarcado: zera os lembretes para que sejam reenviados com a nova data
    const dateChanged = new Date(before.starts_at).getTime() !== new Date(ev.starts_at).getTime();
    if (dateChanged) await query("DELETE FROM event_reminders_sent WHERE event_id = $1", [req.params.id]);

    // Quem não é admin: mudar data/horário/locais de evento aprovado (ou editar um recusado) volta para aprovação
    const sameIds = (a: any[], b: any[]) => a.map((x) => x.id).sort().join() === b.map((x) => x.id).sort().join();
    const scheduleChanged =
      dateChanged ||
      String(before.ends_at) !== String(ev.ends_at) ||
      !sameIds(before.locations, ev.locations);
    const needsReview =
      req.auth!.role !== "admin" &&
      (await approvalRequired()) &&
      ((before.status === "approved" && scheduleChanged) || before.status === "rejected");
    if (needsReview) {
      await query(
        "UPDATE events SET status = 'pending', approved_by = NULL, approved_at = NULL, rejection_reason = NULL WHERE id = $1",
        [req.params.id]
      );
      ev = await fullEvent(req.params.id);
      notifyApprovers(ev, before.status === "approved").catch((err) => console.error("notifyApprovers:", err));
    } else if (ev.status === "approved") {
      runRemindersIfPastToday();
    }

    return res.json(ev);
  } catch (error) {
    return res.status(400).json({ error: "Dados inválidos" });
  }
});

// POST /api/events/:id/approve  (admin)
router.post("/:id/approve", requireAdmin, async (req: Request, res: Response) => {
  try {
    const row = await queryOne<{ id: string; created_by: string | null }>(
      `UPDATE events SET status = 'approved', approved_by = $1, approved_at = NOW(), rejection_reason = NULL
        WHERE id = $2 RETURNING id, created_by`,
      [req.auth!.userId, req.params.id]
    );
    if (!row) return res.status(404).json({ error: "Evento não encontrado" });
    const ev = await fullEvent(row.id);
    runRemindersIfPastToday();
    if (row.created_by && row.created_by !== req.auth!.userId) {
      notifyUsers([row.created_by], `✅ Seu evento *${ev.title}* (${whenText(ev.starts_at)}) foi aprovado e já está na agenda.`)
        .catch(() => {});
    }
    return res.json(ev);
  } catch (error) {
    return res.status(500).json({ error: "Erro interno do servidor" });
  }
});

// POST /api/events/:id/reject  { reason }  (admin)
router.post("/:id/reject", requireAdmin, async (req: Request, res: Response) => {
  const reason = String(req.body.reason || "").trim();
  try {
    const row = await queryOne<{ id: string; created_by: string | null }>(
      `UPDATE events SET status = 'rejected', approved_by = $1, approved_at = NOW(), rejection_reason = NULLIF($2, '')
        WHERE id = $3 RETURNING id, created_by`,
      [req.auth!.userId, reason, req.params.id]
    );
    if (!row) return res.status(404).json({ error: "Evento não encontrado" });
    const ev = await fullEvent(row.id);
    if (row.created_by && row.created_by !== req.auth!.userId) {
      notifyUsers(
        [row.created_by],
        `❌ Seu evento *${ev.title}* (${whenText(ev.starts_at)}) não foi aprovado.${reason ? `\nMotivo: ${reason}` : ""}\n\nVocê pode ajustar e enviar de novo pela agenda.`
      ).catch(() => {});
    }
    return res.json(ev);
  } catch (error) {
    return res.status(500).json({ error: "Erro interno do servidor" });
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

// GET /api/events/:id/preview  (como ficará a mensagem de cada antecedência)
router.get("/:id/preview", requireReader, async (req: Request, res: Response) => {
  try {
    const ev = await fullEvent(req.params.id);
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
