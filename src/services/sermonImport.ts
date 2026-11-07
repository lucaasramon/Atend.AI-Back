/**
 * Importar pregação de um arquivo (PDF, Word, ODT, PowerPoint, RTF, TXT, foto do esboço...).
 * A IA (Gemini) lê o arquivo e monta o esboço em blocos da tela de pregação.
 *
 * Frases do telão: a IA só pega frases que o autor MARCOU para a projeção no arquivo
 * ("TELÃO:", "projetar", "slide", texto destacado...). Ela copia a frase como está e,
 * quando temos o texto do arquivo, o servidor confere se a frase existe mesmo nele.
 */
import mammoth from "mammoth";
import JSZip from "jszip";
// eslint-disable-next-line @typescript-eslint/no-var-requires
const WordExtractor = require("word-extractor");

export class SermonImportError extends Error {
  constructor(message: string, public status = 400) {
    super(message);
  }
}

/** Tamanho máximo do arquivo (o corpo da requisição vem em base64, ~33% maior) */
export const MAX_FILE_BYTES = 15 * 1024 * 1024;
const MAX_TEXT_CHARS = 400_000;

type Source =
  | { kind: "inline"; mime: string; data: string } // PDF e imagens: o Gemini lê direto
  | { kind: "text"; format: string; text: string };

const IMAGE_MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  heic: "image/heic",
  heif: "image/heif",
};

export const ACCEPTED_EXT = ["pdf", "docx", "doc", "odt", "odp", "pptx", "rtf", "txt", "md", "html", "htm", ...Object.keys(IMAGE_MIME)];

const decodeXml = (s: string) =>
  s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&amp;/g, "&");

const tidy = (s: string) => s.replace(/\r/g, "").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();

/** Word (.docx) em HTML enxuto: mantém negrito, sublinhado e DESTAQUE (marca-texto) */
async function docxToText(buf: Buffer): Promise<string> {
  const { value } = await mammoth.convertToHtml(
    { buffer: buf },
    {
      styleMap: ["highlight => mark", "u => u"],
      convertImage: mammoth.images.imgElement(async () => ({ src: "" })),
    }
  );
  return tidy(
    value
      .replace(/<img[^>]*>/gi, "")
      .replace(/<(\/?)(p|h[1-6]|li|tr|blockquote)\b[^>]*>/gi, (_, close, tag) => (close ? `</${tag}>\n` : `<${tag}>`))
      .replace(/<\/?(ul|ol|table|tbody|thead|a)\b[^>]*>/gi, "")
      .replace(/<br\s*\/?>/gi, "\n")
  );
}

/** Word antigo (.doc) */
async function docToText(buf: Buffer): Promise<string> {
  const doc = await new WordExtractor().extract(buf);
  return tidy([doc.getBody(), doc.getTextboxes?.(), doc.getFootnotes?.()].filter((s) => s && s.trim()).join("\n\n"));
}

/** Texto de um XML do Office/LibreOffice: parágrafos viram linhas */
const xmlToText = (xml: string, paragraphTag: RegExp, breakTag: RegExp) =>
  decodeXml(xml.replace(breakTag, "\n").replace(paragraphTag, "\n").replace(/<[^>]+>/g, ""));

/** LibreOffice (.odt/.odp) */
async function odfToText(buf: Buffer): Promise<string> {
  const zip = await JSZip.loadAsync(buf);
  const xml = await zip.file("content.xml")?.async("string");
  if (!xml) throw new SermonImportError("Não consegui ler esse arquivo do LibreOffice");
  return tidy(
    xmlToText(
      xml.replace(/<text:tab\/>/g, "\t").replace(/<text:s(?: text:c="(\d+)")?\/>/g, (_, n) => " ".repeat(Number(n) || 1)),
      /<\/text:(p|h)>/g,
      /<text:line-break\/>/g
    )
  );
}

/** PowerPoint (.pptx): texto de cada slide + anotações do apresentador */
async function pptxToText(buf: Buffer): Promise<string> {
  const zip = await JSZip.loadAsync(buf);
  const num = (name: string) => Number(name.match(/(\d+)\.xml$/)?.[1] || 0);
  const files = (re: RegExp) => Object.keys(zip.files).filter((f) => re.test(f)).sort((a, b) => num(a) - num(b));
  const notes = new Map<number, string>();
  for (const f of files(/^ppt\/notesSlides\/notesSlide\d+\.xml$/)) {
    notes.set(num(f), tidy(xmlToText(await zip.file(f)!.async("string"), /<\/a:p>/g, /<a:br\/>/g)));
  }
  const out: string[] = [];
  for (const f of files(/^ppt\/slides\/slide\d+\.xml$/)) {
    const text = tidy(xmlToText(await zip.file(f)!.async("string"), /<\/a:p>/g, /<a:br\/>/g));
    const n = num(f);
    out.push(`=== SLIDE ${n} ===\n${text}${notes.get(n) ? `\n[Anotações do apresentador]\n${notes.get(n)}` : ""}`);
  }
  return out.join("\n\n");
}

