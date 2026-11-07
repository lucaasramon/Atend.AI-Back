import { Router, Request, Response } from "express";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { v4 as uuidv4 } from "uuid";
import { query, queryOne } from "../db";
import { requireAuth } from "../middleware/auth";
import { hashToken, issueResetToken, normalizePhone, sendResetMessage } from "../services/access";
import { rateLimit } from "../middleware/rateLimit";

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
      `SELECT id, email, role, full_name, church_role,
              COALESCE((SELECT array_agg(ministry_id) FROM user_ministries WHERE user_id = users.id), '{}') AS ministry_ids
         FROM users WHERE id = $1`,
      [req.auth!.userId]
    );
    if (!user) return res.status(404).json({ error: "Usuário não encontrado" });
    return res.json(user);
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

// POST /api/auth/change-password  { current, password }  (logado: troca a própria senha)
router.post("/change-password", requireAuth, rateLimit(10, 15 * 60 * 1000), async (req: Request, res: Response) => {
  const { current, password } = req.body || {};
  if (!current) return res.status(400).json({ error: "Informe a senha atual" });
  if (!password || password.length < 6) return res.status(400).json({ error: "A nova senha deve ter no mínimo 6 caracteres" });
  try {
    const user = await queryOne<{ password_hash: string }>("SELECT password_hash FROM users WHERE id = $1", [req.auth!.userId]);
    if (!user || !(await bcrypt.compare(String(current), user.password_hash))) {
      return res.status(400).json({ error: "A senha atual está incorreta" });
    }
    await query(
      "UPDATE users SET password_hash = $1, setup_token_hash = NULL, setup_token_expires = NULL, updated_at = NOW() WHERE id = $2",
      [await bcrypt.hash(password, 12), req.auth!.userId]
    );
    return res.json({ success: true });
  } catch (error) {
    return res.status(500).json({ error: "Erro interno do servidor" });
  }
});

// ---------- Esqueci minha senha (link pelo WhatsApp) ----------

const RESET_EXPIRED = "Este link expirou ou já foi usado. Peça um novo em \"Esqueci minha senha\".";
const FORGOT_OK = { success: true }; // mesma resposta sempre: não revela se a conta existe

// POST /api/auth/forgot-password  { login }  (e-mail ou WhatsApp)
router.post("/forgot-password", rateLimit(5, 15 * 60 * 1000), async (req: Request, res: Response) => {
  const login = String(req.body?.login || "").trim().toLowerCase();
  if (!login) return res.status(400).json({ error: "Informe o seu e-mail ou WhatsApp" });
  const phone = login.includes("@") ? "" : normalizePhone(login);
  if (!login.includes("@") && phone.length < 12) return res.status(400).json({ error: "E-mail ou WhatsApp inválido" });
  try {
    // WhatsApp: mesmo DDD e mesmos 8 últimos dígitos (com ou sem o 9)
    const user = await queryOne<{ id: string; full_name: string | null; whatsapp: string | null }>(
      phone
        ? "SELECT id, full_name, whatsapp FROM users WHERE whatsapp IS NOT NULL AND left(whatsapp, 4) = left($1, 4) AND right(whatsapp, 8) = right($1, 8) ORDER BY created_at LIMIT 1"
        : "SELECT id, full_name, whatsapp FROM users WHERE email = $1",
      [phone || login]
    );
    if (!user?.whatsapp) return res.json(FORGOT_OK);

    // No máximo 1 link a cada 2 minutos e 5 por dia para a mesma conta
    const recent = await queryOne<{ last2: number; today: number }>(
      `SELECT COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '2 minutes')::int AS last2, COUNT(*)::int AS today
         FROM audit_logs WHERE action = 'forgot_password' AND target_id = $1 AND created_at > NOW() - INTERVAL '1 day'`,
      [user.id]
    );
    if (recent!.last2 > 0 || recent!.today >= 5) return res.json(FORGOT_OK);

    const token = await issueResetToken(user.id);
    await query(
      "INSERT INTO audit_logs (admin_id, action, target_type, target_id, details) VALUES ($1, 'forgot_password', 'user', $1, $2)",
      [user.id, JSON.stringify({ by: phone ? "whatsapp" : "email" })]
    );
    // Sem esperar a fila do robô: a resposta demora igual com ou sem conta
    sendResetMessage({ full_name: user.full_name, whatsapp: user.whatsapp }, token).catch((e) => console.error("Forgot password send error:", e));
    return res.json(FORGOT_OK);
  } catch (error) {
    console.error("Forgot password error:", error);
    return res.status(500).json({ error: "Erro interno do servidor" });
  }
});

// GET /api/auth/reset-password?token=...  (confere o link antes de mostrar o formulário)
router.get("/reset-password", async (req: Request, res: Response) => {
  const token = String(req.query.token || "");
  if (!token) return res.status(400).json({ error: RESET_EXPIRED });
  try {
    const user = await queryOne<{ email: string; full_name: string | null }>(
      "SELECT email, full_name FROM users WHERE setup_token_hash = $1 AND setup_token_expires > NOW()",
      [hashToken(token)]
    );
    return user ? res.json(user) : res.status(400).json({ error: RESET_EXPIRED });
  } catch (error) {
    return res.status(500).json({ error: "Erro interno do servidor" });
  }
});

// POST /api/auth/reset-password  { token, password }  (define a senha nova; o link vale uma vez só)
router.post("/reset-password", async (req: Request, res: Response) => {
  const { token, password } = req.body;
  if (!token) return res.status(400).json({ error: RESET_EXPIRED });
  if (!password || password.length < 6) return res.status(400).json({ error: "A senha deve ter no mínimo 6 caracteres" });
  try {
    const user = await queryOne<{ id: string; email: string }>(
      `UPDATE users SET
         password_hash = $1,
         must_change_password = false,
         setup_token_hash = NULL,
         setup_token_expires = NULL,
         updated_at = NOW()
       WHERE setup_token_hash = $2 AND setup_token_expires > NOW()
       RETURNING id, email`,
      [await bcrypt.hash(password, 12), hashToken(String(token))]
    );
    return user ? res.json({ success: true, email: user.email }) : res.status(400).json({ error: RESET_EXPIRED });
  } catch (error) {
    return res.status(500).json({ error: "Erro interno do servidor" });
  }
});

export default router;
