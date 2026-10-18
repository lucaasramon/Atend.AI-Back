import { Router, Request, Response } from "express";
import { query, queryOne } from "../db";
import { requireAdmin, requireRole } from "../middleware/auth";
import { fetchGroups } from "../services/evolution";
import { EVENT_COLUMNS, locationLabel } from "../services/eventData";
import { adminIds, appUrl, notifyUsers } from "../services/notify";
import { eventOffsets, getAllowedGroups, getReminderSettings, parseOffsets, renderMessage, reminderSendAt, runReminders, TZ } from "../services/reminders";
import { runRemindersIfPastToday } from "../services/scheduler";
import { previewSummary, SummaryKind } from "../services/summaries";
import { occurrences, validateRepeat } from "../services/recurrence";
import { onEventsApproved } from "../services/acks";
import { canManageEvent, userMinistryIds } from "../services/userAreas";
import crypto from "crypto";

const router = Router();

const NO_AREA = "Seu usuário ainda não tem área definida. Peça a um administrador para incluir sua área em Usuários.";
const NOT_YOUR_AREA = "Você só pode alterar eventos das suas áreas.";

/** Quem não é admin só cria eventos das suas áreas (e precisa escolher pelo menos uma) */
async function checkOwnAreas(req: Request, chosen: string[]): Promise<{ status: number; error: string } | null> {
  if (req.auth!.role === "admin") return null;
  const own = await userMinistryIds(req.auth!.userId);
  if (!own.length) return { status: 403, error: NO_AREA };
  if (!chosen.length) return { status: 400, error: "Escolha a área (ministério) do evento" };
  if (chosen.some((id) => !own.includes(id))) return { status: 403, error: "Você só pode criar eventos das suas áreas." };
  return null;
}

// Categorias (cada uma tem uma cor no calendário)
const CATEGORIES = ["culto", "conferencia", "reuniao", "ensaio", "evento", "acao_social", "outro"];

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
                        FROM event_reminders_sent r WHERE r.event_id = e.id), '[]') AS reminders,
            (SELECT COUNT(*)::int FROM event_tasks t WHERE t.event_id = e.id) AS tasks_total,
            (SELECT COUNT(*)::int FROM event_tasks t WHERE t.event_id = e.id AND t.done) AS tasks_done
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
    ...(ev.series_count > 1 ? [`🔁 Evento recorrente: ${ev.series_count} datas`] : []),
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
                          FROM event_reminders_sent r WHERE r.event_id = e.id), '[]') AS reminders,
            (SELECT COUNT(*)::int FROM event_tasks t WHERE t.event_id = e.id) AS tasks_total,
            (SELECT COUNT(*)::int FROM event_tasks t WHERE t.event_id = e.id AND t.done) AS tasks_done
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

interface NewEvent {
  title: string;
  description?: string | null;
  location?: string | null;
  starts_at: Date | string;
  ends_at?: Date | string | null;
  is_public?: boolean;
  group_jid?: string | null;
  reminder_offsets?: number[] | null;
  category?: string | null;
  series_id?: string | null;
  ministry_ids?: string[];
  location_ids?: string[];
}

/** Cria um evento com vínculos; se o vínculo falhar, desfaz (não deixa evento pela metade) */
async function insertEvent(e: NewEvent, userId: string, approved: boolean, isAdmin: boolean): Promise<string> {
  const row = await queryOne<{ id: string }>(
    `INSERT INTO events (title, description, location, starts_at, ends_at, is_public, group_jid, reminder_offsets,
                         category, series_id, created_by, status, approved_by, approved_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::varchar, $13, CASE WHEN $12::varchar = 'approved' THEN NOW() END)
     RETURNING id`,
    [
      e.title, e.description || null, e.location || null, e.starts_at, e.ends_at || null, e.is_public ?? true,
      e.group_jid || null, e.reminder_offsets ?? null, e.category || null, e.series_id || null, userId,
      approved ? "approved" : "pending", approved && isAdmin ? userId : null,
    ]
  );
  try {
    await setLinks(row!.id, e.ministry_ids, e.location_ids);
  } catch (err) {
    await query("DELETE FROM events WHERE id = $1", [row!.id]).catch(() => {});
    throw err;
  }
  return row!.id;
}

