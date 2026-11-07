/**
 * Músicas da escala do louvor, ligadas ao Holyrics.
 *
 * O que a API do Holyrics 2.30 faz de forma confiável (testado):
 *  - buscar na biblioteca (SearchLyrics), criar música só com o nome (CreateSong), criar culto (CreateEvent);
 *  - ADICIONAR na lista de MÍDIA de um culto que não está aberto (AddToPlaylist + event_id + index).
 * O que NÃO funciona: remover/reordenar itens (RemoveFromMediaPlaylist ignora ou remove o item errado).
 * Por isso a plataforma só adiciona; quando o louvor tira ou reordena, avisa a Mídia para ajustar no Holyrics.
 */
import { query, queryOne } from "../db";
import { holyrics } from "./holyrics";
import { notifyUsers, adminIds } from "./notify";
import { mediaUserIds } from "./screenRequests";
import { TZ } from "./reminders";

export interface SentSong {
  id: string;
  title: string;
}

/** Admin, ou quem tem (ou lidera) uma área marcada como Louvor */
export async function hasWorshipAccess(userId: string, role: string): Promise<boolean> {
  if (role === "admin") return true;
  if (role !== "agenda" && role !== "viewer") return false;
  const row = await queryOne(
    `SELECT 1 FROM ministries m
      WHERE m.is_worship
        AND (m.leader_id = $1 OR EXISTS (SELECT 1 FROM user_ministries um WHERE um.ministry_id = m.id AND um.user_id = $1))
      LIMIT 1`,
    [userId]
  );
  return !!row;
}

/** Busca na biblioteca do Holyrics (só nome e artista, nunca a letra) */
export async function searchLibrary(text: string) {
  const rows = (await holyrics<any[]>("SearchLyrics", { text, title: true, artist: true, fields: "id,title,artist,archived" })) || [];
  return rows
    .filter((r) => !r.archived)
    .slice(0, 20)
    .map((r) => ({ id: String(r.id), title: String(r.title || "").trim(), artist: String(r.artist || "").trim() }));
}

/** Cria a música no Holyrics só com o nome (a Mídia completa a letra pela busca do próprio Holyrics) */
export async function createSong(title: string, artist: string) {
  const song = await holyrics<any>("CreateSong", { title, artist, slides: [] });
  if (!song?.id) throw new Error("O Holyrics não devolveu o id da música criada");
  return { id: String(song.id), title: String(song.title || title).trim(), artist: String(song.artist || artist).trim() };
}

/** A música criada pela plataforma já ganhou letra no Holyrics? */
export async function hasLyrics(holyricsId: string): Promise<boolean> {
  const song = await holyrics<any>("GetLyrics", { id: holyricsId, fields: "slides" });
  return Array.isArray(song?.slides) && song.slides.some((s: any) => String(s?.text || "").trim());
}

/** "2026-11-09 19:00" no fuso da igreja (formato do Holyrics) */
const holyricsDatetime = (d: Date) => d.toLocaleString("sv-SE", { timeZone: TZ }).slice(0, 16);

/** Culto no Holyrics: o já ligado, ou um com o mesmo dia e hora, ou cria um novo */
async function holyricsEvent(stored: string | null, title: string, startsAt: Date) {
  const datetime = holyricsDatetime(startsAt);
  const [year, month] = datetime.split("-").map(Number);
  const list = (await holyrics<any[]>("GetSchedules", { month, year })) || [];
  const found =
    (stored && list.find((s) => s.metadata?.event?.id === stored)) ||
    list.find((s) => s.type !== "temporary" && s.datetime === datetime && s.metadata?.event?.id);
  if (found) return { id: String(found.metadata.event.id), media: (found.media_playlist || []) as any[] };
  const created = await holyrics<any>("CreateEvent", { name: title, datetime });
  if (!created?.id) throw new Error("O Holyrics não devolveu o id do culto criado");
  return { id: String(created.id), media: [] as any[] };
}

const songsOf = (eventId: string) =>
  query<{ id: string; holyrics_id: string; title: string; artist: string | null; lyrics_pending: boolean; position: number }>(
    "SELECT id, holyrics_id, title, artist, lyrics_pending, position FROM event_songs WHERE event_id = $1 ORDER BY position, created_at",
    [eventId]
  );

const stateOf = (eventId: string) =>
  queryOne<{ holyrics_event_id: string | null; sent_songs: SentSong[]; synced_at: string | null; sync_error: string | null }>(
    "SELECT holyrics_event_id, sent_songs, synced_at, sync_error FROM event_holyrics WHERE event_id = $1",
    [eventId]
  );

async function saveState(eventId: string, patch: { holyrics_event_id?: string | null; sent_songs?: SentSong[]; synced?: boolean; sync_error?: string | null }) {
  await query(
    `INSERT INTO event_holyrics (event_id, holyrics_event_id, sent_songs, synced_at, sync_error)
     VALUES ($1, $2, COALESCE($3::jsonb, '[]'), CASE WHEN $4 THEN NOW() END, $5)
     ON CONFLICT (event_id) DO UPDATE SET
       holyrics_event_id = COALESCE($2, event_holyrics.holyrics_event_id),
       sent_songs        = COALESCE($3::jsonb, event_holyrics.sent_songs),
       synced_at         = CASE WHEN $4 THEN NOW() ELSE event_holyrics.synced_at END,
       sync_error        = $5,
       updated_at        = NOW()`,
    [eventId, patch.holyrics_event_id ?? null, patch.sent_songs ? JSON.stringify(patch.sent_songs) : null, !!patch.synced, patch.sync_error ?? null]
  );
}

