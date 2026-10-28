/**
 * Posição dos bairros no mapa da tela Início. Cada bairro dos Cadastros é procurado uma única vez
 * no Nominatim (OpenStreetMap) e fica salvo em neighborhood_geo. A política de uso pede no máximo
 * 1 busca por segundo e um User-Agent que identifique o sistema.
 */
import { query } from "../db";

/** Cidade da igreja: um bairro sem cidade é procurado nela primeiro */
export const CHURCH_CITY = process.env.CHURCH_CITY || "Fortaleza";
/** Área de busca (oeste, norte, leste, sul): o estado do Ceará */
const REGION = process.env.CHURCH_REGION_VIEWBOX || "-41.5,-2.7,-37.2,-7.9";
const UA = "AtendAI/1.0 (agenda da igreja; https://hostinger-atend-ai-back.pqtwua.easypanel.host)";
/** Tipos de resultado que são um lugar (bairro, cidade), não um prédio ou uma rua */
const AREA_TYPES = ["suburb", "neighbourhood", "quarter", "city_district", "borough", "residential", "city", "town", "village", "hamlet", "municipality"];
const ABBREVIATIONS: [RegExp, string][] = [
  [/\bjd\.?(?=\s)/gi, "Jardim"],
  [/\bpq\.?(?=\s)/gi, "Parque"],
  [/\bvl\.?(?=\s)/gi, "Vila"],
  [/\b(cj|conj)\.?(?=\s)/gi, "Conjunto"],
];

let running = false;

/** Bairros ainda sem posição (ou não encontrados há mais de 30 dias) */
export async function pendingNeighborhoods() {
  return query<{ key: string; name: string }>(
    `SELECT LOWER(TRIM(p.neighborhood)) AS key, MIN(TRIM(p.neighborhood)) AS name
       FROM people p
       LEFT JOIN neighborhood_geo g ON g.key = LOWER(TRIM(p.neighborhood))
      WHERE NULLIF(TRIM(p.neighborhood), '') IS NOT NULL
        AND (g.key IS NULL OR (g.lat IS NULL AND g.looked_up_at < NOW() - INTERVAL '30 days'))
      GROUP BY 1`
  );
}

async function search(q: string): Promise<{ lat: number; lng: number; label: string } | null> {
  const params = new URLSearchParams({ format: "jsonv2", limit: "5", countrycodes: "br", viewbox: REGION, bounded: "1", q });
  const res = await fetch(`https://nominatim.openstreetmap.org/search?${params}`, { headers: { "User-Agent": UA, "Accept-Language": "pt-BR" } });
  if (!res.ok) throw new Error(`Nominatim ${res.status}`);
  const hits = (await res.json()) as { lat: string; lon: string; display_name: string; addresstype: string }[];
  const hit = hits.find((h) => AREA_TYPES.includes(h.addresstype));
  return hit ? { lat: Number(hit.lat), lng: Number(hit.lon), label: hit.display_name } : null;
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Procura em segundo plano os bairros pendentes (uma execução por vez) */
export async function locateNeighborhoods() {
  if (running) return;
  running = true;
  try {
    for (const { key, name } of await pendingNeighborhoods()) {
      // "Jd América / Caucaia" → "Jardim América, Caucaia". Sem cidade: tenta na cidade da igreja e depois no estado todo
      const clean = ABBREVIATIONS.reduce((s, [re, full]) => s.replace(re, full), name.replace(/\s*[/|]\s*|\s+-\s+/g, ", "));
      let hit = null;
      if (!clean.includes(",")) {
        hit = await search(`${clean}, ${CHURCH_CITY}`);
        await wait(1100);
      }
      if (!hit) {
        hit = await search(clean);
        await wait(1100);
      }
      await query(
        `INSERT INTO neighborhood_geo (key, lat, lng, label, looked_up_at) VALUES ($1, $2, $3, $4, NOW())
         ON CONFLICT (key) DO UPDATE SET lat = EXCLUDED.lat, lng = EXCLUDED.lng, label = EXCLUDED.label, looked_up_at = NOW()`,
        [key, hit?.lat ?? null, hit?.lng ?? null, hit?.label ?? null]
      );
    }
  } catch (error) {
    // Falha de rede: os que faltaram ficam pendentes para a próxima abertura da tela
    console.error("Geo error:", error);
  } finally {
    running = false;
  }
}
