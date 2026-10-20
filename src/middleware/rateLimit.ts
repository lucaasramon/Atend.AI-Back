/**
 * Limite simples por IP (em memória) para os formulários públicos,
 * para evitar envio em massa por robôs.
 */
import { Request, Response, NextFunction } from "express";

export function rateLimit(max: number, windowMs: number) {
  const hits = new Map<string, number[]>();
  return (req: Request, res: Response, next: NextFunction) => {
    // Atrás do proxy do Easypanel, o IP real vem no X-Forwarded-For
    const ip = String(req.headers["x-forwarded-for"] || req.socket.remoteAddress || "").split(",")[0].trim();
    const now = Date.now();
    const recent = (hits.get(ip) || []).filter((t) => now - t < windowMs);
    if (recent.length >= max) {
      return res.status(429).json({ error: "Muitas tentativas. Aguarde alguns minutos e tente de novo." });
    }
    recent.push(now);
    hits.set(ip, recent);
    if (hits.size > 5000) hits.clear();
    next();
  };
}
