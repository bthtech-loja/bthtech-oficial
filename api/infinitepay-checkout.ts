declare const process: { env: Record<string, string | undefined> };

interface CheckoutItemInput {
  description?: string;
  name?: string;
  quantity?: number;
  price?: number;
  unitPrice?: number;
}

interface InfinitePayLineItem {
  quantity: number;
  price: number; // integer cents (>= 1)
  description: string;
}

const INFINITEPAY_CHECKOUT_ENDPOINT =
  'https://api.infinitepay.io/invoices/public/checkout/links';
const INFINITEPAY_PAYMENT_CHECK_ENDPOINT =
  'https://api.infinitepay.io/invoices/public/checkout/payment_check';
const DEFAULT_HANDLE = 'bth_solar_distribuidora';

function parseBody(rawBody: unknown): Record<string, unknown> {
  if (!rawBody) return {};
  if (typeof rawBody === 'string') {
    try {
      const parsed = JSON.parse(rawBody);
      return parsed && typeof parsed === 'object'
        ? (parsed as Record<string, unknown>)
        : {};
    } catch {
      return {};
    }
  }
  if (typeof rawBody === 'object') {
    return rawBody as Record<string, unknown>;
  }
  return {};
}

function getHeaderValue(
  headers: Record<string, string | string[] | undefined> | undefined,
  name: string
): string {
  if (!headers) return '';
  const val = headers[name] ?? headers[name.toLowerCase()];
  if (Array.isArray(val)) return String(val[0] || '').trim();
  return typeof val === 'string' ? val.trim() : '';
}

function resolveSiteOrigin(req: any): string {
  const configuredSiteUrl = (
    process.env.PUBLIC_SITE_URL ||
    process.env.SITE_URL ||
    ''
  )
    .trim()
    .replace(/\/+$/, '');
  if (/^https?:\/\/[a-zA-Z0-9.-]+(:\d+)?$/.test(configuredSiteUrl)) {
    return configuredSiteUrl;
  }

  const vercelHost = (
    process.env.VERCEL_PROJECT_PRODUCTION_URL ||
    process.env.VERCEL_URL ||
    ''
  )
    .trim()
    .replace(/^https?:\/\//i, '')
    .replace(/\/+$/, '');
  if (vercelHost && /^[a-zA-Z0-9.-]+(:\d+)?$/.test(vercelHost)) {
    return `https://${vercelHost}`;
  }

  const host =
    getHeaderValue(req?.headers, 'host') ||
    getHeaderValue(req?.headers, 'x-forwarded-host');
  if (host && /^(localhost|127\.0\.0\.1)(:\d+)?$/i.test(host)) {
    return `http://${host}`;
  }
  if (host && /^[a-zA-Z0-9-]+\.vercel\.app$/.test(host)) {
    return `https://${host}`;
  }

  return 'https://bthtech.vercel.app';
}

function formatValidBrazilPhone(raw: unknown): string | null {
  const digits = String(raw || '').replace(/\D/g, '');
  if (!digits) return null;
  if (digits.length === 10 || digits.length === 11) {
    return `+55${digits}`;
  }
  if (digits.startsWith('55') && (digits.length === 12 || digits.length === 13)) {
    return `+${digits}`;
  }
  return null;
}

function sanitizeHandle(rawHandle: unknown): string {
  const cleaned = String(rawHandle || '')
    .trim()
    .replace(/^\$/, '')
    .replace(/[^a-zA-Z0-9_.-]/g, '');
  return cleaned || DEFAULT_HANDLE;
}

function buildInfinitePayHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  const apiKey = (process.env.INFINITEPAY_API_KEY || '').trim();
  if (apiKey) {
    headers.Authorization = `Bearer ${apiKey}`;
  }
  return headers;
}

