import { Router, Request, Response } from "express";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { v4 as uuidv4 } from "uuid";
import { query, queryOne } from "../db";
import { requireAuth } from "../middleware/auth";

const router = Router();

// POST /api/auth/login
router.post("/login", async (req: Request, res: Response) => {
  const { email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({ error: "Email e senha obrigatórios" });
  }

  try {
    const user = await queryOne<any>(
      "SELECT id, email, password_hash, role FROM users WHERE email = $1",
      [email.toLowerCase()]
    );

    if (!user) {
      return res.status(401).json({ error: "Email ou senha incorretos" });
    }

    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) {
      return res.status(401).json({ error: "Email ou senha incorretos" });
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
