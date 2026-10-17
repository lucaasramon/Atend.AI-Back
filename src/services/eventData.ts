/**
 * Consulta padrão de eventos com ministérios e locais agregados.
 * Use `EVENT_COLUMNS` num SELECT ... FROM events e.
 */

export interface EventMinistry {
  id: string;
  name: string;
  color: string | null;
  group_jid: string | null;
}

export interface EventLocation {
  id: string;
  name: string;
}

export const EVENT_COLUMNS = `
  e.*,
  COALESCE((
    SELECT json_agg(json_build_object('id', m.id, 'name', m.name, 'color', m.color, 'group_jid', m.group_jid) ORDER BY m.name)
      FROM event_ministries em JOIN ministries m ON m.id = em.ministry_id
     WHERE em.event_id = e.id
  ), '[]') AS ministries,
  COALESCE((
    SELECT json_agg(json_build_object('id', l.id, 'name', l.name) ORDER BY l.name)
      FROM event_locations el JOIN locations l ON l.id = el.location_id
     WHERE el.event_id = e.id
  ), '[]') AS locations`;

/** "Templo, Sala das Crianças — entrada lateral" (locais cadastrados + observação livre) */
export function locationLabel(ev: { location?: string | null; locations?: EventLocation[] }): string {
  const names = (ev.locations || []).map((l) => l.name).join(", ");
  const free = (ev.location || "").trim();
  if (names && free) return `${names} — ${free}`;
  return names || free;
}
