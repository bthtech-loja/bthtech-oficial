import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { INITIAL_STORE_STATE } from '../data/initialStore';
import {
  CartItem,
  CustomerAccount,
  EmailConfig,
  EmailTemplateKey,
  Order,
  OrderStatus,
  OrderTimelineStage,
  Product,
  StoreState,
} from '../types/store';
import { roundCurrency } from '../utils/formatters';
import { fetchCloudStore, upsertCloudStore } from '../utils/supabaseSync';

const STORE_STORAGE_KEY = 'bthtech_store_v1';
const CART_STORAGE_KEY = 'bthtech_cart_v1';
const ACTIVE_CUSTOMER_KEY = 'bthtech_active_customer_v1';

export const ORDER_TIMELINE_STAGES: OrderTimelineStage[] = [
  'Pedido Realizado',
  'Pagamento Aprovado',
  'Em Separação',
  'Produto Enviado',
  'Produto Entregue',
];

function normalizeOrderStatus(rawStatus: string): OrderStatus {
  switch (rawStatus) {
    case 'Aguardando Pagamento':
      return 'Aguardando Pagamento';
    case 'Pedido Realizado':
      return 'Pedido Realizado';
    case 'Pago':
      return 'Pago';
    case 'Pagamento Aprovado':
      return 'Pagamento Aprovado';
    case 'Pago / Em Separação':
    case 'Em Separação':
      return 'Em Separação';
    case 'NF-e Emitida / Enviado':
    case 'Produto Enviado':
      return 'Produto Enviado';
    case 'Concluído':
    case 'Produto Entregue':
      return 'Produto Entregue';
    case 'Cancelado':
      return 'Cancelado';
    default:
      return 'Pedido Realizado';
  }
}

function mapStatusToTimelineStage(status: OrderStatus): OrderTimelineStage | null {
  if (status === 'Cancelado') return null;
  if (status === 'Aguardando Pagamento') return 'Pedido Realizado';
  if (status === 'Pago') return 'Pagamento Aprovado';
  return status;
}

function buildUpdatedStatusHistory(
  existing: Partial<Record<OrderTimelineStage, string>> | undefined,
  status: OrderStatus,
  fallbackCreatedAt: string
): Partial<Record<OrderTimelineStage, string>> {
  const next: Partial<Record<OrderTimelineStage, string>> = {
    'Pedido Realizado': existing?.['Pedido Realizado'] || fallbackCreatedAt,
    ...(existing || {}),
  };
  const stageKey = mapStatusToTimelineStage(status);
  if (!stageKey) return next;
  const targetIdx = ORDER_TIMELINE_STAGES.indexOf(stageKey);
  const nowIso = new Date().toISOString();
  ORDER_TIMELINE_STAGES.forEach((stage, idx) => {
    if (idx <= targetIdx && !next[stage]) {
      next[stage] = idx === targetIdx ? nowIso : fallbackCreatedAt;
    }
  });
  // Update exact timestamp for the newly selected active stage
  next[stageKey] = nowIso;
  return next;
}

function normalizeOrders(rawOrders: unknown): Order[] {
  if (!Array.isArray(rawOrders)) return INITIAL_STORE_STATE.orders;
  return rawOrders.map((o) => {
    const order = o as Order;
    const normalizedStatus = normalizeOrderStatus(String(order.status || 'Pedido Realizado'));
    const history: Partial<Record<OrderTimelineStage, string>> = {
      'Pedido Realizado': order.statusHistory?.['Pedido Realizado'] || order.createdAt,
      ...(order.statusHistory || {}),
    };
    const stageKey = mapStatusToTimelineStage(normalizedStatus);
    if (stageKey) {
      const idx = ORDER_TIMELINE_STAGES.indexOf(stageKey);
      ORDER_TIMELINE_STAGES.forEach((stage, sIdx) => {
        if (sIdx <= idx && !history[stage]) {
          history[stage] = order.createdAt;
        }
      });
    }
    return {
      ...order,
      status: normalizedStatus,
      statusHistory: history,
      trackingCode: order.trackingCode || '',
      nfeInfo: order.nfeInfo || '',
    };
  });
}

