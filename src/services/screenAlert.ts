/**
 * Aviso do telão (alerta do Holyrics): o Holyrics só tem um aviso por vez, então este módulo monta
 * um texto único com tudo o que está sendo chamado agora (crianças e placas de carro).
 * "Criança 12 · Sala infantil  |  Placa ABC-1234 · Estacionamento"
 */
import { query } from "../db";
import { holyrics } from "./holyrics";

/** Quanto tempo cada chamada fica no telão */
export const CALL_SECONDS = 60;

/** "Criança 12 · Sala infantil" · "Crianças 12, 23 · Sala infantil" (só o código, nunca o nome) */
export function kidsText(codes: string[]): string {
  return `${codes.length === 1 ? "Criança" : "Crianças"} ${codes.join(", ")} · Sala infantil`;
}

/** "ABC1234" → "ABC-1234" (placa antiga); Mercosul fica como está: "ABC1D23" */
export const formatPlate = (plate: string) => (/^[A-Z]{3}[0-9]{4}$/.test(plate) ? `${plate.slice(0, 3)}-${plate.slice(3)}` : plate);

/** "Placa ABC-1234 · Estacionamento" · "Placas ABC-1234, BRA2E19 · Estacionamento" */
export function carsText(plates: string[]): string {
  return `${plates.length === 1 ? "Placa" : "Placas"} ${plates.map(formatPlate).join(", ")} · Estacionamento`;
}

/** Atualiza o aviso do telão com todas as chamadas em andamento (ou apaga, se não houver nenhuma) */
export async function refreshScreenAlert(): Promise<void> {
  const active = await query<{ kind: "kid" | "car"; label: string; left_sec: number }>(
    `SELECT kind, label, CEIL(EXTRACT(EPOCH FROM (called_at + make_interval(secs => $1) - NOW())))::int AS left_sec
       FROM (
         SELECT 'kid' AS kind, code AS label, called_at FROM kids_checkins
          WHERE called_at > NOW() - make_interval(secs => $1)
         UNION ALL
         SELECT 'car' AS kind, plate AS label, called_at FROM car_calls
          WHERE stopped_at IS NULL AND called_at > NOW() - make_interval(secs => $1)
       ) a
      ORDER BY called_at`,
    [CALL_SECONDS]
  );
  if (!active.length) {
    await holyrics("SetAlert", { text: "", show: false });
    return;
  }
  const unique = (kind: string) => [...new Set(active.filter((a) => a.kind === kind).map((a) => a.label))];
  const kids = unique("kid");
  const cars = unique("car");
  const text = [kids.length ? kidsText(kids) : "", cars.length ? carsText(cars) : ""].filter(Boolean).join("   |   ");
  const seconds = Math.min(3600, Math.max(5, ...active.map((a) => a.left_sec)));
  await holyrics("SetAlert", { text, show: true, display_ahead: true, close_after_seconds: seconds });
}