// POST /api/events  (com "repeat" cria a série de eventos recorrentes)
router.post("/", requireEditor, async (req: Request, res: Response) => {
  const { title, description, location, starts_at, ends_at, is_public, group_jid, category, repeat } = req.body;
  const offsets = bodyOffsets(req.body.reminder_offsets);
  if (!title || !starts_at) return res.status(400).json({ error: "title e starts_at são obrigatórios" });
  if (category && !CATEGORIES.includes(category)) return res.status(400).json({ error: "Categoria inválida" });
  const repeatError = validateRepeat(repeat);
  if (repeatError) return res.status(400).json({ error: repeatError });
  if (group_jid && !(await getAllowedGroups()).includes(group_jid)) {
    return res.status(400).json({ error: "group_jid não permitido: use um grupo de allowed_groups" });
  }

  const created: string[] = [];
  try {
    const isAdmin = req.auth!.role === "admin";
    const areaError = await checkOwnAreas(req, bodyIds(req.body.ministry_ids) || []);
    if (areaError) return res.status(areaError.status).json({ error: areaError.error });
    const approved = isAdmin || !(await approvalRequired());
    const base: NewEvent = {
      title, description, location, starts_at, ends_at, is_public, group_jid, category,
      reminder_offsets: offsets.value,
      ministry_ids: bodyIds(req.body.ministry_ids),
      location_ids: bodyIds(req.body.location_ids),
    };

    const dates = repeat
      ? occurrences(new Date(starts_at), ends_at ? new Date(ends_at) : null, repeat)
      : [{ starts_at: new Date(starts_at), ends_at: ends_at ? new Date(ends_at) : null }];
    if (!dates.length) return res.status(400).json({ error: "Nenhuma data no período de repetição" });
    const seriesId = dates.length > 1 ? crypto.randomUUID() : null;

    for (const d of dates) {
      created.push(await insertEvent({ ...base, ...d, series_id: seriesId }, req.auth!.userId, approved, isAdmin));
    }
    const ev = await fullEvent(created[0]);

    if (approved) {
      runRemindersIfPastToday();
      onEventsApproved(created).catch((err) => console.error("onEventsApproved:", err));
    } else notifyApprovers({ ...ev, series_count: created.length }, false).catch((err) => console.error("notifyApprovers:", err));
    return res.status(201).json({ ...ev, series_count: created.length });
  } catch (error) {
    console.error("Create event error:", error);
    // Falhou no meio da série: desfaz o que já foi criado
    if (created.length) await query("DELETE FROM events WHERE id = ANY($1)", [created]).catch(() => {});
    return res.status(400).json({ error: "Dados inválidos" });
  }
});

