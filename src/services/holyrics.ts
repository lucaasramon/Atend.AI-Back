/**
 * Holyrics (projeção do telão) pela internet: https://api.holyrics.com.br/request/{ação}
 * O Holyrics precisa estar aberto e conectado no computador da projeção.
 * Variáveis: HOLYRICS_API_KEY (API_KEY do API Server) e HOLYRICS_TOKEN (token com permissão
 * para ShowQuickPresentation e CloseCurrentQuickPresentation).
 * Documentação: HOLIRYCS.README.md
 */
const BASE_URL = "https://api.holyrics.com.br/request";
const TIMEOUT_MS = 10_000;

const apiKey = () => process.env.HOLYRICS_API_KEY || "";
const token = () => process.env.HOLYRICS_TOKEN || "";

export const holyricsConfigured = () => !!(apiKey() && token());

/** Erro com mensagem pronta para mostrar ao pastor */
export class HolyricsError extends Error {}

export async function holyrics<T = unknown>(action: string, body: object = {}): Promise<T> {
  if (!holyricsConfigured()) throw new HolyricsError("O telão ainda não foi configurado. Avise o administrador.");

  let data: any;
  try {
    const res = await fetch(`${BASE_URL}/${action}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", api_key: apiKey(), token: token() },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    data = await res.json().catch(() => null);
  } catch (e) {
    console.error(`Holyrics ${action}: sem resposta`, e);
    throw new HolyricsError("O telão não respondeu. Tente de novo em instantes.");
  }

  // 1) O pedido chegou ao computador da projeção?
  if (!data || data.status !== "ok") {
    const key = data?.error?.key;
    console.error(`Holyrics ${action}:`, JSON.stringify(data));
    if (key === "device_disconnected") {
      throw new HolyricsError("O computador da projeção está desligado ou com o Holyrics fechado.");
    }
    if (key === "invalid_api_key") throw new HolyricsError("A configuração do telão está errada. Avise o administrador.");
    throw new HolyricsError("Não foi possível falar com o telão. Tente de novo.");
  }

  // 2) O Holyrics respondeu e aceitou?
  if (data.response_status === "timeout") {
    throw new HolyricsError("O Holyrics demorou para responder. Confira o computador da projeção.");
  }
  const resp = data.response;
  if (data.response_status !== "ok" || !resp || resp.status !== "ok") {
    console.error(`Holyrics ${action}:`, JSON.stringify(data));
    const err = String(resp?.error?.message || resp?.error || "");
    if (/token/i.test(err)) throw new HolyricsError("A configuração do telão está errada. Avise o administrador.");
    if (/permiss|acesso negado/i.test(err)) throw new HolyricsError("O Holyrics não deu permissão para esta ação. Avise o administrador.");
    throw new HolyricsError("O Holyrics recusou o pedido. Tente de novo.");
  }
  return resp.data as T;
}
