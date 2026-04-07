import { Router, Request, Response } from "express";
// eslint-disable-next-line @typescript-eslint/no-require-imports
const Stripe = require("stripe");
import { query, queryOne } from "../db";
import { requireAuth } from "../middleware/auth";

const router = Router();
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!);

const FRONTEND_URL = process.env.FRONTEND_URL || "http://localhost:8081";

// POST /api/billing/create-checkout
router.post("/create-checkout", requireAuth, async (req: Request, res: Response) => {
  const { priceId } = req.body;
  if (!priceId) return res.status(400).json({ error: "priceId obrigatório" });

  try {
    const user = await queryOne<any>(
      "SELECT u.email, p.stripe_customer_id FROM users u LEFT JOIN profiles p ON p.id = u.id WHERE u.id = $1",
      [req.auth!.userId]
    );
    if (!user) return res.status(404).json({ error: "Usuário não encontrado" });

    // Cria ou reutiliza customer no Stripe
    let customerId = user.stripe_customer_id;
    if (!customerId) {
      const customer = await stripe.customers.create({
        email: user.email,
        metadata: { user_id: req.auth!.userId },
      });
      customerId = customer.id;
      await query("UPDATE profiles SET stripe_customer_id = $1 WHERE id = $2", [customerId, req.auth!.userId]);
    }

    const session = await stripe.checkout.sessions.create({
      customer: customerId,
      mode: "subscription",
      payment_method_types: ["card"],
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: `${FRONTEND_URL}/payment-success`,
      cancel_url: `${FRONTEND_URL}/client/billing?canceled=true`,
      metadata: { user_id: req.auth!.userId },
    });

    return res.json({ url: session.url });
  } catch (error: any) {
    console.error("Checkout error:", error);
    return res.status(500).json({ error: error.message });
  }
});

// POST /api/billing/customer-portal
router.post("/customer-portal", requireAuth, async (req: Request, res: Response) => {
  try {
    const profile = await queryOne<any>(
      "SELECT stripe_customer_id FROM profiles WHERE id = $1",
      [req.auth!.userId]
    );
    if (!profile?.stripe_customer_id) {
      return res.status(400).json({ error: "Nenhuma assinatura encontrada" });
    }

    const session = await stripe.billingPortal.sessions.create({
      customer: profile.stripe_customer_id,
      return_url: `${FRONTEND_URL}/client/billing`,
    });

    return res.json({ url: session.url });
  } catch (error: any) {
    console.error("Portal error:", error);
    return res.status(500).json({ error: error.message });
  }
});

// POST /api/billing/sync  (sincroniza assinatura com Stripe — fallback quando webhook falha)
router.post("/sync", requireAuth, async (req: Request, res: Response) => {
  try {
    const profile = await queryOne<any>(
      "SELECT stripe_customer_id, subscription_status FROM profiles WHERE id = $1",
      [req.auth!.userId]
    );
    if (!profile?.stripe_customer_id) {
      return res.json({ subscribed: false });
    }
    // Já está ativo, não precisa sincronizar
    if (profile.subscription_status === "active") {
      return res.json({ subscribed: true });
    }

    const subs = await stripe.subscriptions.list({
      customer: profile.stripe_customer_id,
      limit: 1,
      status: "active",
      expand: ["data.default_payment_method"],
    });

    if (!subs.data.length) return res.json({ subscribed: false });

    const sub = subs.data[0];
    const priceId = sub.items.data[0]?.price.id;
    const planName = getPlanNameFromPriceId(priceId);
    const card = (sub.default_payment_method as any)?.card;

    await query(
      `UPDATE profiles SET
        stripe_subscription_id = $1, stripe_price_id = $2,
        subscription_status = 'active', subscription_end = to_timestamp($3),
        plan = $4, status = 'active',
        card_brand = $5, card_last4 = $6, card_exp_month = $7, card_exp_year = $8
       WHERE id = $9`,
      [sub.id, priceId, sub.current_period_end, planName,
       card?.brand || null, card?.last4 || null, card?.exp_month || null, card?.exp_year || null,
       req.auth!.userId]
    );

    return res.json({ subscribed: true, plan: planName });
  } catch (error: any) {
    console.error("Sync error:", error);
    return res.status(500).json({ error: error.message });
  }
});

