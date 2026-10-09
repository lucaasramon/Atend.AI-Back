import { Router, Request, Response } from "express";
import { requireAdmin } from "../middleware/auth";
import { query, queryOne, n8nQuery } from "../db";
import {
  createInstance,
  getQrCode,
  getInstanceStatus,
  setWebhook,
  deleteInstance,
  instanceExists,
  fetchGroups,
  sendText,
} from "../services/evolution";
import { getAllowedGroups } from "../services/reminders";

const router = Router();

const N8N_WEBHOOK_BASE = (process.env.N8N_WEBHOOK_URL || "").replace(/\/$/, "");

/**
 * POST /api/evolution/provision/:profileId
 * Cria instância no Evolution, registra no banco do n8n e salva instance_name no profile.
 * Chamado ao criar um novo cliente.
 */
router.post("/provision/:profileId", requireAdmin, async (req: Request, res: Response) => {
  const { profileId } = req.params;
  const { instance_name, system_prompt } = req.body;

  if (!instance_name) {
    return res.status(400).json({ error: "instance_name é obrigatório" });
  }

  try {
    const profile = await queryOne<any>(
      "SELECT id, company, full_name, plan, system_prompt FROM profiles WHERE id = $1",
      [profileId]
    );
    if (!profile) return res.status(404).json({ error: "Perfil não encontrado" });

    const prompt = system_prompt || profile.system_prompt || "";

    // 1. Criar instância no Evolution (ignora se já existir) e pega o token
    const { exists: alreadyExists, token: existingToken } = await instanceExists(instance_name);
    let instanceToken = existingToken;

    if (!alreadyExists) {
      const created = await createInstance(instance_name) as any;
      instanceToken = created?.hash?.apikey || created?.instance?.token || created?.token || undefined;
    }

    // Se ainda não temos o token, busca direto na listagem
    if (!instanceToken) {
      const { token: fetchedToken } = await instanceExists(instance_name);
      instanceToken = fetchedToken || undefined;
    }

    // 2. Configurar webhook da instância para o n8n
    const webhookUrl = N8N_WEBHOOK_BASE
      ? `${N8N_WEBHOOK_BASE}/webhook-test/a/event/messages-upsert`
      : "https://hostinger-n8n.pqtwua.easypanel.host/webhook-test/a/event/messages-upsert";
    await setWebhook(instance_name, webhookUrl);

    // 3. Salvar instance_name no profile
    await query(
      `UPDATE profiles SET instance_name = $1, system_prompt = COALESCE($2, system_prompt), updated_at = NOW() WHERE id = $3`,
      [instance_name, prompt || null, profileId]
    );

    // 4. Upsert do cliente na tabela clients do banco n8n (banco 'postgres')
    await n8nQuery(
      `INSERT INTO clients (instance_name, client_name, system_prompt, active, instance_token)
       VALUES ($1, $2, $3, true, $4)
       ON CONFLICT (instance_name) DO UPDATE SET
         client_name = EXCLUDED.client_name,
         system_prompt = EXCLUDED.system_prompt,
         instance_token = COALESCE(EXCLUDED.instance_token, clients.instance_token),
         active = true`,
      [instance_name, profile.company || profile.full_name || instance_name, prompt, instanceToken]
    );

    return res.json({ success: true, instance_name, already_existed: alreadyExists });
  } catch (error: any) {
    console.error("Provision error:", error);
    return res.status(500).json({ error: error.message || "Erro ao provisionar instância" });
  }
});

/**
 * GET /api/evolution/qrcode/:instanceName
 * Retorna o QR code (base64) para conectar o WhatsApp.
 */
