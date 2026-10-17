import { Router, Request, Response } from "express";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { v4 as uuidv4 } from "uuid";
import { query, queryOne } from "../db";
import { requireAuth } from "../middleware/auth";
import { hashToken } from "../services/access";

const router = Router();

// POST /api/auth/login
router.post("/login", async (req: Request, res: Response) => {
  const { email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({ error: "Email e senha obrigatórios" });
  }

  try {
    const user = await queryOne<any>(
      "SELECT id, email, password_hash, role, must_change_password FROM users WHERE email = $1",
      [email.trim().toLowerCase()]
    );

    if (!user) {
      return res.status(401).json({ error: "Email ou senha incorretos" });
    }

    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) {
      return res.status(401).json({ error: "Email ou senha incorretos" });
    }

    // Senha temporária: não entra, manda definir a senha nova primeiro
    // (passe de 30 min separado, para não invalidar o link enviado pelo WhatsApp)
    if (user.must_change_password) {
      const setupToken = jwt.sign({ userId: user.id, purpose: "setup" }, process.env.JWT_SECRET!, { expiresIn: "30m" });
      return res.json({ must_change_password: true, setup_token: setupToken });
    }

    const token = jwt.sign(
      { userId: user.id, email: user.email, role: user.role },
      process.env.JWT_SECRET!,
      { expiresIn: (process.env.JWT_EXPIRES_IN || "7d") as any }
    );

    return res.json({ token, user: { id: user.id, email: user.email, role: user.role } });
  } catch (error) {
    console.error("Login error:", error);
    return res.status(500).json({ error: "Erro interno do servidor" });
  }
});

const SETUP_EXPIRED = "Este link expirou ou já foi usado. Peça um novo acesso ao administrador.";

/**
 * Usuário dono do token de primeiro acesso. Aceita o link do WhatsApp (token salvo
 * em hash no banco) ou o passe gerado ao entrar com a senha temporária (JWT de 30 min).
 */
async function findSetupUser(token: string) {
  if (token.includes(".")) {
    try {
      const p = jwt.verify(token, process.env.JWT_SECRET!) as { userId: string; purpose?: string };
      if (p.purpose !== "setup") return null;
      return queryOne<{ id: string; email: string; full_name: string | null }>(
        "SELECT id, email, full_name FROM users WHERE id = $1 AND must_change_password = true",
        [p.userId]
      );
    } catch {
      return null;
    }
  }
  return queryOne<{ id: string; email: string; full_name: string | null }>(
    "SELECT id, email, full_name FROM users WHERE setup_token_hash = $1 AND setup_token_expires > NOW()",
    [hashToken(token)]
  );
}

// GET /api/auth/setup?token=...  (primeiro acesso: confere o link)
router.get("/setup", async (req: Request, res: Response) => {
  const token = String(req.query.token || "");
  if (!token) return res.status(400).json({ error: "Link inválido" });
  try {
    const user = await findSetupUser(token);
    if (!user) return res.status(400).json({ error: SETUP_EXPIRED });
    return res.json({ email: user.email, full_name: user.full_name });
  } catch (error) {
    return res.status(500).json({ error: "Erro interno do servidor" });
  }
});

// POST /api/auth/setup  { token, password }  (primeiro acesso: define a senha)
router.post("/setup", async (req: Request, res: Response) => {
  const { token, password } = req.body;
  if (!token) return res.status(400).json({ error: "Link inválido" });
  if (!password || password.length < 6) return res.status(400).json({ error: "A senha deve ter no mínimo 6 caracteres" });
  try {
    const user = await findSetupUser(token);
    if (!user) return res.status(400).json({ error: SETUP_EXPIRED });
    // Senha definida: invalida o link e o passe (must_change_password = false)
    await query(
      `UPDATE users SET
         password_hash = $1,
         must_change_password = false,
         setup_token_hash = NULL,
         setup_token_expires = NULL,
         updated_at = NOW()
       WHERE id = $2`,
      [await bcrypt.hash(password, 12), user.id]
    );
    return res.json({ success: true, email: user.email });
  } catch (error) {
    return res.status(500).json({ error: "Erro interno do servidor" });
  }
});