function buildExactCentItems(
  rawItems: CheckoutItemInput[],
  shippingCostReais: number,
  discountReais: number
): InfinitePayLineItem[] {
  const normalized = rawItems
    .map((item) => {
      const rawQty = Number(item?.quantity);
      const qty = Number.isFinite(rawQty)
        ? Math.min(999, Math.max(1, Math.floor(rawQty)))
        : 1;
      const candidateReais =
        typeof item?.unitPrice === 'number'
          ? item.unitPrice
          : typeof item?.price === 'number'
          ? item.price
          : Number(item?.unitPrice ?? item?.price ?? 0);
      const unitReais =
        Number.isFinite(candidateReais) && candidateReais > 0 ? candidateReais : 0;
      const rawUnitCents = Math.max(0, Math.round(unitReais * 100));
      const description = String(item?.description || item?.name || 'Produto BTHTECH')
        .trim()
        .slice(0, 120);
      return {
        description: description || 'Produto BTHTECH',
        quantity: qty,
        rawLineCents: rawUnitCents * qty,
      };
    })
    .filter((i) => i.rawLineCents > 0);

  if (normalized.length === 0) {
    return [];
  }

  const totalUnits = normalized.reduce((acc, i) => acc + i.quantity, 0);
  const productsGrossCents = normalized.reduce((acc, i) => acc + i.rawLineCents, 0);
  const safeDiscountReais =
    Number.isFinite(Number(discountReais)) && Number(discountReais) > 0
      ? Number(discountReais)
      : 0;
  const maxAllowedDiscountCents = Math.max(0, productsGrossCents - totalUnits);
  const discountCents = Math.min(
    Math.max(0, Math.round(safeDiscountReais * 100)),
    maxAllowedDiscountCents
  );
  const productsNetTargetCents = Math.max(totalUnits, productsGrossCents - discountCents);

  // Proportional allocation guaranteeing exact integer centavos sum and >= 1 cent per unit
  const lineTargets = normalized.map((item) => {
    const exact = (item.rawLineCents / productsGrossCents) * productsNetTargetCents;
    return Math.max(item.quantity, Math.floor(exact));
  });

  let currentSum = lineTargets.reduce((acc, v) => acc + v, 0);
  let diff = productsNetTargetCents - currentSum;

  // Distribute remaining cents or trim excess safely without ever dropping below item.quantity
  let cursor = 0;
  while (diff !== 0 && cursor < normalized.length * 4) {
    const idx = cursor % normalized.length;
    if (diff > 0) {
      lineTargets[idx] += 1;
      diff -= 1;
    } else if (lineTargets[idx] > normalized[idx].quantity) {
      lineTargets[idx] -= 1;
      diff += 1;
    }
    cursor += 1;
  }

  const result: InfinitePayLineItem[] = [];

  normalized.forEach((item, idx) => {
    const lineCents = lineTargets[idx];
    const baseUnitCents = Math.max(1, Math.floor(lineCents / item.quantity));
    const remainder = lineCents - baseUnitCents * item.quantity;

    if (remainder === 0) {
      result.push({
        quantity: item.quantity,
        price: baseUnitCents,
        description: item.description,
      });
    } else if (item.quantity > 1) {
      result.push({
        quantity: item.quantity - 1,
        price: baseUnitCents,
        description: item.description,
      });
      result.push({
        quantity: 1,
        price: baseUnitCents + remainder,
        description: item.description,
      });
    } else {
      result.push({
        quantity: 1,
        price: Math.max(1, lineCents),
        description: item.description,
      });
    }
  });

  const safeShippingReais =
    Number.isFinite(Number(shippingCostReais)) && Number(shippingCostReais) > 0
      ? Number(shippingCostReais)
      : 0;
  const shippingCents = Math.max(0, Math.round(safeShippingReais * 100));
  if (shippingCents > 0) {
    result.push({
      quantity: 1,
      price: shippingCents,
      description: 'Frete',
    });
  }

  return result;
}

