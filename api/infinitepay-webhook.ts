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

interface StoredOrder {
  id: string;
  createdAt?: string;
  status: string;
  statusHistory?: Record<string, string>;
  infinitePay?: Record<string, unknown>;
  [key: string]: unknown;
}

interface StoredRoot {
  orders?: StoredOrder[];
  payment?: {
    infinitePayHandle?: string;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

const SUPABASE_URL = (
  process.env.SUPABASE_URL ||
  defaultConfig.supabase?.url ||
  'https://yzjelmroikleduddentc.supabase.co'
)
  .trim()
  .replace(/\/+$/, '');

const SUPABASE_KEY = (
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  process.env.SUPABASE_ANON_KEY ||
  defaultConfig.supabase?.anonKey ||
  ''
).trim();

const SUPABASE_TABLE = (defaultConfig.supabase?.table || 'bthtech_store').trim();
const SUPABASE_ROW_ID = (defaultConfig.supabase?.rowId || 'main_store').trim();
const SUPABASE_ENDPOINT = `${SUPABASE_URL}/rest/v1/${SUPABASE_TABLE}`;

const INFINITEPAY_PAYMENT_CHECK_ENDPOINT =
  'https://api.infinitepay.io/invoices/public/checkout/payment_check';

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

function buildSupabaseHeaders(): Record<string, string> {
  return {
    apikey: SUPABASE_KEY,
    Authorization: `Bearer ${SUPABASE_KEY}`,
    'Content-Type': 'application/json',
    Prefer: 'resolution=merge-duplicates,return=representation',
  };
}

async function verifyInfinitePayPayment(params: {
  handle: string;
  orderNsu: string;
  transactionNsu: string;
  slug: string;
}): Promise<{ verified: boolean; paid: boolean; captureMethod?: string }> {
  if (!params.transactionNsu || !params.slug) {
    return { verified: false, paid: false };
  }

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  const apiKey = (process.env.INFINITEPAY_API_KEY || '').trim();
  if (apiKey) {
    headers.Authorization = `Bearer ${apiKey}`;
    headers['X-Api-Key'] = apiKey;
  }

  try {
    const resp = await fetch(INFINITEPAY_PAYMENT_CHECK_ENDPOINT, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        handle: params.handle,
        order_nsu: params.orderNsu,
        transaction_nsu: params.transactionNsu,
        slug: params.slug,
      }),
    });

    if (!resp.ok) {
      return { verified: false, paid: false };
    }

