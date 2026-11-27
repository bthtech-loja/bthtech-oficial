declare const process: { env: Record<string, string | undefined> };

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
  process.env.SUPABASE_URL || 'https://yzjelmroikleduddentc.supabase.co'
)
  .trim()
  .replace(/\/+$/, '');

const SUPABASE_KEY = (
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  process.env.SUPABASE_ANON_KEY ||
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inl6amVsbXJvaWtsZWR1ZGRlbnRjIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTU3ODk5NjAsImV4cCI6MjExMTM2NTk2MH0.g82yYkBMIqosqI_JkGlU4zPMkD3dh72rOBCWUFRIqkk'
).trim();

const SUPABASE_TABLE = 'bthtech_store';
const SUPABASE_ROW_ID = 'main_store';
const SUPABASE_ENDPOINT = `${SUPABASE_URL}/rest/v1/${SUPABASE_TABLE}`;

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
}): Promise<{ verified: boolean; paid: boolean; captureMethod?: string; error?: string }> {
  if (!params.transactionNsu || !params.slug) {
    return { verified: false, paid: false, error: 'transaction_nsu ou slug ausente' };
  }

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  const apiKey = (process.env.INFINITEPAY_API_KEY || '').trim();
  if (apiKey) {
    headers.Authorization = `Bearer ${apiKey}`;
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

    const rawText = await resp.text();
    let data: Record<string, unknown> = {};
    try {
      data = JSON.parse(rawText) as Record<string, unknown>;
    } catch {
      data = {};
    }

    if (!resp.ok) {
      return {
        verified: false,
        paid: false,
        error: String(data.message || data.error || rawText || `HTTP ${resp.status}`),
      };
    }

    return {
      verified: true,
      paid: Boolean(data.paid),
      captureMethod: typeof data.capture_method === 'string' ? data.capture_method : undefined,
    };
  } catch (err: unknown) {
    return {
      verified: false,
      paid: false,
      error: err instanceof Error ? err.message : 'Erro de rede na verificação InfinitePay',
    };
  }
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

    const payload = parseBody(req?.body);
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
        error: 'transaction_nsu e invoice_slug são obrigatórios para confirmar o pagamento.',
      });
      return;
    }

    const isStatusCanceledOrFailed = ['canceled', 'cancelled', 'failed', 'refunded'].includes(
      eventStatus
    );
    if (isStatusCanceledOrFailed) {
      res.status(200).json({
        success: true,
        message: null,
        ok: true,
        ignored: true,
        reason: `status_${eventStatus}`,
      });
      return;
    }

    if (!SUPABASE_KEY) {
      res.status(500).json({ ok: false, error: 'Credenciais do Supabase não configuradas.' });
      return;
    }

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
      String(currentData.payment?.infinitePayHandle || DEFAULT_HANDLE).trim() ||
      DEFAULT_HANDLE;

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
        error: verification.error || 'Não foi possível validar a transação junto à InfinitePay.',
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
      success: true,
      message: null,
      ok: true,
      order_nsu: orderNsu,
      status: 'Pago',
    });
  } catch (err: unknown) {
    const details = err instanceof Error ? err.message : 'Erro interno inesperado';
    res.status(500).json({ ok: false, error: details });
  }
}