router.get("/qrcode/:instanceName", requireAdmin, async (_req: Request, res: Response) => {
  const { instanceName } = _req.params;
  try {
    const data = await getQrCode(instanceName);
    return res.json(data);
  } catch (error: any) {
    return res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/evolution/status/:instanceName
 * Retorna o estado de conexão da instância.
 */
router.get("/status/:instanceName", requireAdmin, async (_req: Request, res: Response) => {
  const { instanceName } = _req.params;
  try {
    const data = await getInstanceStatus(instanceName);
    return res.json(data);
  } catch (error: any) {
    return res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/evolution/groups/:instanceName
 * Lista os grupos da instância (para escolher o grupo dos lembretes).
 */
router.get("/groups/:instanceName", requireAdmin, async (req: Request, res: Response) => {
  const { instanceName } = req.params;
  try {
    const groups = await fetchGroups(instanceName);
    return res.json(groups.map((g) => ({ id: g.id, subject: g.subject, size: g.size })));
  } catch (error: any) {
    return res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/evolution/send
 * Envia uma mensagem de texto avulsa para um grupo (xxx@g.us) ou número.
 * Body: { to: string, text: string, instance_name?: string }
 * Sem instance_name, usa a instância configurada nos lembretes (reminders_instance).
 */
router.post("/send", requireAdmin, async (req: Request, res: Response) => {
  const { to, text } = req.body;
  let { instance_name } = req.body;

  if (!to || !text?.trim()) {
    return res.status(400).json({ error: "to e text são obrigatórios" });
  }
  try {
    if (!(await getAllowedGroups()).includes(to)) {
      return res.status(403).json({ error: "Destino não permitido: o robô só envia para os grupos em allowed_groups" });
    }

    if (!instance_name) {
      const setting = await queryOne<{ value: string }>("SELECT value FROM system_settings WHERE key = 'reminders_instance'");
      instance_name = setting?.value;
    }
    if (!instance_name) return res.status(400).json({ error: "instance_name não informado e nenhuma instância padrão configurada" });

    const result: any = await sendText(instance_name, to, text.trim());

    await query(
      `INSERT INTO audit_logs (admin_id, action, target_type, details) VALUES ($1, 'send_message', 'whatsapp', $2)`,
      [req.auth!.userId, JSON.stringify({ instance_name, to, text: text.trim() })]
    );

    return res.json({ success: true, instance_name, to, message_id: result?.key?.id });
  } catch (error: any) {
    console.error("Send message error:", error);
    return res.status(500).json({ error: error.message || "Erro ao enviar mensagem" });
  }
});

/**
 * PATCH /api/evolution/sync/:profileId
 * Sincroniza dados editados (system_prompt, company) com o banco do n8n.
 * Chamado ao editar um cliente existente.
 */
router.patch("/sync/:profileId", requireAdmin, async (req: Request, res: Response) => {
  const { profileId } = req.params;
  const { system_prompt, company, full_name, plan } = req.body;

  try {
    const profile = await queryOne<any>(
      "SELECT instance_name, company, full_name, system_prompt FROM profiles WHERE id = $1",
      [profileId]
    );
    if (!profile) return res.status(404).json({ error: "Perfil não encontrado" });
    if (!profile.instance_name) return res.status(400).json({ error: "Cliente sem instância configurada" });

    const newPrompt  = system_prompt ?? profile.system_prompt;
    const newCompany = company ?? profile.company;
    const newName    = full_name ?? profile.full_name;

    // Atualiza profile
    await query(
      `UPDATE profiles SET
         system_prompt = COALESCE($1, system_prompt),
         company = COALESCE($2, company),
         full_name = COALESCE($3, full_name),
         plan = COALESCE($4, plan),
         updated_at = NOW()
       WHERE id = $5`,
      [system_prompt || null, company || null, full_name || null, plan || null, profileId]
    );

    // Atualiza tabela clients no banco n8n
    await n8nQuery(
      `UPDATE clients SET
         client_name = $1,
         system_prompt = $2
       WHERE instance_name = $3`,
      [newCompany || newName || profile.instance_name, newPrompt || "", profile.instance_name]
    );

    return res.json({ success: true });
  } catch (error: any) {
    console.error("Sync error:", error);
    return res.status(500).json({ error: error.message || "Erro ao sincronizar" });
  }
});

/**
 * DELETE /api/evolution/:instanceName
 * Remove a instância do Evolution e desativa no banco.
 */
router.delete("/:instanceName", requireAdmin, async (req: Request, res: Response) => {
  const { instanceName } = req.params;
  try {
    await deleteInstance(instanceName);
    await n8nQuery("UPDATE clients SET active = false WHERE instance_name = $1", [instanceName]);
    return res.json({ success: true });
  } catch (error: any) {
    return res.status(500).json({ error: error.message });
  }
});

export default router;
