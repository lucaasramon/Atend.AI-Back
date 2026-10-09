import { Router, Request, Response } from "express";
import { query, queryOne } from "../db";
import { v4 as uuidv4 } from "uuid";

const router = Router();

const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || "";

/**
 * POST /api/webhook/message
 * Chamado pelo n8n a cada mensagem recebida/enviada pelo WhatsApp.
 * Registra o lead (upsert) e salva a mensagem no banco.
 *
 * Body esperado:
 * {
 *   instance_name: string,   // nome da instância no Evolution
 *   remote_jid: string,      // telefone do contato (ex: 5511999999999@s.whatsapp.net)
 *   contact_name: string,    // nome do contato
 *   content: string,         // texto da mensagem
 *   from_me: boolean,        // true = mensagem enviada pela IA, false = mensagem do cliente
 *   message_type?: string,   // "text", "image", etc.
 *   sentiment?: string,      // "positive" | "neutral" | "negative"
 * }
 */
router.post("/message", async (req: Request, res: Response) => {
  // Valida secret para impedir chamadas não autorizadas
  if (WEBHOOK_SECRET) {
    const secret = req.headers["x-webhook-secret"];
    if (secret !== WEBHOOK_SECRET) {
      return res.status(401).json({ error: "Unauthorized" });
    }
  }

  const {
    instance_name,
    remote_jid,
    contact_name,
    content,
    from_me,
    message_type = "text",
    sentiment,
  } = req.body;

  if (!instance_name || !remote_jid || !content) {
    return res.status(400).json({ error: "instance_name, remote_jid e content são obrigatórios" });
  }

  try {
    // 1. Descobre o tenant pelo instance_name
    const profile = await queryOne<{ id: string }>(
      "SELECT id FROM profiles WHERE instance_name = $1",
      [instance_name]
    );

    if (!profile) {
      return res.status(404).json({ error: `Nenhum perfil encontrado para instância: ${instance_name}` });
    }

    const tenantId = profile.id;

    // Normaliza o telefone (remove @s.whatsapp.net ou @g.us)
    const phone = remote_jid.split("@")[0];

    // 2. Upsert do lead pelo tenant + phone
    const existingLead = await queryOne<{ id: string }>(
      "SELECT id FROM leads WHERE tenant_id = $1 AND phone = $2",
      [tenantId, phone]
    );

    let leadId: string;

    if (existingLead) {
      leadId = existingLead.id;
      // Atualiza nome, sentimento e last_message_at
      await query(
        `UPDATE leads SET
           name = COALESCE($1, name),
           sentiment = COALESCE($2, sentiment),
           last_message_at = NOW(),
           updated_at = NOW()
         WHERE id = $3`,
        [contact_name || null, sentiment || null, leadId]
      );
    } else {
      leadId = uuidv4();
      await query(
        `INSERT INTO leads (id, tenant_id, name, phone, sentiment, source, last_message_at, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, 'whatsapp', NOW(), NOW(), NOW())`,
        [leadId, tenantId, contact_name || phone, phone, sentiment || "neutral"]
      );
    }

    // 3. Salva a mensagem
    const messageId = uuidv4();
    await query(
      `INSERT INTO messages (id, tenant_id, lead_id, remote_jid, content, from_me, message_type, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())`,
      [messageId, tenantId, leadId, remote_jid, content, from_me ?? false, message_type]
    );

    return res.json({ success: true, lead_id: leadId, message_id: messageId });
  } catch (error: any) {
    console.error("Webhook message error:", error);
    return res.status(500).json({ error: error.message || "Erro interno" });
  }
});

export default router;
