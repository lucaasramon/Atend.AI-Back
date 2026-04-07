import { Router, Request, Response } from "express";
import { query, queryOne, n8nQuery } from "../db";
import { requireAuth, requireAdmin } from "../middleware/auth";

const router = Router();

// GET /api/profiles  (admin)
router.get("/", requireAdmin, async (req: Request, res: Response) => {
  try {
    const { plan, status, page = "0", limit = "15" } = req.query as Record<string, string>;
    const offset = parseInt(page) * parseInt(limit);

    let where = "WHERE 1=1";
    const params: any[] = [];
    let i = 1;

    if (plan && plan !== "all") { where += ` AND p.plan = $${i++}`; params.push(plan); }
    if (status && status !== "all") { where += ` AND p.status = $${i++}`; params.push(status); }

    const countRows = await query<{ count: string }>(
      `SELECT COUNT(*) as count FROM profiles p ${where}`,
      params
    );
    const total = parseInt(countRows[0].count);

    const rows = await query(
      `SELECT p.id, p.full_name, p.company, p.plan, p.phone, p.whatsapp_number,
              p.status, p.onboarding_completed, p.created_at, p.instance_name,
              p.system_prompt, p.webhook_url, u.email
       FROM profiles p
       JOIN users u ON u.id = p.id
       ${where}
       ORDER BY p.created_at DESC
       LIMIT $${i++} OFFSET $${i++}`,
      [...params, parseInt(limit), offset]
    );

    return res.json({ data: rows, total });
  } catch (error) {
    console.error("Get profiles error:", error);
    return res.status(500).json({ error: "Erro interno do servidor" });
  }
});

// GET /api/profiles/dashboard  (admin — for dashboard stats)
router.get("/dashboard", requireAdmin, async (req: Request, res: Response) => {
  try {
    const profiles = await query(
      `SELECT id, full_name, company, plan, whatsapp_number, status, created_at, onboarding_completed
       FROM profiles ORDER BY created_at DESC`
    );
    const notifications = await query(
      `SELECT id, type, user_name, company, read, created_at
       FROM admin_notifications ORDER BY created_at DESC LIMIT 10`
    );
    return res.json({ profiles, notifications });
  } catch (error) {
    console.error("Dashboard error:", error);
    return res.status(500).json({ error: "Erro interno do servidor" });
  }
});

// GET /api/profiles/automations  (admin)
router.get("/automations", requireAdmin, async (req: Request, res: Response) => {
  try {
    const rows = await query(
      `SELECT id, company, full_name, plan, status, whatsapp_number, webhook_url
       FROM profiles ORDER BY created_at DESC`
    );
    return res.json(rows);
  } catch (error) {
    return res.status(500).json({ error: "Erro interno do servidor" });
  }
});

// GET /api/profiles/me  (client — own profile)
router.get("/me", requireAuth, async (req: Request, res: Response) => {
  try {
    const profile = await queryOne(
      `SELECT id, full_name, company, phone, plan, status, onboarding_completed,
              onboarding_data, system_prompt, webhook_url, whatsapp_number,
              subscription_status, subscription_end, stripe_customer_id, stripe_subscription_id,
              card_brand, card_last4, card_exp_month, card_exp_year,
              created_at, updated_at
       FROM profiles WHERE id = $1`,
      [req.auth!.userId]
    );
    if (!profile) return res.status(404).json({ error: "Perfil não encontrado" });
    return res.json(profile);
  } catch (error) {
    return res.status(500).json({ error: "Erro interno do servidor" });
  }
});

// PATCH /api/profiles/me  (client — update own profile)
router.patch("/me", requireAuth, async (req: Request, res: Response) => {
  const { full_name, company, phone, system_prompt, webhook_url, whatsapp_number } = req.body;
  try {
    const updated = await queryOne(
      `UPDATE profiles SET
         full_name = COALESCE($1, full_name),
         company = COALESCE($2, company),
         phone = COALESCE($3, phone),
         system_prompt = COALESCE($4, system_prompt),
         webhook_url = COALESCE($5, webhook_url),
         whatsapp_number = COALESCE($6, whatsapp_number),
         updated_at = NOW()
       WHERE id = $7
       RETURNING *`,
      [full_name, company, phone, system_prompt, webhook_url, whatsapp_number, req.auth!.userId]
    );
    return res.json(updated);
  } catch (error) {
    return res.status(500).json({ error: "Erro interno do servidor" });
  }
});