// POST /api/auth/signup
router.post("/signup", async (req: Request, res: Response) => {
  const { email, password, full_name, company, plan } = req.body;
  if (!email || !password || !full_name) {
    return res.status(400).json({ error: "Email, senha e nome são obrigatórios" });
  }
  if (password.length < 6) {
    return res.status(400).json({ error: "Senha deve ter no mínimo 6 caracteres" });
  }

  try {
    const existing = await queryOne("SELECT id FROM users WHERE email = $1", [email.toLowerCase()]);
    if (existing) {
      return res.status(409).json({ error: "Email já cadastrado" });
    }

    const id = uuidv4();
    const password_hash = await bcrypt.hash(password, 12);

    await query(
      `INSERT INTO users (id, email, password_hash, role) VALUES ($1, $2, $3, 'user')`,
      [id, email.toLowerCase(), password_hash]
    );

    await query(
      `INSERT INTO profiles (id, full_name, company, plan, status, onboarding_completed)
       VALUES ($1, $2, $3, $4, 'active', false)`,
      [id, full_name, company || null, plan || "starter"]
    );

    const token = jwt.sign(
      { userId: id, email: email.toLowerCase(), role: "user" },
      process.env.JWT_SECRET!,
      { expiresIn: (process.env.JWT_EXPIRES_IN || "7d") as any }
    );

    return res.status(201).json({ token, user: { id, email: email.toLowerCase(), role: "user" } });
  } catch (error) {
    console.error("Signup error:", error);
    return res.status(500).json({ error: "Erro interno do servidor" });
  }
});

// GET /api/auth/me
router.get("/me", requireAuth, async (req: Request, res: Response) => {
  try {
    const user = await queryOne<any>(
      "SELECT id, email, role FROM users WHERE id = $1",
      [req.auth!.userId]
    );
    if (!user) return res.status(404).json({ error: "Usuário não encontrado" });
    return res.json({ id: user.id, email: user.email, role: user.role });
  } catch (error) {
    return res.status(500).json({ error: "Erro interno do servidor" });
  }
});

// POST /api/auth/create-client  (admin only — create user with temp password)
router.post("/create-client", requireAuth, async (req: Request, res: Response) => {
  if (req.auth?.role !== "admin") {
    return res.status(403).json({ error: "Acesso negado" });
  }

  const { email, full_name, company, phone, plan, system_prompt, webhook_url, whatsapp_number } = req.body;
  if (!email || !full_name) {
    return res.status(400).json({ error: "Email e nome são obrigatórios" });
  }

  try {
    const existing = await queryOne("SELECT id FROM users WHERE email = $1", [email.toLowerCase()]);
    if (existing) {
      return res.status(409).json({ error: "Email já cadastrado" });
    }

    const id = uuidv4();
    const temp_password = Math.random().toString(36).slice(-10) + Math.random().toString(36).slice(-4).toUpperCase();
    const password_hash = await bcrypt.hash(temp_password, 12);

    await query(
      `INSERT INTO users (id, email, password_hash, role) VALUES ($1, $2, $3, 'user')`,
      [id, email.toLowerCase(), password_hash]
    );

    await query(
      `INSERT INTO profiles (id, full_name, company, phone, plan, status, onboarding_completed, system_prompt, webhook_url, whatsapp_number)
       VALUES ($1, $2, $3, $4, $5, 'active', false, $6, $7, $8)`,
      [id, full_name, company || null, phone || null, plan || "starter", system_prompt || null, webhook_url || null, whatsapp_number || null]
    );

    return res.status(201).json({ id, email: email.toLowerCase(), temp_password });
  } catch (error) {
    console.error("Create client error:", error);
    return res.status(500).json({ error: "Erro interno do servidor" });
  }
});

// POST /api/auth/reset-password  (token-based password reset)
router.post("/reset-password", async (req: Request, res: Response) => {
  const { token, password } = req.body;
  if (!token || !password) {
    return res.status(400).json({ error: "Token e nova senha são obrigatórios" });
  }
  if (password.length < 6) {
    return res.status(400).json({ error: "Senha deve ter no mínimo 6 caracteres" });
  }

  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET!) as any;
    if (payload.purpose !== "password_reset") {
      return res.status(400).json({ error: "Token inválido" });
    }

    const password_hash = await bcrypt.hash(password, 12);
    const updated = await queryOne(
      "UPDATE users SET password_hash = $1 WHERE id = $2 RETURNING id",
      [password_hash, payload.userId]
    );

    if (!updated) return res.status(404).json({ error: "Usuário não encontrado" });
    return res.json({ success: true });
  } catch (error) {
    return res.status(400).json({ error: "Token inválido ou expirado" });
  }
});

export default router;