    const data = (await resp.json()) as {
      paid?: boolean;
      capture_method?: string;
    };
    return {
      verified: true,
      paid: Boolean(data.paid),
      captureMethod: data.capture_method,
    };
  } catch {
    return { verified: false, paid: false };
  }
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

  const payload = parseBody(req.body);
  const orderNsu = String(payload.order_nsu || '').trim();
  const transactionNsu = String(payload.transaction_nsu || '').trim();
  const slug = String(payload.invoice_slug || payload.slug || '').trim();
  const receiptUrl = String(payload.receipt_url || '').trim();
  const captureMethod = String(payload.capture_method || '').trim();
  const paidAmount = Number(payload.paid_amount || 0);
  const eventStatus = String(payload.status || '').trim().toLowerCase();

  if (!orderNsu || orderNsu.length > 64) {
    res.status(400).json({ ok: false, error: 'order_nsu inválido ou ausente no webhook.' });
    return;
  }

  if (!transactionNsu || !slug) {
    res.status(400).json({
      ok: false,
      error: 'transaction_nsu e slug são obrigatórios para confirmar o pagamento.',
    });
    return;
  }

  const isStatusCanceledOrFailed = ['canceled', 'cancelled', 'failed', 'refunded'].includes(
    eventStatus
  );
  if (isStatusCanceledOrFailed) {
    res.status(200).json({ ok: true, ignored: true, reason: `status_${eventStatus}` });
    return;
  }

  if (!SUPABASE_KEY) {
    res.status(500).json({ ok: false, error: 'Credenciais do Supabase não configuradas.' });
    return;
  }

  try {
    // 1. Fetch current main_store document from Supabase
    const getResp = await fetch(
      `${SUPABASE_ENDPOINT}?id=eq.${encodeURIComponent(SUPABASE_ROW_ID)}&select=data`,
      {
        method: 'GET',
        headers: buildSupabaseHeaders(),
        cache: 'no-store',
      }
    );

    if (!getResp.ok) {
      const detail = await getResp.text().catch(() => '');
      res.status(502).json({
        ok: false,
        error: `Erro ao ler Supabase (${getResp.status}): ${detail}`,
      });
      return;
    }

    const rows = (await getResp.json()) as Array<{ data?: StoredRoot | null }>;
    const currentData = rows?.[0]?.data;
    if (!currentData || !Array.isArray(currentData.orders)) {
      res.status(404).json({
        ok: false,
        error: 'Registro main_store ou lista de pedidos não encontrada no Supabase.',
      });
      return;
    }

    const targetOrder = currentData.orders.find((o) => o.id === orderNsu);
    if (!targetOrder) {
      res.status(404).json({
        ok: false,
        error: `Pedido ${orderNsu} não encontrado em main_store.`,
      });
      return;
    }

    const activeHandle =
      String(
        currentData.payment?.infinitePayHandle ||
          defaultConfig.infinitePay?.handle ||
          'bth_solar_distribuidora'
      ).trim() || 'bth_solar_distribuidora';

    // 2. Mandatory server-to-server verification with InfinitePay payment_check API
    const verification = await verifyInfinitePayPayment({
      handle: activeHandle,
      orderNsu,
      transactionNsu,
      slug,
    });

    if (!verification.verified) {
      res.status(502).json({
        ok: false,
        error: 'Não foi possível validar a transação junto à API da InfinitePay.',
      });
      return;
    }

    if (!verification.paid) {
      res.status(400).json({
        ok: false,
        error: 'Transação ainda não consta como paga na verificação InfinitePay.',
      });
      return;
    }

    if (paidAmount < 0 || !Number.isFinite(paidAmount)) {
      res.status(400).json({ ok: false, error: 'Valor pago inválido.' });
      return;
    }

    // 3. Update order status to 'Pago' inside bthtech_store.main_store
    const nowIso = new Date().toISOString();
    const updatedOrders = currentData.orders.map((order) => {
      if (order.id !== orderNsu) return order;
      const alreadyAdvanced = ['Em Separação', 'Produto Enviado', 'Produto Entregue'].includes(
        String(order.status || '')
      );
      const nextHistory: Record<string, string> = {
        'Pedido Realizado':
          order.statusHistory?.['Pedido Realizado'] || order.createdAt || nowIso,
        ...(order.statusHistory || {}),
        'Pagamento Aprovado':
          order.statusHistory?.['Pagamento Aprovado'] || nowIso,
      };
      return {
        ...order,
        status: alreadyAdvanced ? order.status : 'Pago',
        statusHistory: nextHistory,
        infinitePay: {
          ...(order.infinitePay || {}),
          handle: activeHandle,
          transactionNsu: transactionNsu || order.infinitePay?.transactionNsu,
          slug: slug || order.infinitePay?.slug,
          captureMethod:
            verification.captureMethod ||
            captureMethod ||
            order.infinitePay?.captureMethod,
          receiptUrl: receiptUrl || order.infinitePay?.receiptUrl,
          paidAt: order.infinitePay?.paidAt || nowIso,
        },
      };
    });

    const updatedData: StoredRoot = {
      ...currentData,
      orders: updatedOrders,
    };

    const postResp = await fetch(SUPABASE_ENDPOINT, {
      method: 'POST',
      headers: buildSupabaseHeaders(),
      body: JSON.stringify({
        id: SUPABASE_ROW_ID,
        data: updatedData,
        updated_at: nowIso,
      }),
    });

    if (!postResp.ok) {
      const detail = await postResp.text().catch(() => '');
      res.status(502).json({
        ok: false,
        error: `Erro ao gravar Supabase (${postResp.status}): ${detail}`,
      });
      return;
    }

    res.status(200).json({
      ok: true,
      order_nsu: orderNsu,
      status: 'Pago',
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Erro interno';
    res.status(500).json({ ok: false, error: msg });
  }
}