function normalizeEmailConfig(rawEmail: unknown): EmailConfig {
  const emailObj = (rawEmail || {}) as Partial<EmailConfig> & { emailJsEnabled?: boolean };
  const defaults = INITIAL_STORE_STATE.email;
  const rawTemplates = (emailObj.templates || {}) as Partial<
    Record<EmailTemplateKey, Partial<EmailConfig['templates'][EmailTemplateKey]>>
  >;

  const mergeTemplate = (key: EmailTemplateKey) => {
    const def = defaults.templates[key];
    const custom = rawTemplates[key];
    return {
      ...def,
      ...(custom || {}),
      editorMode: custom?.editorMode === 'html' ? ('html' as const) : ('simple' as const),
      customHtml: typeof custom?.customHtml === 'string' ? custom.customHtml : '',
    };
  };

  return {
    ...defaults,
    ...emailObj,
    officialEmail: (emailObj.officialEmail || '').trim() || defaults.officialEmail,
    gmailScriptUrl: (emailObj.gmailScriptUrl || '').trim() || defaults.gmailScriptUrl,
    emailVerificationEnabled:
      typeof emailObj.emailVerificationEnabled === 'boolean'
        ? emailObj.emailVerificationEnabled
        : typeof emailObj.emailJsEnabled === 'boolean'
        ? emailObj.emailJsEnabled
        : defaults.emailVerificationEnabled,
    emailLogoUrl: (() => {
      const candidate = (emailObj.emailLogoUrl || '').trim();
      if (!candidate || candidate === 'https://googleusercontent.com') {
        return defaults.emailLogoUrl;
      }
      return candidate;
    })(),
    templates: {
      verification: mergeTemplate('verification'),
      orderConfirmed: mergeTemplate('orderConfirmed'),
      orderShipped: mergeTemplate('orderShipped'),
      nfeIssued: mergeTemplate('nfeIssued'),
    },
  };
}

const TEST_JULIANO_CLEANUP_KEY = 'bthtech_cleaned_test_juliano_v1';