/** Um envio por culto de cada vez (dois cliques seguidos não duplicam a música no Holyrics) */
const running = new Map<string, Promise<void>>();

/**
 * Põe no Holyrics as músicas que ainda não foram (no fim da lista de mídia do culto, na ordem da plataforma).
 * Não lança erro: guarda a mensagem em event_holyrics.sync_error para a tela mostrar.
 */
export function syncEvent(eventId: string): Promise<void> {
  const prev = running.get(eventId) || Promise.resolve();
  const next = prev.then(() => doSync(eventId)).catch(() => {});
  running.set(eventId, next);
  next.finally(() => running.get(eventId) === next && running.delete(eventId));
  return next;
}

async function doSync(eventId: string) {
  const event = await queryOne<{ title: string; starts_at: Date }>("SELECT title, starts_at FROM events WHERE id = $1", [eventId]);
  if (!event) return;
  const songs = await songsOf(eventId);
  const state = await stateOf(eventId);
  const sent = state?.sent_songs || [];
  const sentIds = new Set(sent.map((s) => s.id));
  const pending = songs.filter((s) => !sentIds.has(s.holyrics_id));
  if (!pending.length) {
    await saveState(eventId, { synced: true, sync_error: null });
    return;
  }
  try {
    const target = await holyricsEvent(state?.holyrics_event_id || null, event.title, new Date(event.starts_at));
    // Já está na lista (a Mídia pode ter posto à mão): não duplica
    const inList = new Set(target.media.filter((i) => i.type === "song").map((i) => String(i.song_id || i.reference_id || "")));
    let index = target.media.length; // sem "index" o Holyrics põe no começo
    const added: SentSong[] = [];
    for (const s of pending) {
      if (!inList.has(s.holyrics_id)) {
        await holyrics("AddToPlaylist", { items: [{ type: "song", id: s.holyrics_id }], index, event_id: target.id });
        index++;
      }
      added.push({ id: s.holyrics_id, title: s.title });
    }
    await saveState(eventId, { holyrics_event_id: target.id, sent_songs: [...sent, ...added], synced: true, sync_error: null });
  } catch (e) {
    console.error("[worship] envio ao Holyrics falhou:", e);
    await saveState(eventId, { sync_error: (e as Error).message || "Não foi possível enviar ao Holyrics" });
  }
}

/** O que a Mídia precisa ajustar à mão no Holyrics (o que saiu e se a ordem mudou) */
export async function adjustments(eventId: string) {
  const [songs, state] = await Promise.all([songsOf(eventId), stateOf(eventId)]);
  const sent = state?.sent_songs || [];
  const current = new Set(songs.map((s) => s.holyrics_id));
  const remove = sent.filter((s) => !current.has(s.id));
  const sentOrder = sent.filter((s) => current.has(s.id)).map((s) => s.id);
  const inBoth = new Set(sentOrder);
  const nowOrder = songs.filter((s) => inBoth.has(s.holyrics_id)).map((s) => s.holyrics_id);
  const orderChanged = sentOrder.join(",") !== nowOrder.join(",");
  return { remove, order_changed: orderChanged };
}

/** A Mídia ajustou no Holyrics: o que está lá passa a ser igual à lista da plataforma */
export async function markAdjusted(eventId: string) {
  const songs = await songsOf(eventId);
  const state = await stateOf(eventId);
  const sentIds = new Set((state?.sent_songs || []).map((s) => s.id));
  // Mantém só as que já tinham ido; as que faltam vão no próximo envio
  const sent = songs.filter((s) => sentIds.has(s.holyrics_id)).map((s) => ({ id: s.holyrics_id, title: s.title }));
  await saveState(eventId, { sent_songs: sent, sync_error: state?.sync_error ?? null });
}

/** Aviso à Mídia: espera o louvor terminar de mexer (2 min sem mudanças) e manda um WhatsApp só */
const NOTIFY_DELAY_MS = 2 * 60_000;
const timers = new Map<string, NodeJS.Timeout>();
const lastNotice = new Map<string, string>();

export function notifyMediaLater(eventId: string) {
  clearTimeout(timers.get(eventId));
  timers.set(
    eventId,
    setTimeout(() => {
      timers.delete(eventId);
      notifyMedia(eventId).catch((e) => console.error("[worship] aviso à Mídia falhou:", e));
    }, NOTIFY_DELAY_MS)
  );
}

async function notifyMedia(eventId: string) {
  const { remove, order_changed } = await adjustments(eventId);
  if (!remove.length && !order_changed) return;
  const event = await queryOne<{ title: string; starts_at: Date }>("SELECT title, starts_at FROM events WHERE id = $1", [eventId]);
  if (!event) return;
  const songs = await songsOf(eventId);
  const when = new Date(event.starts_at).toLocaleString("pt-BR", { timeZone: TZ, day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
  const text = [
    `🎵 O louvor de *${event.title}* (${when}) mudou.`,
    "No Holyrics, ajuste a *lista de mídia* desse culto:",
    remove.length ? `\n❌ Tirar: ${remove.map((s) => s.title).join(", ")}` : "",
    order_changed ? `\n🔀 Ordem nova:\n${songs.map((s, i) => `${i + 1}. ${s.title}`).join("\n")}` : "",
    "\nDepois, toque em \"Já ajustei no Holyrics\" nas músicas do louvor, na tela Escalas.",
  ]
    .filter(Boolean)
    .join("\n");
  if (lastNotice.get(eventId) === text) return; // mesma mudança: não repete
  lastNotice.set(eventId, text);
  const ids = await mediaUserIds();
  await notifyUsers(ids.length ? ids : await adminIds(), text);
}