// PATCH /api/profiles/me/onboarding  (client — complete onboarding)
router.patch("/me/onboarding", requireAuth, async (req: Request, res: Response) => {
  const { onboarding_data, full_name, company, phone } = req.body;
  try {
    const updated = await queryOne(
      `UPDATE profiles SET
         onboarding_completed = true,
         onboarding_data = $1,
         full_name = COALESCE($2, full_name),
         company = COALESCE($3, company),
         phone = COALESCE($4, phone),
         updated_at = NOW()
       WHERE id = $5
       RETURNING *`,
      [onboarding_data ? JSON.stringify(onboarding_data) : null, full_name, company, phone, req.auth!.userId]
    );
    return res.json(updated);
  } catch (error) {
    return res.status(500).json({ error: "Erro interno do servidor" });
  }
});

// GET /api/profiles/:id  (admin)
router.get("/:id", requireAdmin, async (req: Request, res: Response) => {
  try {
    const profile = await queryOne("SELECT * FROM profiles WHERE id = $1", [req.params.id]);
    if (!profile) return res.status(404).json({ error: "Perfil não encontrado" });
    return res.json(profile);
  } catch (error) {
    return res.status(500).json({ error: "Erro interno do servidor" });
  }
});

// PATCH /api/profiles/:id  (admin)
router.patch("/:id", requireAdmin, async (req: Request, res: Response) => {
  const { plan, status, onboarding_completed, full_name, company, phone, system_prompt, webhook_url, whatsapp_number, instance_name } = req.body;
  try {
    const updated = await queryOne(
      `UPDATE profiles SET
         plan = COALESCE($1, plan),
         status = COALESCE($2, status),
         onboarding_completed = COALESCE($3, onboarding_completed),
         full_name = COALESCE($4, full_name),
         company = COALESCE($5, company),
         phone = COALESCE($6, phone),
         system_prompt = COALESCE($7, system_prompt),
         webhook_url = COALESCE($8, webhook_url),
         whatsapp_number = COALESCE($9, whatsapp_number),
         instance_name = COALESCE($10, instance_name),
         updated_at = NOW()
       WHERE id = $11
       RETURNING *`,
      [plan, status, onboarding_completed, full_name, company, phone, system_prompt, webhook_url, whatsapp_number, instance_name, req.params.id]
    );
    if (!updated) return res.status(404).json({ error: "Perfil não encontrado" });

    // Sincroniza active na tabela clients (n8n) quando status muda
    if (status !== undefined && (updated as any).instance_name) {
      const active = status !== "blocked";
      await n8nQuery(
        `UPDATE clients SET active = $1 WHERE instance_name = $2`,
        [active, (updated as any).instance_name]
      );
    }
    return res.json(updated);
  } catch (error) {
    return res.status(500).json({ error: "Erro interno do servidor" });
  }
});

// DELETE /api/profiles/:id  (admin — remove cliente de tudo)
router.delete("/:id", requireAdmin, async (req: Request, res: Response) => {
  try {
    // Busca instance_name antes de deletar
    const profile = await queryOne<any>(
      "SELECT instance_name FROM profiles WHERE id = $1",
      [req.params.id]
    );
    if (!profile) return res.status(404).json({ error: "Perfil não encontrado" });

    const instanceName: string | null = profile.instance_name;

    // 1. Remove da tabela clients (banco n8n)
    if (instanceName) {
      await n8nQuery("DELETE FROM clients WHERE instance_name = $1", [instanceName]);

      // 2. Remove instância do Evolution API
      try {
        const { deleteInstance } = await import("../services/evolution");
        await deleteInstance(instanceName);
      } catch (e: any) {
        console.warn("Evolution delete warning:", e.message);
        // Não bloqueia — instância pode já não existir
      }
    }

    // 3. Deleta user — CASCADE remove profiles, leads, messages, etc.
    await query("DELETE FROM users WHERE id = $1", [req.params.id]);

    return res.json({ success: true });
  } catch (error: any) {
    console.error("Delete client error:", error);
    return res.status(500).json({ error: "Erro interno do servidor" });
  }
});

export default router;
