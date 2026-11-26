/**
 * Imagem opcional do evento: guardada em event_images e enviada junto do lembrete no WhatsApp.
 * O corpo da requisição traz { mime, data (base64) }; as datas de uma série compartilham a mesma imagem.
 */
import { query, queryOne } from "../db";

export const IMAGE_MIMES = ["image/jpeg", "image/png", "image/webp"];
export const IMAGE_MAX_BYTES = 5 * 1024 * 1024;

export interface EventImage {
  mime: string;
  data: Buffer;
}

/**
 * Lê o campo "image" do corpo:
 * undefined = não mexe; null = remover; { mime, data } = nova imagem (ou erro de validação)
 */
export function parseImageBody(v: unknown): { set: false } | { set: true; image: EventImage | null } | { error: string } {
  if (v === undefined) return { set: false };
  if (v === null || v === "") return { set: true, image: null };
  const b = v as { mime?: unknown; data?: unknown };
  if (typeof b !== "object" || typeof b.mime !== "string" || typeof b.data !== "string") {
    return { error: "Imagem inválida" };
  }
  if (!IMAGE_MIMES.includes(b.mime)) return { error: "Formato de imagem não suportado. Use JPG, PNG ou WEBP." };
  const data = Buffer.from(b.data.replace(/^data:[^,]*,/, ""), "base64");
  if (!data.length) return { error: "Imagem inválida" };
  if (data.length > IMAGE_MAX_BYTES) return { error: "Imagem grande demais (máximo 5 MB)" };
  return { set: true, image: { mime: b.mime, data } };
}

export async function saveImage(img: EventImage): Promise<string> {
  const row = await queryOne<{ id: string }>("INSERT INTO event_images (mime, data) VALUES ($1, $2) RETURNING id", [img.mime, img.data]);
  return row!.id;
}

export async function getImage(id: string): Promise<EventImage | null> {
  return queryOne<EventImage>("SELECT mime, data FROM event_images WHERE id = $1", [id]);
}

/**
 * Apaga as imagens que nenhum evento usa mais.
 * Só as com mais de 10 minutos: uma imagem recém-salva pode estar a caminho do evento em outra requisição.
 */
export async function deleteOrphanImages(): Promise<void> {
  await query(
    `DELETE FROM event_images i
      WHERE i.created_at < NOW() - INTERVAL '10 minutes'
        AND NOT EXISTS (SELECT 1 FROM events e WHERE e.image_id = i.id)`
  );
}
