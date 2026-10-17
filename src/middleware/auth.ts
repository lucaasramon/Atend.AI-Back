import { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";

export interface AuthPayload {
  userId: string;
  email: string;
  role: string;
}

declare global {
  namespace Express {
    interface Request {
      auth?: AuthPayload;
    }
  }
}

export function requireAuth(req: Request, res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) {
    return res.status(401).json({ error: "Token não fornecido" });
  }

  const token = header.slice(7);
  let payload: AuthPayload;
  try {
    payload = jwt.verify(token, process.env.JWT_SECRET!) as AuthPayload;
  } catch {
    return res.status(401).json({ error: "Token inválido ou expirado" });
  }

  // Usuários "agenda" e "viewer" só acessam a agenda e os próprios dados de login
  if ((payload.role === "agenda" || payload.role === "viewer") && !AGENDA_PATHS.test(req.originalUrl.split("?")[0])) {
    return res.status(403).json({ error: "Acesso negado" });
  }

  req.auth = payload;
  next();
}

const AGENDA_PATHS = /^\/api\/(auth\/me|(events|ministries|locations|pops)(\/.*)?)$/;

/** Exige um dos tipos de usuário informados */
export function requireRole(...roles: string[]) {
  return (req: Request, res: Response, next: NextFunction) => {
    requireAuth(req, res, () => {
      if (!roles.includes(req.auth!.role)) {
        return res.status(403).json({ error: "Acesso negado" });
      }
      next();
    });
  };
}

export function requireAdmin(req: Request, res: Response, next: NextFunction) {
  requireAuth(req, res, () => {
    if (req.auth?.role !== "admin") {
      return res.status(403).json({ error: "Acesso negado" });
    }
    next();
  });
}