// POST /api/billing/webhook  (Stripe webhook — sem auth JWT)
router.post("/webhook", async (req: Request, res: Response) => {
  const sig = req.headers["stripe-signature"] as string;
  let event: any;

  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET!);
  } catch (err: any) {
    console.error("Webhook signature error:", err.message);
    return res.status(400).json({ error: `Webhook error: ${err.message}` });
  }

  try {
    switch (event.type) {
      case "checkout.session.completed": {
        const session = event.data.object as any;
        const userId = session.metadata?.user_id;
        if (!userId || !session.subscription) break;

        const sub = await stripe.subscriptions.retrieve(session.subscription as string, {
          expand: ["default_payment_method"],
        });

        const priceId = sub.items.data[0]?.price.id;
        const planName = getPlanNameFromPriceId(priceId);
        const periodEnd = sub.current_period_end;
        const pm = sub.default_payment_method as any;
        const card = pm?.card;

        await query(
          `UPDATE profiles SET
            stripe_subscription_id = $1,
            stripe_price_id = $2,
            subscription_status = 'active',
            subscription_end = to_timestamp($3),
            plan = $4,
            status = 'active',
            card_brand = $5,
            card_last4 = $6,
            card_exp_month = $7,
            card_exp_year = $8
          WHERE id = $9`,
          [
            sub.id, priceId, periodEnd, planName,
            card?.brand || null, card?.last4 || null,
            card?.exp_month || null, card?.exp_year || null,
            userId,
          ]
        );
        console.log(`Assinatura ativada para user ${userId} — plano ${planName}`);
        break;
      }

      case "invoice.payment_succeeded": {
        const invoice = event.data.object as any;
        const subId = (invoice as any).subscription as string;
        if (!subId) break;

        const sub = await stripe.subscriptions.retrieve(subId);
        const periodEnd = sub.current_period_end;

        await query(
          `UPDATE profiles SET subscription_status = 'active', subscription_end = to_timestamp($1), status = 'active'
           WHERE stripe_subscription_id = $2`,
          [periodEnd, subId]
        );
        break;
      }

      case "invoice.payment_failed": {
        const invoice = event.data.object as any;
        const subId = (invoice as any).subscription as string;
        if (!subId) break;

        await query(
          "UPDATE profiles SET subscription_status = 'past_due' WHERE stripe_subscription_id = $1",
          [subId]
        );
        break;
      }

      case "customer.subscription.deleted": {
        const sub = event.data.object as any;
        await query(
          `UPDATE profiles SET
            subscription_status = 'canceled',
            stripe_subscription_id = NULL,
            stripe_price_id = NULL,
            status = 'inactive'
          WHERE stripe_subscription_id = $1`,
          [sub.id]
        );
        break;
      }

      case "customer.subscription.updated": {
        const sub = event.data.object as any;
        const priceId = sub.items.data[0]?.price.id;
        const planName = getPlanNameFromPriceId(priceId);
        const periodEnd = sub.current_period_end;
        const isActive = sub.status === "active" || sub.status === "trialing";

        await query(
          `UPDATE profiles SET
            stripe_price_id = $1,
            plan = $2,
            subscription_status = $3,
            subscription_end = to_timestamp($4),
            status = $5
          WHERE stripe_subscription_id = $6`,
          [priceId, planName, sub.status, periodEnd, isActive ? "active" : "inactive", sub.id]
        );
        break;
      }
    }

    return res.json({ received: true });
  } catch (error: any) {
    console.error("Webhook handler error:", error);
    return res.status(500).json({ error: error.message });
  }
});

function getPlanNameFromPriceId(priceId: string): string {
  const map: Record<string, string> = {
    "price_1T89WBGSbMQCs2fBEEJ5hVtR": "starter",
    "price_1T89XTGSbMQCs2fB5vf5bT9R": "pro",
    "price_1T89XrGSbMQCs2fB8dKrIYMr": "business",
  };
  return map[priceId] || "starter";
}

export default router;