// POST /api/events/import  { events: [...] }  (calendário anual em lote)
// Cada item: { title, starts_at, ends_at?, location?, description?, category?, is_public?, ministries?: nomes[], locations?: nomes[] }
router.post("/import", requireEditor, async (req: Request, res: Response) => {
  const items: any[] = Array.isArray(req.body.events) ? req.body.events : [];
  if (!items.length) return res.status(400).json({ error: "Nenhum evento para importar" });
  if (items.length > 500) return res.status(400).json({ error: "Máximo de 500 eventos por importação" });

  try {
    const isAdmin = req.auth!.role === "admin";
    const approved = isAdmin || !(await approvalRequired());
    const ministries = await query<{ id: string; name: string }>("SELECT id, name FROM ministries");
    const locations = await query<{ id: string; name: string }>("SELECT id, name FROM locations");
    const byName = (list: { id: string; name: string }[], names: unknown) =>
      (Array.isArray(names) ? names : [])
        .map((n) => list.find((x) => x.name.toLowerCase() === String(n).trim().toLowerCase())?.id)
        .filter(Boolean) as string[];

    // Quem não é admin só importa eventos das suas áreas
    const own = isAdmin ? null : await userMinistryIds(req.auth!.userId);
    if (own && !own.length) return res.status(403).json({ error: NO_AREA });

    const errors: { row: number; error: string }[] = [];
    const createdIds: string[] = [];
    for (const [i, it] of items.entries()) {
      let ministryIds = byName(ministries, it.ministries);
      if (own) {
        const asked = Array.isArray(it.ministries) && it.ministries.length > 0;
        if (ministryIds.some((id) => !own.includes(id)) || (asked && !ministryIds.length)) {
          errors.push({ row: i + 1, error: "Você só pode importar eventos das suas áreas" });
          continue;
        }
        // Coluna vazia: usa a área da pessoa (se ela tiver uma só)
        if (!ministryIds.length && own.length === 1) ministryIds = own;
        if (!ministryIds.length) {
          errors.push({ row: i + 1, error: "Informe uma das suas áreas na coluna ministerios" });
          continue;
        }
      }
      const start = new Date(it.starts_at);
      if (!String(it.title || "").trim() || isNaN(start.getTime())) {
        errors.push({ row: i + 1, error: "Título ou data inválidos" });
        continue;
      }
      if (it.category && !CATEGORIES.includes(it.category)) {
        errors.push({ row: i + 1, error: `Categoria inválida: ${it.category}` });
        continue;
      }
      try {
        const id = await insertEvent(
          {
            title: String(it.title).trim(),
            description: it.description,
            location: it.location,
            starts_at: start,
            ends_at: it.ends_at ? new Date(it.ends_at) : null,
            is_public: it.is_public !== false,
            category: it.category || null,
            ministry_ids: ministryIds,
            location_ids: byName(locations, it.locations),
          },
          req.auth!.userId, approved, isAdmin
        );
        createdIds.push(id);
      } catch {
        errors.push({ row: i + 1, error: "Não foi possível salvar" });
      }
    }
    const createdCount = createdIds.length;

    if (createdCount) {
      if (approved) {
        runRemindersIfPastToday();
        onEventsApproved(createdIds).catch((err) => console.error("onEventsApproved:", err));
      } else {
        notifyUsers(
          await adminIds(),
          `📝 *${createdCount} eventos importados aguardando aprovação*\n\nAprovar: ${appUrl()}/admin/aprovacoes`
        ).catch(() => {});
      }
    }
    return res.json({ created: createdCount, errors, status: approved ? "approved" : "pending" });
  } catch (error) {
    console.error("Import events error:", error);
    return res.status(500).json({ error: "Erro interno do servidor" });
  }
});

// PATCH /api/events/:id
router.patch("/:id", requireEditor, async (req: Request, res: Response) => {
  const { title, description, location, starts_at, ends_at, is_public, group_jid, category } = req.body;
  const offsets = bodyOffsets(req.body.reminder_offsets);
  let ministryIds = bodyIds(req.body.ministry_ids);
  const locationIds = bodyIds(req.body.location_ids);
  if (category && !CATEGORIES.includes(category)) return res.status(400).json({ error: "Categoria inválida" });
  if (group_jid && !(await getAllowedGroups()).includes(group_jid)) {
    return res.status(400).json({ error: "group_jid não permitido: use um grupo de allowed_groups" });
  }
  try {
    const before = await fullEvent(req.params.id);
    if (!before) return res.status(404).json({ error: "Evento não encontrado" });
    if (!(await canManageEvent(req.auth!.userId, req.auth!.role, req.params.id))) {
      return res.status(403).json({ error: NOT_YOUR_AREA });
    }

    // Quem não é admin só mexe nas suas áreas; as áreas dos outros no evento ficam como estão
    if (req.auth!.role !== "admin" && ministryIds) {
      const own = await userMinistryIds(req.auth!.userId);
      const chosen = ministryIds.filter((id) => own.includes(id));
      if (!chosen.length) return res.status(400).json({ error: "Escolha pelo menos uma das suas áreas" });
      const foreign = (before.ministries as { id: string }[]).map((m) => m.id).filter((id) => !own.includes(id));
      ministryIds = [...chosen, ...foreign];
    }

    await queryOne(
      `UPDATE events SET
         title = COALESCE($1, title),
         description = COALESCE($2, description),
         location = COALESCE($3, location),
         starts_at = COALESCE($4, starts_at),
         ends_at = CASE WHEN $11 THEN $5::timestamptz ELSE ends_at END,
         is_public = COALESCE($6, is_public),
         group_jid = CASE WHEN $8::text IS NULL THEN group_jid ELSE NULLIF($8, '') END,
         reminder_offsets = CASE WHEN $9 THEN $10::int[] ELSE reminder_offsets END,
         category = CASE WHEN $12 THEN NULLIF($13, '') ELSE category END
       WHERE id = $7`,
      [title ?? null, description ?? null, location ?? null, starts_at ?? null, ends_at ?? null, is_public ?? null,
       req.params.id, group_jid ?? null, offsets.set, offsets.value, "ends_at" in req.body,
       "category" in req.body, category ?? ""]
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
      // Ministério novo no evento: pede confirmação a ele (os que já confirmaram não recebem de novo)
      onEventsApproved([req.params.id]).catch((err) => console.error("onEventsApproved:", err));
    }

    return res.json(ev);
  } catch (error) {
    return res.status(400).json({ error: "Dados inválidos" });
  }
});