export default async function handler(req: any, res: any) {
  try {
    if (req?.method === 'OPTIONS') {
      res.setHeader('Allow', 'POST, OPTIONS');
      res.status(204).end();
      return;
    }

    if (req?.method !== 'POST') {
      res.setHeader('Allow', 'POST, OPTIONS');
      res.status(405).json({ ok: false, error: 'Método não permitido.' });
      return;
    }

    const body = parseBody(req?.body);

    // Payment verification flow when customer returns from InfinitePay
    if (body.action === 'verify') {
      const orderNsu = String(body.order_nsu || body.orderId || '').trim();
      const transactionNsu = String(body.transaction_nsu || '').trim();
      const slug = String(body.slug || body.invoice_slug || '').trim();
      const handle = sanitizeHandle(body.handle);

      if (!orderNsu || !transactionNsu || !slug) {
        res.status(400).json({
          ok: false,
          paid: false,
          error: 'Parâmetros de verificação InfinitePay incompletos.',
        });
        return;
      }

      const checkResp = await fetch(INFINITEPAY_PAYMENT_CHECK_ENDPOINT, {
        method: 'POST',
        headers: buildInfinitePayHeaders(),
        body: JSON.stringify({
          handle,
          order_nsu: orderNsu,
          transaction_nsu: transactionNsu,
          slug,
        }),
      });

      const checkText = await checkResp.text();
      let checkData: Record<string, unknown> = {};
      try {
        checkData = JSON.parse(checkText) as Record<string, unknown>;
      } catch {
        checkData = {};
      }

      if (!checkResp.ok) {
        const details = String(
          checkData.message || checkData.error || checkText || `HTTP ${checkResp.status}`
        );
        res.status(checkResp.status).json({
          ok: false,
          paid: false,
          error: details,
        });
        return;
      }

      res.status(200).json({
        ok: true,
        paid: Boolean(checkData.paid),
        capture_method: String(checkData.capture_method || ''),
        paid_amount: Number(checkData.paid_amount || 0),
        amount: Number(checkData.amount || 0),
      });
      return;
    }

    // Checkout link creation flow
    const orderId = String(body.orderId || body.order_nsu || '').trim();
    const handle = sanitizeHandle(body.handle);
    const rawItems = Array.isArray(body.items) ? (body.items as CheckoutItemInput[]) : [];
    const shippingCost = Number(body.shippingCost || 0);
    const discount = Number(body.discount || 0);
    const rawCustomer =
      body.customer && typeof body.customer === 'object'
        ? (body.customer as Record<string, unknown>)
        : {};

    if (!orderId || orderId.length > 64) {
      res.status(400).json({
        ok: false,
        error: 'Número do pedido (orderId) é obrigatório e deve ter até 64 caracteres.',
      });
      return;
    }

    const items = buildExactCentItems(rawItems, shippingCost, discount);
    if (items.length === 0) {
      res.status(400).json({
        ok: false,
        error: 'Lista de itens do pedido inválida ou com valores zerados.',
      });
      return;
    }

    const siteOrigin = resolveSiteOrigin(req);
    const redirectUrl = `${siteOrigin}/?pagamento=sucesso&pedido=${encodeURIComponent(orderId)}`;
    const webhookUrl = `${siteOrigin}/api/infinitepay-webhook`;

    const customerPayload: Record<string, string> = {};
    const customerName = String(rawCustomer.name || rawCustomer.fullName || '').trim();
    const customerEmail = String(rawCustomer.email || '').trim();
    const customerPhone = formatValidBrazilPhone(
      rawCustomer.phone_number || rawCustomer.whatsapp
    );

    if (customerName) {
      customerPayload.name = customerName.slice(0, 120);
    }
    if (customerEmail && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(customerEmail)) {
      customerPayload.email = customerEmail.slice(0, 120);
    }
    if (customerPhone) {
      customerPayload.phone_number = customerPhone;
    }

    const infinitePayPayload: Record<string, unknown> = {
      handle,
      order_nsu: orderId,
      items,
      redirect_url: redirectUrl,
      webhook_url: webhookUrl,
    };

    if (Object.keys(customerPayload).length > 0) {
      infinitePayPayload.customer = customerPayload;
    }

    const upstream = await fetch(INFINITEPAY_CHECKOUT_ENDPOINT, {
      method: 'POST',
      headers: buildInfinitePayHeaders(),
      body: JSON.stringify(infinitePayPayload),
    });

    const rawText = await upstream.text();
    let parsed: Record<string, unknown> = {};
    try {
      parsed = JSON.parse(rawText) as Record<string, unknown>;
    } catch {
      parsed = {};
    }

    if (!upstream.ok) {
      const details = String(
        parsed.message || parsed.error || rawText || `HTTP ${upstream.status}`
      );
      res.status(upstream.status >= 400 ? upstream.status : 502).json({
        ok: false,
        error: `Erro InfinitePay (${upstream.status}): ${details}`,
      });
      return;
    }

    const checkoutUrl = String(parsed.url || parsed.checkout_url || parsed.link || '').trim();
    if (!checkoutUrl || !/^https:\/\//i.test(checkoutUrl)) {
      res.status(502).json({
        ok: false,
        error: `A InfinitePay não retornou uma URL válida. Resposta: ${rawText || 'vazia'}`,
      });
      return;
    }

    res.status(200).json({
      ok: true,
      url: checkoutUrl,
      slug: String(parsed.slug || ''),
      order_nsu: orderId,
    });
  } catch (err: unknown) {
    const details = err instanceof Error ? err.message : 'Erro interno inesperado';
    res.status(500).json({
      ok: false,
      error: details,
    });
  }
}