/** RTF simples para texto (acentos \'e9 e \u233?) */
function rtfToText(rtf: string): string {
  // Tira grupos que não são texto ({\*...}, fontes, cores, estilos...), contando as chaves
  const skip = /^\{\\(\*|fonttbl|colortbl|stylesheet|info|pict|header|footer|listtable|listoverridetable|rsidtbl|latentstyles|themedata|datastore)/;
  let s = "";
  for (let i = 0; i < rtf.length; i++) {
    if (rtf[i] === "{" && rtf[i - 1] !== "\\" && skip.test(rtf.slice(i, i + 24))) {
      let depth = 0;
      for (; i < rtf.length; i++) {
        if (rtf[i] === "\\") i++;
        else if (rtf[i] === "{") depth++;
        else if (rtf[i] === "}" && --depth === 0) break;
      }
      continue;
    }
    s += rtf[i];
  }
  s = s
    .replace(/\\par[d]?\b ?|\\line\b ?/g, "\n")
    .replace(/\\tab\b ?/g, "\t")
    .replace(/\\'([0-9a-f]{2})/gi, (_, h) => Buffer.from([parseInt(h, 16)]).toString("latin1"))
    .replace(/\\u(-?\d+)\??/g, (_, n) => String.fromCharCode(Number(n) < 0 ? Number(n) + 65536 : Number(n)))
    .replace(/\\[a-z]+-?\d* ?/gi, "")
    .replace(/\\([{}\\])/g, "$1")
    .replace(/[{}]/g, "");
  return tidy(s);
}

const htmlToText = (html: string) =>
  tidy(
    html
      .replace(/<(script|style|head)[\s\S]*?<\/\1>/gi, "")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/(p|div|h[1-6]|li|tr)>/gi, "\n")
      .replace(/<(?!\/?(b|strong|mark|u|em|i)\b)[^>]+>/gi, "")
  );

/** Lê o arquivo e devolve o que vai para a IA */
async function readFile(filename: string, buf: Buffer): Promise<Source> {
  const ext = (filename.split(".").pop() || "").toLowerCase();
  const head = buf.subarray(0, 8);
  const isPdf = head.subarray(0, 4).toString("latin1") === "%PDF";
  const isZip = head[0] === 0x50 && head[1] === 0x4b;
  const isOle = head.readUInt32BE(0) === 0xd0cf11e0;

  try {
    if (isPdf || ext === "pdf") return { kind: "inline", mime: "application/pdf", data: buf.toString("base64") };
    if (IMAGE_MIME[ext]) return { kind: "inline", mime: IMAGE_MIME[ext], data: buf.toString("base64") };
    if (isOle || ext === "doc") return { kind: "text", format: "Word (.doc)", text: await docToText(buf) };
    if (isZip) {
      if (ext === "pptx") return { kind: "text", format: "PowerPoint", text: await pptxToText(buf) };
      if (ext === "odt" || ext === "odp") return { kind: "text", format: "LibreOffice", text: await odfToText(buf) };
      return { kind: "text", format: "Word (.docx, em HTML: <mark> = texto destacado com marca-texto)", text: await docxToText(buf) };
    }
    const raw = buf.toString("utf8").replace(/^﻿/, "");
    if (raw.startsWith("{\\rtf")) return { kind: "text", format: "RTF", text: rtfToText(raw) };
    if (ext === "html" || ext === "htm" || /^\s*<(!doctype|html)/i.test(raw)) return { kind: "text", format: "HTML", text: htmlToText(raw) };
    if (ext === "txt" || ext === "md" || !raw.includes("�")) return { kind: "text", format: "texto", text: tidy(raw) };
  } catch (e) {
    if (e instanceof SermonImportError) throw e;
    console.error("Sermon import read error:", e);
    throw new SermonImportError("Não consegui abrir esse arquivo. Ele pode estar corrompido ou protegido por senha.");
  }
  throw new SermonImportError("Formato não suportado. Use PDF, Word, LibreOffice, PowerPoint, RTF, TXT ou foto do esboço.");
}

// ---------- IA ----------

const KINDS = ["intro", "point", "illustration", "appeal", "conclusion", "free"];

const SCHEMA = {
  type: "OBJECT",
  properties: {
    title: { type: "STRING", description: "Título da pregação" },
    bible_text: { type: "STRING", description: "Texto bíblico base (ex.: 'Romanos 8'), ou vazio" },
    projection_markers: {
      type: "STRING",
      description: "Como o autor marcou as frases para o telão (ex.: 'linhas com TELÃO:'). Vazio se não marcou nenhuma.",
    },
    blocks: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: {
          kind: { type: "STRING", enum: KINDS },
          title: { type: "STRING" },
          text: { type: "STRING", description: "O que o pregador vai falar neste bloco, com as palavras do autor" },
          notes: { type: "STRING", description: "Anotações/lembretes do autor para este bloco" },
          minutes: { type: "NUMBER" },
          verses: {
            type: "ARRAY",
            items: {
              type: "OBJECT",
              properties: { ref: { type: "STRING" }, text: { type: "STRING" } },
              required: ["ref", "text"],
            },
          },
          phrases: { type: "ARRAY", items: { type: "STRING" }, description: "Frases MARCADAS pelo autor para o telão, copiadas literalmente" },
        },
        required: ["kind", "title", "text", "notes", "minutes", "verses", "phrases"],
      },
    },
  },
  required: ["title", "bible_text", "projection_markers", "blocks"],
};