function isTestJulianoCustomer(name?: string): boolean {
  const normalized = (name || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .toLowerCase();
  return normalized === 'juliano fernandes';
}

function normalizeStoreState(
  parsed: Partial<StoreState>,
  options?: { cleanTestJuliano?: boolean }
): StoreState {
  const rawTopPromo = parsed.visual?.topPromoText;
  const cleanedTopPromo =
    typeof rawTopPromo === 'string'
      ? rawTopPromo
          .replace(/\s*•\s*NOTA FISCAL \(NF-e\) EM TODOS OS PEDIDOS/gi, '')
          .replace(/NOTA FISCAL \(NF-e\) EM TODOS OS PEDIDOS\s*•?\s*/gi, '')
          .trim()
      : INITIAL_STORE_STATE.visual.topPromoText;

  const resolvedNotices = Array.isArray(parsed.visual?.topPromoNotices)
    ? parsed.visual.topPromoNotices
    : cleanedTopPromo
    ? cleanedTopPromo
        .split('•')
        .map((s) => s.trim())
        .filter(Boolean)
    : INITIAL_STORE_STATE.visual.topPromoNotices;

  let resolvedCustomers = Array.isArray(parsed.customers) ? parsed.customers : [];
  if (options?.cleanTestJuliano) {
    const alreadyCleanedTestJuliano =
      localStorage.getItem(TEST_JULIANO_CLEANUP_KEY) === '1';

    if (!alreadyCleanedTestJuliano) {
      const removedIds = new Set(
        resolvedCustomers
          .filter((c) => isTestJulianoCustomer(c?.fullName))
          .map((c) => c.id)
      );
      if (removedIds.size > 0) {
        resolvedCustomers = resolvedCustomers.filter((c) => !removedIds.has(c.id));
        const activeId = localStorage.getItem(ACTIVE_CUSTOMER_KEY);
        if (activeId && removedIds.has(activeId)) {
          localStorage.removeItem(ACTIVE_CUSTOMER_KEY);
        }
      }
      localStorage.setItem(TEST_JULIANO_CLEANUP_KEY, '1');
    }
  }

  return {
    ...INITIAL_STORE_STATE,
    ...parsed,
    visual: {
      ...INITIAL_STORE_STATE.visual,
      ...(parsed.visual || {}),
      logoUrl: (parsed.visual?.logoUrl || '').trim() || INITIAL_STORE_STATE.visual.logoUrl,
      topPromoText: cleanedTopPromo,
      topPromoNotices: resolvedNotices,
      banners:
        Array.isArray(parsed.visual?.banners) && parsed.visual.banners.length > 0
          ? parsed.visual.banners
          : INITIAL_STORE_STATE.visual.banners,
    },
    payment: {
      ...INITIAL_STORE_STATE.payment,
      ...(parsed.payment || {}),
      pixKey:
        !parsed.payment?.pixKey || parsed.payment.pixKey.trim() === '00.000.000/0001-00'
          ? INITIAL_STORE_STATE.payment.pixKey
          : parsed.payment.pixKey,
      pixBeneficiary:
        !parsed.payment?.pixBeneficiary ||
        parsed.payment.pixBeneficiary.trim() === 'BTHTECH COMÉRCIO DE HARDWARE LTDA'
          ? INITIAL_STORE_STATE.payment.pixBeneficiary
          : parsed.payment.pixBeneficiary,
      pixQrCodeImageUrl: parsed.payment?.pixQrCodeImageUrl || '',
      infinitePayEnabled:
        typeof parsed.payment?.infinitePayEnabled === 'boolean'
          ? parsed.payment.infinitePayEnabled
          : INITIAL_STORE_STATE.payment.infinitePayEnabled,
      infinitePayHandle:
        (parsed.payment?.infinitePayHandle || '').trim() ||
        INITIAL_STORE_STATE.payment.infinitePayHandle,
      installmentRates: {
        ...INITIAL_STORE_STATE.payment.installmentRates,
        ...(parsed.payment?.installmentRates || {}),
      },
      acceptedCardBrands: Array.isArray(parsed.payment?.acceptedCardBrands)
        ? parsed.payment.acceptedCardBrands
        : INITIAL_STORE_STATE.payment.acceptedCardBrands,
    },
    shipping: {
      ...INITIAL_STORE_STATE.shipping,
      ...(parsed.shipping || {}),
      regionRates: {
        ...INITIAL_STORE_STATE.shipping.regionRates,
        ...(parsed.shipping?.regionRates || {}),
      },
      expressRegionRates: {
        ...INITIAL_STORE_STATE.shipping.expressRegionRates,
        ...(parsed.shipping?.expressRegionRates || {}),
      },
    },
    fiscal: { ...INITIAL_STORE_STATE.fiscal, ...(parsed.fiscal || {}) },
    email: normalizeEmailConfig(parsed.email),
    products:
      Array.isArray(parsed.products) && parsed.products.length > 0
        ? parsed.products.map((prod) => {
            const def = INITIAL_STORE_STATE.products.find((d) => d.id === prod.id);
            return {
              ...prod,
              costPrice:
                typeof prod.costPrice === 'number'
                  ? prod.costPrice
                  : def?.costPrice ?? roundCurrency((prod.basePrice || 0) * 0.65),
              weightGrams: prod.weightGrams ?? def?.weightGrams ?? 400,
            };
          })
        : INITIAL_STORE_STATE.products,
    coupons: Array.isArray(parsed.coupons) ? parsed.coupons : INITIAL_STORE_STATE.coupons,
    orders: normalizeOrders(parsed.orders),
    customers: resolvedCustomers,
  };
}

function loadInitialStore(): StoreState {
  try {
    const raw = localStorage.getItem(STORE_STORAGE_KEY);
    if (!raw) return INITIAL_STORE_STATE;
    const parsed = JSON.parse(raw) as Partial<StoreState>;
    return normalizeStoreState(parsed, { cleanTestJuliano: true });
  } catch {
    return INITIAL_STORE_STATE;
  }
}

function loadInitialCart(): CartItem[] {
  try {
    const raw = localStorage.getItem(CART_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function loadActiveCustomerId(): string | null {
  try {
    return localStorage.getItem(ACTIVE_CUSTOMER_KEY);
  } catch {
    return null;
  }
}

export function useStore() {
  const [store, setStore] = useState<StoreState>(loadInitialStore);
  const [cart, setCart] = useState<CartItem[]>(loadInitialCart);
  const [activeCustomerId, setActiveCustomerId] = useState<string | null>(loadActiveCustomerId);
  const [cloudSyncNotice, setCloudSyncNotice] = useState<{
    id: number;
    ok: boolean;
    message: string;
  } | null>(null);

  // Supabase cloud sync coordination refs (anti-overwrite & serialized uploads)
  const storeRef = useRef(store);
  storeRef.current = store;
  const cloudReadyRef = useRef(false);
  const isApplyingCloudRef = useRef(false);
  const lastCloudHashRef = useRef('');
  const pendingUploadsCountRef = useRef(0);
  const mutationVersionRef = useRef(0);
  const uploadChainRef = useRef<Promise<void>>(Promise.resolve());
  const debounceTimerRef = useRef<number | null>(null);
  const immediateFlushRef = useRef(false);
  const immediateNotifyRef = useRef(false);
  const isRefreshingRef = useRef(false);
  const noticeTimerRef = useRef<number | null>(null);

  const currentCustomer = useMemo(() => {
    if (!activeCustomerId) return null;
    return store.customers.find((c) => c.id === activeCustomerId) || null;
  }, [store.customers, activeCustomerId]);

  const clearCloudSyncNotice = useCallback(() => {
    if (noticeTimerRef.current !== null) {
      window.clearTimeout(noticeTimerRef.current);
      noticeTimerRef.current = null;
    }
    setCloudSyncNotice(null);
  }, []);

  const showCloudSyncNotice = useCallback((ok: boolean, message: string) => {
    if (noticeTimerRef.current !== null) {
      window.clearTimeout(noticeTimerRef.current);
      noticeTimerRef.current = null;
    }
    setCloudSyncNotice({ id: Date.now(), ok, message });
    noticeTimerRef.current = window.setTimeout(
      () => {
        noticeTimerRef.current = null;
        setCloudSyncNotice(null);
      },
      ok ? 4500 : 8500
    );
  }, []);

  const enqueueCloudUpsert = useCallback(
    (
      snapshot: StoreState,
      options?: { notify?: boolean }
    ): Promise<{ ok: boolean; error?: string }> => {
      const serialized = JSON.stringify(snapshot);
      lastCloudHashRef.current = serialized;
      pendingUploadsCountRef.current += 1;

      const task = uploadChainRef.current
        .then(async () => {
          const res = await upsertCloudStore(snapshot);
          if (options?.notify && !res.ok) {
            showCloudSyncNotice(
              false,
              res.error || 'Erro ao sincronizar na nuvem.'
            );
          }
          return { ok: res.ok, error: res.error };
        })
        .catch((err: unknown) => {
          const msg = err instanceof Error ? err.message : 'Erro desconhecido';
          if (options?.notify) {
            showCloudSyncNotice(false, `Erro ao sincronizar na nuvem: ${msg}`);
          }
          return { ok: false, error: msg };
        })
        .finally(() => {
          pendingUploadsCountRef.current = Math.max(0, pendingUploadsCountRef.current - 1);
        });

      uploadChainRef.current = task.then(() => undefined);
      return task;
    },
    [showCloudSyncNotice]
  );

  const refreshFromCloud = useCallback(async (): Promise<StoreState | null> => {
    if (isRefreshingRef.current) return storeRef.current;
    if (pendingUploadsCountRef.current > 0 || debounceTimerRef.current !== null) {
      return storeRef.current;
    }

    isRefreshingRef.current = true;
    const startMutationVersion = mutationVersionRef.current;
    try {
      const res = await fetchCloudStore();
      if (
        pendingUploadsCountRef.current > 0 ||
        debounceTimerRef.current !== null ||
        mutationVersionRef.current !== startMutationVersion
      ) {
        return storeRef.current;
      }

      if (res.status === 'found') {
        const normalized = normalizeStoreState(res.data);
        const serialized = JSON.stringify(normalized);
        if (serialized !== lastCloudHashRef.current || !cloudReadyRef.current) {
          lastCloudHashRef.current = serialized;
          storeRef.current = normalized;
          isApplyingCloudRef.current = true;
          setStore(normalized);
          try {
            localStorage.setItem(STORE_STORAGE_KEY, serialized);
          } catch {
            // Ignore storage quota warnings gracefully
          }
        }
        cloudReadyRef.current = true;
        return normalized;
      }

      if (res.status === 'empty') {
        if (!cloudReadyRef.current) {
          const seedState = normalizeStoreState(storeRef.current || INITIAL_STORE_STATE);
          const serialized = JSON.stringify(seedState);
          lastCloudHashRef.current = serialized;
          storeRef.current = seedState;
          isApplyingCloudRef.current = true;
          setStore(seedState);
          try {
            localStorage.setItem(STORE_STORAGE_KEY, serialized);
          } catch {
            // Ignore storage quota warnings gracefully
          }
          cloudReadyRef.current = true;
          enqueueCloudUpsert(seedState);
          return seedState;
        }
        return storeRef.current;
      }

      // On 'error', keep cloudReadyRef unchanged to avoid overwriting existing cloud data on passive reads
      return null;
    } finally {
      isRefreshingRef.current = false;
    }
  }, [enqueueCloudUpsert]);

  // Initial cloud load + 15s polling + window focus / visibility sync
  useEffect(() => {
    void refreshFromCloud();

    const intervalId = window.setInterval(() => {
      void refreshFromCloud();
    }, 15000);

    const handleFocus = () => {
      void refreshFromCloud();
    };
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        void refreshFromCloud();
      }
    };

    window.addEventListener('focus', handleFocus);
    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      window.clearInterval(intervalId);
      window.removeEventListener('focus', handleFocus);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [refreshFromCloud]);

  // Fast localStorage cache + automatic cloud persistence (guarded by cloudReadyRef)
  useEffect(() => {
    const serialized = JSON.stringify(store);
    try {
      localStorage.setItem(STORE_STORAGE_KEY, serialized);
    } catch {
      // Ignore storage quota warnings gracefully
    }

    if (isApplyingCloudRef.current) {
      isApplyingCloudRef.current = false;
      immediateFlushRef.current = false;
      immediateNotifyRef.current = false;
      return;
    }

    if (!cloudReadyRef.current) {
      immediateFlushRef.current = false;
      immediateNotifyRef.current = false;
      return;
    }

    if (serialized === lastCloudHashRef.current) {
      immediateFlushRef.current = false;
      immediateNotifyRef.current = false;
      return;
    }

    if (debounceTimerRef.current !== null) {
      window.clearTimeout(debounceTimerRef.current);
      debounceTimerRef.current = null;
    }

    if (immediateFlushRef.current) {
      const shouldNotify = immediateNotifyRef.current;
      immediateFlushRef.current = false;
      immediateNotifyRef.current = false;
      enqueueCloudUpsert(store, { notify: shouldNotify });
      return;
    }

    debounceTimerRef.current = window.setTimeout(() => {
      debounceTimerRef.current = null;
      enqueueCloudUpsert(store);
    }, 250);
  }, [store, enqueueCloudUpsert]);

  useEffect(() => {
    try {
      localStorage.setItem(CART_STORAGE_KEY, JSON.stringify(cart));
    } catch {
      // Ignore storage quota warnings gracefully
    }
  }, [cart]);

  useEffect(() => {
    try {
      if (activeCustomerId) {
        localStorage.setItem(ACTIVE_CUSTOMER_KEY, activeCustomerId);
      } else {
        localStorage.removeItem(ACTIVE_CUSTOMER_KEY);
      }
    } catch {
      // Ignore storage warnings
    }
  }, [activeCustomerId]);

  useEffect(() => {
    document.documentElement.style.setProperty('--bthtech-accent', store.visual.accentColor || '#FF6500');
  }, [store.visual.accentColor]);

  const addToCart = useCallback((productId: string, qty = 1) => {
    setCart((prev) => {
      const existing = prev.find((item) => item.productId === productId);
      if (existing) {
        return prev.map((item) =>
          item.productId === productId
            ? { ...item, quantity: item.quantity + qty }
            : item
        );
      }
      return [...prev, { productId, quantity: qty }];
    });
  }, []);

  const updateCartQty = useCallback((productId: string, quantity: number) => {
    setCart((prev) => {
      if (quantity <= 0) {
        return prev.filter((item) => item.productId !== productId);
      }
      return prev.map((item) =>
        item.productId === productId ? { ...item, quantity } : item
      );
    });
  }, []);

  const removeFromCart = useCallback((productId: string) => {
    setCart((prev) => prev.filter((item) => item.productId !== productId));
  }, []);

  const clearCart = useCallback(() => {
    setCart([]);
  }, []);

  const markImmediateCloudMutation = useCallback((notify = true) => {
    mutationVersionRef.current += 1;
    cloudReadyRef.current = true;
    immediateFlushRef.current = true;
    if (notify) {
      immediateNotifyRef.current = true;
    }
  }, []);

  const createOrder = useCallback(
    async (order: Order): Promise<{ ok: boolean; error?: string }> => {
      markImmediateCloudMutation(true);
      immediateNotifyRef.current = false;
      const prev = storeRef.current;
      const updatedProducts = prev.products.map((prod) => {
        const bought = order.items.find((i) => i.productId === prod.id);
        if (!bought) return prod;
        return {
          ...prod,
          stock: Math.max(0, prod.stock - bought.quantity),
        };
      });
      const nextState: StoreState = {
        ...prev,
        products: updatedProducts,
        orders: [order, ...prev.orders],
      };
      storeRef.current = nextState;
      try {
        localStorage.setItem(STORE_STORAGE_KEY, JSON.stringify(nextState));
      } catch {
        // Ignore storage quota warnings gracefully
      }
      setStore(nextState);
      return enqueueCloudUpsert(nextState, { notify: true });
    },
    [enqueueCloudUpsert, markImmediateCloudMutation]
  );

  const markOrderAsPaid = useCallback(
    async (
      orderId: string,
      details?: {
        transactionNsu?: string;
        slug?: string;
        captureMethod?: string;
        receiptUrl?: string;
      }
    ): Promise<{ ok: boolean; order: Order | null; error?: string }> => {
      const prev = storeRef.current;
      const existing = prev.orders.find((o) => o.id === orderId) || null;
      if (!existing) {
        return { ok: false, order: null, error: 'Pedido não encontrado.' };
      }

      const alreadyPaid =
        existing.status === 'Pago' ||
        existing.status === 'Pagamento Aprovado' ||
        existing.status === 'Em Separação' ||
        existing.status === 'Produto Enviado' ||
        existing.status === 'Produto Entregue';

      if (alreadyPaid && (!details?.transactionNsu || existing.infinitePay?.transactionNsu)) {
        return { ok: true, order: existing };
      }

      const nowIso = new Date().toISOString();
      let updatedOrder: Order = existing;
      const nextOrders = prev.orders.map((o) => {
        if (o.id !== orderId) return o;
        updatedOrder = {
          ...o,
          status: alreadyPaid ? o.status : ('Pago' as OrderStatus),
          statusHistory: alreadyPaid
            ? o.statusHistory
            : buildUpdatedStatusHistory(o.statusHistory, 'Pago', o.createdAt),
          infinitePay: {
            ...(o.infinitePay || {}),
            transactionNsu: details?.transactionNsu || o.infinitePay?.transactionNsu,
            slug: details?.slug || o.infinitePay?.slug,
            captureMethod: details?.captureMethod || o.infinitePay?.captureMethod,
            receiptUrl: details?.receiptUrl || o.infinitePay?.receiptUrl,
            paidAt: o.infinitePay?.paidAt || nowIso,
          },
        };
        return updatedOrder;
      });

      const nextState: StoreState = { ...prev, orders: nextOrders };
      markImmediateCloudMutation(true);
      immediateNotifyRef.current = false;
      storeRef.current = nextState;
      try {
        localStorage.setItem(STORE_STORAGE_KEY, JSON.stringify(nextState));
      } catch {
        // Ignore storage quota warnings gracefully
      }
      setStore(nextState);
      const syncRes = await enqueueCloudUpsert(nextState, { notify: true });
      return { ok: syncRes.ok, order: updatedOrder, error: syncRes.error };
    },
    [enqueueCloudUpsert, markImmediateCloudMutation]
  );

  const updateOrderStatus = useCallback(
    (orderId: string, status: OrderStatus) => {
      markImmediateCloudMutation();
      setStore((prev) => ({
        ...prev,
        orders: prev.orders.map((o) =>
          o.id === orderId
            ? {
                ...o,
                status,
                statusHistory: buildUpdatedStatusHistory(o.statusHistory, status, o.createdAt),
              }
            : o
        ),
      }));
    },
    [markImmediateCloudMutation]
  );

  const updateOrderTracking = useCallback(
    (orderId: string, trackingCode: string) => {
      markImmediateCloudMutation();
      setStore((prev) => ({
        ...prev,
        orders: prev.orders.map((o) =>
          o.id === orderId ? { ...o, trackingCode: trackingCode.trim() } : o
        ),
      }));
    },
    [markImmediateCloudMutation]
  );

  const updateOrderFulfillment = useCallback(
    (
      orderId: string,
      updates: { status: OrderStatus; trackingCode: string; nfeInfo: string }
    ): Order | null => {
      let updatedOrder: Order | null = null;
      markImmediateCloudMutation();
      setStore((prev) => ({
        ...prev,
        orders: prev.orders.map((o) => {
          if (o.id !== orderId) return o;
          updatedOrder = {
            ...o,
            status: updates.status,
            statusHistory: buildUpdatedStatusHistory(o.statusHistory, updates.status, o.createdAt),
            trackingCode: updates.trackingCode.trim(),
            nfeInfo: updates.nfeInfo.trim(),
          };
          return updatedOrder;
        }),
      }));
      return updatedOrder;
    },
    [markImmediateCloudMutation]
  );

  const upsertProduct = useCallback(
    (product: Product) => {
      markImmediateCloudMutation();
      setStore((prev) => {
        const exists = prev.products.some((p) => p.id === product.id);
        return {
          ...prev,
          products: exists
            ? prev.products.map((p) => (p.id === product.id ? product : p))
            : [product, ...prev.products],
        };
      });
    },
    [markImmediateCloudMutation]
  );

  const deleteProduct = useCallback(
    (productId: string) => {
      markImmediateCloudMutation();
      setStore((prev) => ({
        ...prev,
        products: prev.products.filter((p) => p.id !== productId),
      }));
    },
    [markImmediateCloudMutation]
  );

  const loginCustomer = useCallback(
    (identifier: string, password: string): { ok: boolean; message: string } => {
      const cleanId = identifier.trim().toLowerCase();
      const cleanDoc = identifier.replace(/\D/g, '');
      const found = store.customers.find(
        (c) =>
          c.email.trim().toLowerCase() === cleanId ||
          (cleanDoc.length >= 11 && c.document.replace(/\D/g, '') === cleanDoc)
      );
      if (!found || found.password !== password) {
        return { ok: false, message: 'E-mail/CPF ou senha inválidos.' };
      }
      setActiveCustomerId(found.id);
      return { ok: true, message: `Bem-vindo(a), ${found.fullName.split(' ')[0]}!` };
    },
    [store.customers]
  );

  const registerCustomer = useCallback(
    (
      payload: Omit<CustomerAccount, 'id' | 'createdAt' | 'favoriteProductIds'>
    ): { ok: boolean; message: string } => {
      const cleanEmail = payload.email.trim().toLowerCase();
      const cleanDoc = payload.document.replace(/\D/g, '');
      const duplicate = store.customers.find(
        (c) =>
          c.email.trim().toLowerCase() === cleanEmail ||
          (cleanDoc.length >= 11 && c.document.replace(/\D/g, '') === cleanDoc)
      );
      if (duplicate) {
        return {
          ok: false,
          message: 'Já existe uma conta cadastrada com este e-mail ou CPF/CNPJ.',
        };
      }
      const newCustomer: CustomerAccount = {
        ...payload,
        id: `cli-${Date.now()}`,
        favoriteProductIds: [],
        createdAt: new Date().toISOString(),
      };
      markImmediateCloudMutation();
      setStore((prev) => ({
        ...prev,
        customers: [newCustomer, ...prev.customers],
      }));
      setActiveCustomerId(newCustomer.id);
      return { ok: true, message: 'Conta criada com sucesso!' };
    },
    [store.customers, markImmediateCloudMutation]
  );

  const logoutCustomer = useCallback(() => {
    setActiveCustomerId(null);
  }, []);

  const updateCustomerAccount = useCallback(
    (updated: CustomerAccount) => {
      markImmediateCloudMutation();
      setStore((prev) => ({
        ...prev,
        customers: prev.customers.map((c) => (c.id === updated.id ? updated : c)),
      }));
    },
    [markImmediateCloudMutation]
  );

  const resetCustomerPassword = useCallback(
    (customerId: string, newPassword: string): { ok: boolean; message: string } => {
      const found = store.customers.find((c) => c.id === customerId);
      if (!found) {
        return { ok: false, message: 'Conta não encontrada.' };
      }
      markImmediateCloudMutation();
      setStore((prev) => ({
        ...prev,
        customers: prev.customers.map((c) =>
          c.id === customerId ? { ...c, password: newPassword } : c
        ),
      }));
      setActiveCustomerId(customerId);
      return { ok: true, message: 'Senha redefinida com sucesso!' };
    },
    [store.customers, markImmediateCloudMutation]
  );

  const toggleFavoriteProduct = useCallback(
    (productId: string): boolean => {
      if (!activeCustomerId) return false;
      markImmediateCloudMutation(false);
      setStore((prev) => ({
        ...prev,
        customers: prev.customers.map((c) => {
          if (c.id !== activeCustomerId) return c;
          const exists = c.favoriteProductIds.includes(productId);
          return {
            ...c,
            favoriteProductIds: exists
              ? c.favoriteProductIds.filter((id) => id !== productId)
              : [...c.favoriteProductIds, productId],
          };
        }),
      }));
      return true;
    },
    [activeCustomerId, markImmediateCloudMutation]
  );

  const exportBackupJson = useCallback(() => {
    const payload = {
      exportedAt: new Date().toISOString(),
      version: 1,
      store,
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], {
      type: 'application/json',
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `bthtech-backup-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }, [store]);

  const importBackupJson = useCallback(
    (jsonText: string): { ok: boolean; message: string } => {
      try {
        const parsed = JSON.parse(jsonText);
        const data = parsed.store ? parsed.store : parsed;
        if (!data || !Array.isArray(data.products) || !data.visual || !data.fiscal) {
          return {
            ok: false,
            message: 'Arquivo JSON inválido ou incompatível com o formato BTHTECH.',
          };
        }
        const imported = normalizeStoreState(data);
        if (debounceTimerRef.current !== null) {
          window.clearTimeout(debounceTimerRef.current);
          debounceTimerRef.current = null;
        }
        markImmediateCloudMutation(true);
        immediateNotifyRef.current = false;
        try {
          localStorage.setItem(STORE_STORAGE_KEY, JSON.stringify(imported));
        } catch {
          // Ignore storage quota warnings gracefully
        }
        enqueueCloudUpsert(imported, { notify: true });
        setStore(imported);
        return {
          ok: true,
          message: 'Configurações, produtos, clientes e pedidos restaurados com sucesso!',
        };
      } catch {
        return {
          ok: false,
          message: 'Erro ao ler o arquivo JSON. Verifique se o arquivo está íntegro.',
        };
      }
    },
    [enqueueCloudUpsert, markImmediateCloudMutation]
  );

  const saveStoreChanges = useCallback(
    (overrideStore?: StoreState): { ok: boolean; message: string } => {
      const target = overrideStore ?? store;
      try {
        localStorage.setItem(STORE_STORAGE_KEY, JSON.stringify(target));
        if (debounceTimerRef.current !== null) {
          window.clearTimeout(debounceTimerRef.current);
          debounceTimerRef.current = null;
        }
        markImmediateCloudMutation(true);
        immediateNotifyRef.current = false;
        enqueueCloudUpsert(target, { notify: true });
        if (overrideStore) {
          setStore(overrideStore);
        }
        return { ok: true, message: 'Todas as alterações foram salvas com sucesso!' };
      } catch {
        return {
          ok: false,
          message:
            'Não foi possível salvar no armazenamento local (limite de espaço atingido). Exporte um Backup JSON.',
        };
      }
    },
    [store, enqueueCloudUpsert, markImmediateCloudMutation]
  );

  return {
    store,
    setStore,
    saveStoreChanges,
    refreshFromCloud,
    cloudSyncNotice,
    clearCloudSyncNotice,
    cart,
    addToCart,
    updateCartQty,
    removeFromCart,
    clearCart,
    createOrder,
    markOrderAsPaid,
    updateOrderStatus,
    updateOrderTracking,
    updateOrderFulfillment,
    upsertProduct,
    deleteProduct,
    currentCustomer,
    loginCustomer,
    registerCustomer,
    logoutCustomer,
    updateCustomerAccount,
    resetCustomerPassword,
    toggleFavoriteProduct,
    exportBackupJson,
    importBackupJson,
  };
}
