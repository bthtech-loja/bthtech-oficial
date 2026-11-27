import defaultConfig from '../src/defaultConfig.json';

declare const process: { env: Record<string, string | undefined> };

interface ApiRequest {
  method?: string;
  headers: Record<string, string | string[] | undefined>;
  body?: unknown;
}

interface ApiResponse {
  status: (code: number) => ApiResponse;
  json: (payload: unknown) => void;
  setHeader: (name: string, value: string) => void;
  end: (body?: string) => void;
}

interface CheckoutItemInput {
  description?: string;
  name?: string;
  quantity?: number;
  price?: number;
  unitPrice?: number;
}

interface InfinitePayLineItem {
  quantity: number;
  price: number; // integer cents
  description: string;
}

const INFINITEPAY_CHECKOUT_ENDPOINT =
  'https://api.infinitepay.io/invoices/public/checkout/links';
const INFINITEPAY_PAYMENT_CHECK_ENDPOINT =
  'https://api.infinitepay.io/invoices/public/checkout/payment_check';
const DEFAULT_HANDLE =
  (defaultConfig.infinitePay?.handle || 'bth_solar_distribuidora').trim();

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
  return typeof rawBody === 'object'
    ? (rawBody as Record<string, unknown>)
    : {};
}

function getHeaderValue(
  headers: Record<string, string | string[] | undefined>,
  name: string
): string {
  const val = headers[name] ?? headers[name.toLowerCase()];
  if (Array.isArray(val)) return String(val[0] || '').trim();
  return typeof val === 'string' ? val.trim() : '';
}

function resolveSiteOrigin(req: ApiRequest): string {
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

  const host = getHeaderValue(req.headers, 'host') || getHeaderValue(req.headers, 'x-forwarded-host');
  if (host && /^(localhost|127\.0\.0\.1)(:\d+)?$/i.test(host)) {
    return `http://${host}`;
  }
  if (host && /^[a-zA-Z0-9-]+\.vercel\.app$/.test(host)) {
    return `https://${host}`;
  }

  return 'https://bthtech.vercel.app';
}

function formatBrazilPhone(raw: unknown): string {
  const digits = String(raw || '').replace(/\D/g, '');
  if (!digits) return '';
  if (digits.length === 10 || digits.length === 11) {
    return `+55${digits}`;
  }
  if (digits.startsWith('55') && (digits.length === 12 || digits.length === 13)) {
    return `+${digits}`;
  }
  return `+${digits}`;
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
    headers['X-Api-Key'] = apiKey;
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
      const rawQty = Number(item.quantity);
      const qty = Number.isFinite(rawQty) ? Math.min(999, Math.max(1, Math.floor(rawQty))) : 1;
      const candidateReais =
        typeof item.unitPrice === 'number'
          ? item.unitPrice
          : typeof item.price === 'number'
          ? item.price
          : 0;
      const unitReais =
        Number.isFinite(candidateReais) && candidateReais > 0 ? candidateReais : 0;
      const rawUnitCents = Math.max(0, Math.round(unitReais * 100));
      const description = String(item.description || item.name || 'Produto BTHTECH')
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

  const productsGrossCents = normalized.reduce((acc, i) => acc + i.rawLineCents, 0);
  const discountCents = Math.min(
    Math.max(0, Math.round((Number(discountReais) || 0) * 100)),
    Math.max(0, productsGrossCents - 100)
  );
  const productsNetTargetCents = Math.max(100, productsGrossCents - discountCents);

  // Distribute discount proportionally so integer cent sum matches productsNetTargetCents exactly
  const lineTargets: number[] = [];
  let assignedCents = 0;

  normalized.forEach((item, idx) => {
    if (idx === normalized.length - 1) {
      lineTargets.push(Math.max(item.quantity, productsNetTargetCents - assignedCents));
    } else {
      const proportional = Math.max(
        item.quantity,
        Math.round((item.rawLineCents / productsGrossCents) * productsNetTargetCents)
      );
      lineTargets.push(proportional);
      assignedCents += proportional;
    }
  });

  const result: InfinitePayLineItem[] = [];

  normalized.forEach((item, idx) => {
    const lineCents = lineTargets[idx];
    const baseUnitCents = Math.floor(lineCents / item.quantity);
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
        price: lineCents,
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

export default async function handler(req: ApiRequest, res: ApiResponse) {
  if (req.method === 'OPTIONS') {
    res.setHeader('Allow', 'POST, OPTIONS');
    res.status(204).end();
    return;
  }

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST, OPTIONS');
    res.status(405).json({ ok: false, error: 'Método não permitido.' });
    return;
  }

  const body = parseBody(req.body);

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

    try {
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
        res.status(checkResp.status).json({
          ok: false,
          paid: false,
          error:
            String(checkData.message || checkData.error || checkText || 'Erro ao consultar InfinitePay.'),
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
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Erro de rede';
      res.status(502).json({
        ok: false,
        paid: false,
        error: `Falha ao validar pagamento na InfinitePay: ${msg}`,
      });
      return;
    }
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
    res.status(400).json({ ok: false, error: 'Número do pedido (orderId) é obrigatório e válido.' });
    return;
  }

  const items = buildExactCentItems(rawItems, shippingCost, discount);
  if (items.length === 0) {
    res.status(400).json({ ok: false, error: 'Lista de itens do pedido inválida.' });
    return;
  }

  const siteOrigin = resolveSiteOrigin(req);
  const redirectUrl = `${siteOrigin}/?pagamento=sucesso&pedido=${encodeURIComponent(orderId)}`;
  const webhookUrl = `${siteOrigin}/api/infinitepay-webhook`;

  const customerPayload: Record<string, string> = {
    name: String(rawCustomer.name || rawCustomer.fullName || 'Cliente BTHTECH').trim(),
    email: String(rawCustomer.email || '').trim(),
  };
  const phoneNumber = formatBrazilPhone(rawCustomer.phone_number || rawCustomer.whatsapp);
  if (phoneNumber) {
    customerPayload.phone_number = phoneNumber;
  }

  const infinitePayPayload = {
    handle,
    order_nsu: orderId,
    items,
    customer: customerPayload,
    redirect_url: redirectUrl,
    webhook_url: webhookUrl,
  };

  try {
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
      const errDetail = String(
        parsed.message || parsed.error || rawText || `HTTP ${upstream.status}`
      );
      res.status(upstream.status).json({
        ok: false,
        error: `Erro InfinitePay (${upstream.status}): ${errDetail}`,
      });
      return;
    }

    const checkoutUrl = String(parsed.url || parsed.checkout_url || parsed.link || '').trim();
    if (!checkoutUrl || !/^https:\/\//i.test(checkoutUrl)) {
      res.status(502).json({
        ok: false,
        error: 'A InfinitePay não retornou uma URL de pagamento válida.',
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
    const msg = err instanceof Error ? err.message : 'Erro de conexão';
    res.status(502).json({
      ok: false,
      error: `Falha ao conectar com a API da InfinitePay: ${msg}`,
    });
  }
}