const PROMPT = `Você vai transformar o arquivo de uma pregação (sermão) no esboço em blocos de um aplicativo de igreja.

BLOCOS (na ordem do arquivo):
- kind: "intro" (introdução), "point" (ponto/tópico da mensagem), "illustration" (ilustração, história, exemplo), "appeal" (apelo), "conclusion" (conclusão) ou "free" (outro: oração, leitura, avisos...).
- title: título curto do bloco (ex.: "Introdução", "1. A fé que vence"). Use os títulos/tópicos do próprio arquivo quando houver.
- text: o conteúdo do bloco com as PALAVRAS DO AUTOR. Não resuma, não reescreva, não invente: distribua o conteúdo do arquivo entre os blocos, mantendo quebras de parágrafo (\\n). Pode remover só a formatação (tags HTML, asteriscos).
- notes: lembretes que o autor deixou para si (ex.: "(pausa)", "perguntar à igreja", "contar a história do..."), se houver. Senão, "".
- minutes: tempo do bloco. Se o arquivo indicar tempo, use. Senão, estime pela quantidade de texto (~130 palavras por minuto, mínimo 1, em passos de 0,5).
- verses: os versículos citados no bloco. ref no formato curto em português (ex.: "Rm 8:28", "Jo 3:16-17", "Sl 23"). text: o texto do versículo SOMENTE se ele estiver escrito no arquivo; se o arquivo só cita a referência, deixe text "" (NUNCA complete versículo de memória).
- Máximo de 40 blocos.

FRASES PARA O TELÃO (phrases) — REGRA MAIS IMPORTANTE:
Procure EXPLICITAMENTE as frases que o autor indicou que devem ser passadas na projeção/telão. Exemplos de marcação:
- rótulos antes ou depois da frase: "TELÃO:", "Telão -", "PROJEÇÃO:", "Projetar:", "Para a projeção", "Slide:", "Tela:", "Data show:", "Frase:", "Frase de impacto:", "(telão)", "[projeção]", "→ slide", ou parecidos;
- uma seção/lista do tipo "Frases para o telão" / "Slides" (coloque cada frase no bloco onde ela é falada; se não der para saber, no bloco mais próximo);
- texto destacado com marca-texto (<mark> no HTML), ou um padrão visual repetido que o autor claramente usa só para as frases do telão (ex.: em caixa, em cor diferente). Negrito ou itálico comuns NÃO contam como marcação, a não ser que o arquivo diga que é a marcação do telão;
- num arquivo de slides (PowerPoint), o texto dos slides é o que vai para o telão: cada frase de impacto de slide é uma frase (títulos genéricos como "Introdução" não).
Copie cada frase EXATAMENTE como está no arquivo (mesmas palavras e pontuação), sem o rótulo ("TELÃO:" etc.), sem aspas extras. Não crie, não resuma e não escolha frases por conta própria: se o autor não marcou nenhuma frase para a projeção, deixe todas as listas phrases vazias e projection_markers "".
Versículos não entram em phrases (vão em verses), a não ser que o autor tenha marcado uma frase que não é versículo.

title: o título da pregação no arquivo (se não houver, crie um curto a partir do tema). bible_text: o texto base, se houver.
Responda só com o JSON.`;

export interface ImportedSermon {
  title: string;
  bible_text: string;
  projection_markers: string;
  blocks: any[];
  /** Frases que a IA devolveu mas não estão no arquivo (foram descartadas) */
  dropped_phrases: number;
}

/** Comparar frases ignorando acentos, caixa, pontuação e espaços */
const norm = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "");