/** O evento e, se for de uma série, as demais datas pendentes da mesma série */
const SAME_SERIES_PENDING = `(id = $2 OR (status = 'pending' AND series_id IS NOT NULL
                                AND series_id = (SELECT series_id FROM events WHERE id = $2)))`;

// POST /api/events/:id/approve  (admin — aprova também as datas pendentes da mesma série)
router.post("/:id/approve", requireAdmin, async (req: Request, res: Response) => {
  try {
    const rows = await query<{ id: string; created_by: string | null }>(
      `UPDATE events SET status = 'approved', approved_by = $1, approved_at = NOW(), rejection_reason = NULL
        WHERE ${SAME_SERIES_PENDING} RETURNING id, created_by`,
      [req.auth!.userId, req.params.id]
    );
    const row = rows.find((r) => r.id === req.params.id);
    if (!row) return res.status(404).json({ error: "Evento não encontrado" });
    const ev = await fullEvent(row.id);
    runRemindersIfPastToday();
    onEventsApproved(rows.map((r) => r.id)).catch((err) => console.error("onEventsApproved:", err));
    if (row.created_by && row.created_by !== req.auth!.userId) {
      const series = rows.length > 1 ? ` e mais ${rows.length - 1} data(s) da série` : "";
      notifyUsers([row.created_by], `✅ Seu evento *${ev.title}* (${whenText(ev.starts_at)})${series} foi aprovado e já está na agenda.`)
        .catch(() => {});
    }
    return res.json({ ...ev, approved_count: rows.length });
  } catch (error) {
    return res.status(500).json({ error: "Erro interno do servidor" });
  }
});

// POST /api/events/:id/reject  { reason }  (admin)
router.post("/:id/reject", requireAdmin, async (req: Request, res: Response) => {
  const reason = String(req.body.reason || "").trim();
  try {
    const rows = await query<{ id: string; created_by: string | null }>(
      `UPDATE events SET status = 'rejected', approved_by = $1, approved_at = NOW(), rejection_reason = NULLIF($3, '')
        WHERE ${SAME_SERIES_PENDING} RETURNING id, created_by`,
      [req.auth!.userId, req.params.id, reason]
    );
    const row = rows.find((r) => r.id === req.params.id);
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

// DELETE /api/events/:id?scope=future  (future: esta e as próximas datas da mesma série)
router.delete("/:id", requireEditor, async (req: Request, res: Response) => {
  try {
    if (!(await canManageEvent(req.auth!.userId, req.auth!.role, req.params.id))) {
      return res.status(403).json({ error: NOT_YOUR_AREA });
    }
    const rows =
      req.query.scope === "future"
        ? await query(
            `DELETE FROM events
              WHERE id = $1
                 OR (series_id IS NOT NULL
                     AND series_id = (SELECT series_id FROM events WHERE id = $1)
                     AND starts_at >= (SELECT starts_at FROM events WHERE id = $1))
              RETURNING id`,
            [req.params.id]
          )
        : await query("DELETE FROM events WHERE id = $1 RETURNING id", [req.params.id]);
    return res.json({ success: true, deleted: rows.length });
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
// Responde na hora: com as pausas entre mensagens a rodada pode levar alguns minutos
router.post("/reminders/run", requireAdmin, async (_req: Request, res: Response) => {
  runReminders()
    .then((r) => console.log("[agendador] lembretes (rodar agora):", JSON.stringify(r)))
    .catch((err) => console.error("[agendador] falha (rodar agora):", err));
  return res.json({ started: true });
});

export default router;