/** Tira o rótulo que a IA às vezes deixa ("TELÃO: ...") e aspas em volta */
const stripLabel = (p: string) =>
  p
    .trim()
    .replace(/^[\[(]?\s*(tel[aã]o|proje[cç][aã]o|projetar|slide|tela|data\s*show|frase( de impacto)?)\s*[\])]?\s*[:\-–—]\s*/i, "")
    .replace(/^["“”'](.*)["“”']$/s, "$1")
    .trim();

async function askGemini(src: Source): Promise<any> {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new SermonImportError("A IA não está configurada no servidor (GEMINI_API_KEY)", 500);

  const filePart =
    src.kind === "inline"
      ? { inline_data: { mime_type: src.mime, data: src.data } }
      : { text: `=== ARQUIVO (${src.format}) ===\n${src.text.slice(0, MAX_TEXT_CHARS)}\n=== FIM DO ARQUIVO ===` };

  let res: globalThis.Response;
  try {
    res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${key}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: AbortSignal.timeout(170_000),
      body: JSON.stringify({
        contents: [{ role: "user", parts: [filePart, { text: PROMPT }] }],
        generationConfig: {
          temperature: 0.1,
          maxOutputTokens: 60_000,
          responseMimeType: "application/json",
          responseSchema: SCHEMA,
        },
      }),
    });
  } catch (e: any) {
    console.error("Sermon import Gemini fetch error:", e);
    throw new SermonImportError(
      e?.name === "TimeoutError" ? "A IA demorou demais para ler o arquivo. Tente um arquivo menor." : "Não foi possível falar com a IA. Tente de novo.",
      502
    );
  }
  if (!res.ok) {
    console.error("Sermon import Gemini error:", res.status, (await res.text()).slice(0, 1000));
    throw new SermonImportError(res.status === 429 ? "A IA está ocupada agora. Tente de novo em 1 minuto." : "A IA não conseguiu ler o arquivo. Tente de novo.", 502);
  }
  const data = (await res.json()) as any;
  const cand = data?.candidates?.[0];
  if (cand?.finishReason === "MAX_TOKENS") throw new SermonImportError("O arquivo é longo demais para importar de uma vez. Divida em partes.", 422);
  const text = (cand?.content?.parts || []).filter((p: any) => !p.thought).map((p: any) => p.text || "").join("");
  try {
    return JSON.parse(text);
  } catch {
    console.error("Sermon import bad JSON:", cand?.finishReason, text.slice(0, 500));
    throw new SermonImportError("A IA não conseguiu montar a pregação a partir desse arquivo. Tente de novo.", 502);
  }
}

/** Arquivo → pregação montada pela IA (blocos ainda passam pelo cleanBlocks da rota) */
export async function importSermon(filename: string, buf: Buffer): Promise<ImportedSermon> {
  if (!buf.length) throw new SermonImportError("Arquivo vazio");
  if (buf.length > MAX_FILE_BYTES) throw new SermonImportError("Arquivo grande demais (máximo 15 MB)");

  const src = await readFile(filename, buf);
  if (src.kind === "text" && src.text.replace(/\s/g, "").length < 20) {
    throw new SermonImportError("Não encontrei texto nesse arquivo. Se for uma digitalização, envie em PDF ou foto.");
  }

  const out = await askGemini(src);
  // Texto puro do arquivo (sem as tags do HTML do Word) para conferir as frases
  const fileText = src.kind === "text" ? norm(decodeXml(src.text.replace(/<[^>]+>/g, ""))) : null;
  let dropped = 0;

  const blocks = (Array.isArray(out?.blocks) ? out.blocks : []).map((b: any) => {
    const phrases = (Array.isArray(b?.phrases) ? b.phrases : [])
      .map((p: unknown) => stripLabel(String(p ?? "")))
      .filter((p: string) => {
        if (!p) return false;
        // Com o texto do arquivo em mãos, só fica frase que existe nele
        if (fileText && !fileText.includes(norm(p))) {
          dropped++;
          return false;
        }
        return true;
      });
    const words = String(b?.text || "").split(/\s+/).filter(Boolean).length;
    const minutes = Number(b?.minutes) > 0 ? Number(b.minutes) : Math.max(1, Math.round((words / 130) * 2) / 2);
    return { ...b, phrases: [...new Set(phrases)], minutes };
  });
  if (!blocks.length) throw new SermonImportError("A IA não encontrou uma pregação nesse arquivo.", 422);

  return {
    title: String(out?.title || "").trim() || filename.replace(/\.[^.]+$/, ""),
    bible_text: String(out?.bible_text || "").trim(),
    projection_markers: String(out?.projection_markers || "").trim(),
    blocks,
    dropped_phrases: dropped,
  };
}
