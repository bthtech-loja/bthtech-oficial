import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertCircle,
  ArrowUpDown,
  CheckCircle2,
  ExternalLink,
  Loader2,
  RotateCcw,
  ShoppingBag,
  X,
} from 'lucide-react';
import { AdminPanel } from './components/AdminPanel';
import { CartCheckoutDrawer } from './components/CartCheckoutDrawer';
import { CustomerAccountView } from './components/CustomerAccountView';
import { FlashDealsStrip } from './components/FlashDealsStrip';
import { Footer } from './components/Footer';
import { Header } from './components/Header';
import { HeroBanner } from './components/HeroBanner';
import { ProductCard } from './components/ProductCard';
import { ProductDetailModal } from './components/ProductDetailModal';
import { useStore } from './hooks/useStore';
import { Department, Order, Product, ShippingMethod, ViaCepAddress } from './types/store';
import { calcPixPrice, formatBRL, roundCurrency } from './utils/formatters';
import { sendOrderTemplateEmail } from './utils/emailService';

type SortOption = 'featured' | 'price_asc' | 'price_desc' | 'discount';

function checkIsAdminRoute(): boolean {
  if (typeof window === 'undefined') return false;
  return (
    window.location.pathname.endsWith('/admin') ||
    window.location.hash.includes('/admin')
  );
}

function checkIsAccountRoute(): boolean {
  if (typeof window === 'undefined') return false;
  return (
    window.location.pathname.endsWith('/minha-conta') ||
    window.location.hash.includes('/minha-conta')
  );
}

export default function App() {
  const {
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
    markOrderEmailSent,
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
  } = useStore();

  const [isAdminView, setIsAdminView] = useState<boolean>(checkIsAdminRoute);
  const [isAccountView, setIsAccountView] = useState<boolean>(checkIsAccountRoute);
  const [searchQuery, setSearchQuery] = useState('');
  const [activeDepartment, setActiveDepartment] = useState<Department>('TODOS');
  const [sortBy, setSortBy] = useState<SortOption>('featured');
  const [selectedProduct, setSelectedProduct] = useState<Product | null>(null);
  const [isCartOpen, setIsCartOpen] = useState(false);
  const [shippingCep, setShippingCep] = useState('');
  const [viaCepAddress, setViaCepAddress] = useState<ViaCepAddress | null>(null);
  const [selectedShippingMethod, setSelectedShippingMethod] = useState<ShippingMethod>('economic');

  const [paymentReturnModal, setPaymentReturnModal] = useState<{
    open: boolean;
    orderId: string;
    phase: 'verifying' | 'approved' | 'pending';
    captureMethod?: string;
    receiptUrl?: string;
    transactionNsu?: string;
    slug?: string;
    message?: string;
  } | null>(null);
  const handledReturnRef = useRef(false);
  const confirmedEmailHandledRef = useRef<Set<string>>(new Set());

  const triggerConfirmedSideEffects = useCallback(
    async (
      order: Order | null | undefined,
      emailConfig = store.email,
      meta?: {
        transactionNsu?: string;
        slug?: string;
        captureMethod?: string;
        receiptUrl?: string;
      }
    ) => {
      clearCart();
      if (!order) return;

      const paidRes = await markOrderAsPaid(order.id, meta);
      const finalOrder = paidRes.order || order;

      const shouldSendEmail =
        emailConfig.emailVerificationEnabled &&
        (emailConfig.templates?.orderConfirmed?.enabled ?? true);

      if (
        shouldSendEmail &&
        !finalOrder.confirmationEmailSent &&
        !confirmedEmailHandledRef.current.has(finalOrder.id)
      ) {
        confirmedEmailHandledRef.current.add(finalOrder.id);
        const emailRes = await sendOrderTemplateEmail(
          emailConfig,
          finalOrder,
          'orderConfirmed'
        ).catch(() => ({ ok: false }));
        if (emailRes?.ok) {
          await markOrderEmailSent(finalOrder.id);
        }
      }
    },
    [clearCart, markOrderAsPaid, markOrderEmailSent, store.email]
  );

  const verifyReturnedPayment = useCallback(
    async (params: {
      orderId: string;
      transactionNsu?: string;
      slug?: string;
      captureMethod?: string;
      receiptUrl?: string;
    }) => {
      const refreshedStore = await refreshFromCloud();
      const activeStore = refreshedStore || store;

      let verifiedPaid = false;
      let resolvedCaptureMethod = params.captureMethod || '';

      if (params.transactionNsu && params.slug) {
        try {
          const resp = await fetch('/api/infinitepay-checkout', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              action: 'verify',
              handle: activeStore.payment.infinitePayHandle || 'bth_solar_distribuidora',
              order_nsu: params.orderId,
              transaction_nsu: params.transactionNsu,
              slug: params.slug,
            }),
          });
          if (resp.ok) {
            const check = (await resp.json()) as {
              paid?: boolean;
              capture_method?: string;
            };
            if (check.paid) {
              verifiedPaid = true;
            }
            if (check.capture_method) {
              resolvedCaptureMethod = check.capture_method;
            }
          }
        } catch {
          // Will fall back to checking order status synced via webhook in Supabase
        }
      }

      const latestOrder = activeStore.orders.find((o) => o.id === params.orderId);

      if (verifiedPaid) {
        await triggerConfirmedSideEffects(
          latestOrder || {
            id: params.orderId,
            createdAt: new Date().toISOString(),
            status: 'Pago',
            items: [],
            subtotalBase: 0,
            discountCouponAmount: 0,
            pixDiscountAmount: 0,
            shippingMethod: 'economic',
            shippingLabel: '',
            shippingCost: 0,
            paymentMethod: 'infinitepay',
            installments: 1,
            installmentValue: 0,
            totalAmount: 0,
            customer: {
              fullName: '',
              document: '',
              email: '',
              whatsapp: '',
              cep: '',
              street: '',
              number: '',
              complement: '',
              neighborhood: '',
              city: '',
              state: '',
            },
          },
          activeStore.email,
          {
            transactionNsu: params.transactionNsu,
            slug: params.slug,
            captureMethod: resolvedCaptureMethod,
            receiptUrl: params.receiptUrl,
          }
        );
        setPaymentReturnModal({
          open: true,
          orderId: params.orderId,
          phase: 'approved',
          captureMethod: resolvedCaptureMethod,
          receiptUrl: params.receiptUrl,
          transactionNsu: params.transactionNsu,
          slug: params.slug,
        });
        return;
      }

      // Check if webhook already updated the order status in Supabase
      const isAlreadyPaidInCloud =
        latestOrder &&
        ['Pago', 'Pagamento Aprovado', 'Em Separação', 'Produto Enviado', 'Produto Entregue'].includes(
          latestOrder.status
        );

      if (isAlreadyPaidInCloud && latestOrder) {
        await triggerConfirmedSideEffects(latestOrder, activeStore.email, {
          transactionNsu: params.transactionNsu,
          slug: params.slug,
          captureMethod: latestOrder.infinitePay?.captureMethod || resolvedCaptureMethod,
          receiptUrl: latestOrder.infinitePay?.receiptUrl || params.receiptUrl,
        });
        setPaymentReturnModal({
          open: true,
          orderId: params.orderId,
          phase: 'approved',
          captureMethod: latestOrder.infinitePay?.captureMethod || resolvedCaptureMethod,
          receiptUrl: latestOrder.infinitePay?.receiptUrl || params.receiptUrl,
          transactionNsu: params.transactionNsu,
          slug: params.slug,
        });
      } else {
        setPaymentReturnModal({
          open: true,
          orderId: params.orderId,
          phase: 'pending',
          captureMethod: resolvedCaptureMethod,
          receiptUrl: params.receiptUrl,
          transactionNsu: params.transactionNsu,
          slug: params.slug,
          message:
            'Seu carrinho continua salvo! Aguardando confirmação da InfinitePay, ou você pode voltar ao carrinho e escolher PIX QR Code.',
        });
      }
    },
    [refreshFromCloud, store, triggerConfirmedSideEffects]
  );

  useEffect(() => {
    if (handledReturnRef.current || typeof window === 'undefined') return;
    const qs = new URLSearchParams(window.location.search);
    const pagamento = qs.get('pagamento');
    const orderId = (qs.get('order_nsu') || qs.get('pedido') || '').trim();
    const transactionNsu = (qs.get('transaction_nsu') || '').trim();
    const slug = (qs.get('slug') || qs.get('invoice_slug') || '').trim();
    const captureMethod = (qs.get('capture_method') || '').trim();
    const rawReceipt = (qs.get('receipt_url') || '').trim();
    const receiptUrl = /^https:\/\//i.test(rawReceipt) ? rawReceipt : '';

    if ((pagamento === 'sucesso' || (orderId && (transactionNsu || slug))) && orderId) {
      handledReturnRef.current = true;
      setPaymentReturnModal({
        open: true,
        orderId,
        phase: 'verifying',
        captureMethod,
        receiptUrl,
        transactionNsu,
        slug,
      });
      void verifyReturnedPayment({
        orderId,
        transactionNsu,
        slug,
        captureMethod,
        receiptUrl,
      });
    }
  }, [verifyReturnedPayment]);

  // Keep open return confirmation modal synced with latest cloud order status
  useEffect(() => {
    if (!paymentReturnModal?.open || paymentReturnModal.phase === 'approved') return;
    const match = store.orders.find((o) => o.id === paymentReturnModal.orderId);
    if (
      match &&
      ['Pago', 'Pagamento Aprovado', 'Em Separação', 'Produto Enviado', 'Produto Entregue'].includes(
        match.status
      )
    ) {
      void triggerConfirmedSideEffects(match, store.email, {
        captureMethod: match.infinitePay?.captureMethod || paymentReturnModal.captureMethod,
        receiptUrl: match.infinitePay?.receiptUrl || paymentReturnModal.receiptUrl,
      });
      setPaymentReturnModal((prev) =>
        prev
          ? {
              ...prev,
              phase: 'approved',
              captureMethod: match.infinitePay?.captureMethod || prev.captureMethod,
              receiptUrl: match.infinitePay?.receiptUrl || prev.receiptUrl,
            }
          : null
      );
    }
  }, [store.orders, store.email, paymentReturnModal, triggerConfirmedSideEffects]);

  useEffect(() => {
    const onPopState = () => {
      setIsAdminView(checkIsAdminRoute());
      setIsAccountView(checkIsAccountRoute());
    };
    window.addEventListener('popstate', onPopState);
    window.addEventListener('hashchange', onPopState);
    return () => {
      window.removeEventListener('popstate', onPopState);
      window.removeEventListener('hashchange', onPopState);
    };
  }, []);

  useEffect(() => {
    if (isAdminView || isCartOpen) {
      void refreshFromCloud();
    }
  }, [isAdminView, isCartOpen, refreshFromCloud]);

  const openAdmin = () => {
    setIsAdminView(true);
    setIsAccountView(false);
    void refreshFromCloud();
    try {
      window.history.pushState({}, '', '/admin');
    } catch {
      window.location.hash = '#/admin';
    }
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const openAccount = () => {
    setIsAdminView(false);
    setIsAccountView(true);
    try {
      window.history.pushState({}, '', '/minha-conta');
    } catch {
      window.location.hash = '#/minha-conta';
    }
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const goHome = () => {
    setIsAdminView(false);
    setIsAccountView(false);
    try {
      window.history.pushState({}, '', '/');
    } catch {
      window.location.hash = '';
    }
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const cartCount = useMemo(
    () => cart.reduce((acc, item) => acc + item.quantity, 0),
    [cart]
  );

  const cartPixSubtotal = useMemo(() => {
    return roundCurrency(
      cart.reduce((acc, item) => {
        const product = store.products.find((p) => p.id === item.productId);
        if (!product) return acc;
        return (
          acc +
          calcPixPrice(product.basePrice, store.payment.pixDiscountPercent) * item.quantity
        );
      }, 0)
    );
  }, [cart, store.products, store.payment.pixDiscountPercent]);

  const filteredProducts = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();

    const list = store.products.filter((prod) => {
      if (activeDepartment === 'OFERTAS RELÂMPAGO') {
        if (!prod.isFlashDeal) return false;
      } else if (activeDepartment === 'PERIFÉRICOS') {
        if (prod.category === 'SSDs & Memórias') return false;
      } else if (activeDepartment !== 'TODOS') {
        if (prod.category.toUpperCase() !== activeDepartment.toUpperCase()) return false;
      }

      if (query) {
        const hay = `${prod.name} ${prod.category} ${prod.sku} ${prod.description}`.toLowerCase();
        if (!hay.includes(query)) return false;
      }

      return true;
    });

    const sorted = [...list];
    if (sortBy === 'price_asc') {
      sorted.sort((a, b) => a.basePrice - b.basePrice);
    } else if (sortBy === 'price_desc') {
      sorted.sort((a, b) => b.basePrice - a.basePrice);
    } else if (sortBy === 'discount') {
      sorted.sort((a, b) => {
        const savA = a.basePrice - calcPixPrice(a.basePrice, store.payment.pixDiscountPercent);
        const savB = b.basePrice - calcPixPrice(b.basePrice, store.payment.pixDiscountPercent);
        return savB - savA;
      });
    } else {
      sorted.sort((a, b) => {
        const scoreA = (a.isFlashDeal ? 2 : 0) + (a.isBestSeller ? 1 : 0);
        const scoreB = (b.isFlashDeal ? 2 : 0) + (b.isBestSeller ? 1 : 0);
        return scoreB - scoreA;
      });
    }

    return sorted;
  }, [store.products, activeDepartment, searchQuery, sortBy, store.payment.pixDiscountPercent]);

  const handleAddToCart = (product: Product) => {
    addToCart(product.id, 1);
    setIsCartOpen(true);
  };

  const handleToggleFavorite = (productId: string) => {
    const ok = toggleFavoriteProduct(productId);
    if (!ok) {
      setSelectedProduct(null);
      openAccount();
    }
  };

  const adminCloudErrorToast =
    cloudSyncNotice && !cloudSyncNotice.ok ? (
      <div
        role="alert"
        aria-live="assertive"
        className="fixed bottom-5 right-5 z-[110] max-w-md flex items-start gap-2.5 px-4 py-3 rounded-md border border-red-500 bg-[#161A20] text-red-200 shadow-2xl text-xs sm:text-sm font-semibold"
      >
        <AlertCircle className="w-4 h-4 shrink-0 mt-0.5 text-red-400" />
        <div className="flex-1 min-w-0 leading-snug break-words">
          {cloudSyncNotice.message}
        </div>
        <button
          type="button"
          onClick={clearCloudSyncNotice}
          className="p-0.5 text-slate-400 hover:text-white shrink-0"
          aria-label="Fechar aviso"
        >
          <X className="w-4 h-4" />
        </button>
      </div>
    ) : null;

  if (isAdminView) {
    return (
      <>
        <AdminPanel
          store={store}
          setStore={setStore}
          onSaveChanges={saveStoreChanges}
          onUpsertProduct={upsertProduct}
          onDeleteProduct={deleteProduct}
          onUpdateOrderStatus={updateOrderStatus}
          onUpdateOrderTracking={updateOrderTracking}
          onUpdateOrderFulfillment={updateOrderFulfillment}
          onExportJson={exportBackupJson}
          onImportJson={importBackupJson}
          onRefreshCloud={refreshFromCloud}
          onExitAdmin={goHome}
        />
        {adminCloudErrorToast}
      </>
    );
  }

  return (
    <div className="min-h-screen bg-[#0B0D10] text-white flex flex-col">
      <Header
        logoUrl={store.visual.logoUrl}
        topPromoText={store.visual.topPromoText}
        topPromoNotices={store.visual.topPromoNotices}
        topPromoSpeed={store.visual.topPromoSpeed || 'normal'}
        accentColor={store.visual.accentColor}
        searchQuery={searchQuery}
        onSearchChange={(q) => {
          setSearchQuery(q);
          if (isAccountView) {
            goHome();
          }
        }}
        activeDepartment={activeDepartment}
        onSelectDepartment={(dept) => {
          setActiveDepartment(dept);
          if (isAccountView) {
            goHome();
          }
        }}
        cartCount={cartCount}
        cartPixSubtotal={cartPixSubtotal}
        currentCustomerName={currentCustomer?.fullName || null}
        onOpenCart={() => setIsCartOpen(true)}
        onOpenAccount={openAccount}
        onGoHome={() => {
          setActiveDepartment('TODOS');
          setSearchQuery('');
          goHome();
        }}
      />

      {isAccountView ? (
        <main className="flex-1 flex flex-col">
          <CustomerAccountView
            store={store}
            currentCustomer={currentCustomer}
            accentColor={store.visual.accentColor}
            onLogin={loginCustomer}
            onRegister={registerCustomer}
            onLogout={logoutCustomer}
            onUpdateCustomer={updateCustomerAccount}
            onResetPassword={resetCustomerPassword}
            onToggleFavorite={toggleFavoriteProduct}
            onAddToCart={handleAddToCart}
            onBackToStore={goHome}
          />
        </main>
      ) : (
        <main className="flex-1">
          {/* Compact Hero Banner (320px desktop) */}
          <HeroBanner
            banners={store.visual.banners}
            mobileBannerUrl={store.visual.mobileBannerUrl}
            accentColor={store.visual.accentColor}
            onSelectDepartment={(dept) => setActiveDepartment(dept)}
          />

          {/* Flash Deals Countdown Strip */}
          <FlashDealsStrip
            enabled={store.visual.flashSaleEnabled}
            title={store.visual.flashSaleTitle}
            endTimeIso={store.visual.flashSaleEndTime}
            accentColor={store.visual.accentColor}
            isFlashFiltered={activeDepartment === 'OFERTAS RELÂMPAGO'}
            onFilterFlash={() =>
              setActiveDepartment((prev) =>
                prev === 'OFERTAS RELÂMPAGO' ? 'TODOS' : 'OFERTAS RELÂMPAGO'
              )
            }
          />

          {/* Catalog Grid Section */}
          <section className="max-w-[1360px] mx-auto px-3 sm:px-6 pt-6">
            <div className="flex flex-wrap items-center justify-between gap-3 pb-4 border-b border-[#272D38]">
              <div>
                <h2 className="font-display font-extrabold text-xl sm:text-2xl uppercase tracking-wider text-white">
                  {activeDepartment === 'TODOS'
                    ? 'Hardware & Periféricos em Destaque'
                    : activeDepartment}
                </h2>
                <p className="text-xs text-slate-400 mt-0.5 font-mono-num">
                  {filteredProducts.length}{' '}
                  {filteredProducts.length === 1 ? 'produto encontrado' : 'produtos encontrados'}
                  {searchQuery && ` para "${searchQuery}"`}
                </p>
              </div>

              <div className="flex items-center gap-2">
                <ArrowUpDown className="w-4 h-4 text-slate-400" aria-hidden="true" />
                <label htmlFor="catalog-sort" className="sr-only">
                  Ordenar produtos
                </label>
                <select
                  id="catalog-sort"
                  value={sortBy}
                  onChange={(e) => setSortBy(e.target.value as SortOption)}
                  className="h-9 px-3 rounded bg-[#161A20] border border-[#272D38] text-xs font-medium text-white focus:outline-none focus:border-white/50"
                >
                  <option value="featured">Mais Relevantes</option>
                  <option value="price_asc">Menor Preço no PIX</option>
                  <option value="price_desc">Maior Preço no PIX</option>
                  <option value="discount">Maior Economia no PIX</option>
                </select>
              </div>
            </div>

            {filteredProducts.length === 0 ? (
              <div className="my-10 p-10 rounded-md bg-[#161A20] border border-[#272D38] text-center space-y-3">
                <h3 className="font-display font-bold text-xl uppercase text-white">
                  Nenhum produto encontrado
                </h3>
                <p className="text-sm text-slate-400">
                  Não encontramos itens correspondentes ao seu filtro ou busca atual.
                </p>
                <button
                  type="button"
                  onClick={() => {
                    setActiveDepartment('TODOS');
                    setSearchQuery('');
                  }}
                  className="inline-flex items-center gap-1.5 px-4 py-2 rounded font-display font-bold uppercase tracking-wider text-xs text-white"
                  style={{ backgroundColor: store.visual.accentColor }}
                >
                  <RotateCcw className="w-3.5 h-3.5" />
                  <span>Limpar Filtros</span>
                </button>
              </div>
            ) : (
              <div className="mt-5 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 sm:gap-5">
                {filteredProducts.map((product) => (
                  <ProductCard
                    key={product.id}
                    product={product}
                    paymentConfig={store.payment}
                    accentColor={store.visual.accentColor}
                    isFavorite={
                      currentCustomer?.favoriteProductIds.includes(product.id) ?? false
                    }
                    onToggleFavorite={handleToggleFavorite}
                    onAddToCart={handleAddToCart}
                    onSelectProduct={setSelectedProduct}
                  />
                ))}
              </div>
            )}
          </section>
        </main>
      )}

      <Footer
        logoUrl={store.visual.logoUrl}
        fiscal={store.fiscal}
        officialEmail={store.email.officialEmail}
        payment={store.payment}
        shipping={store.shipping}
        accentColor={store.visual.accentColor}
        onOpenAdmin={openAdmin}
      />

      <ProductDetailModal
        product={selectedProduct}
        paymentConfig={store.payment}
        shippingConfig={store.shipping}
        accentColor={store.visual.accentColor}
        cep={shippingCep}
        onCepChange={setShippingCep}
        viaCepAddress={viaCepAddress}
        onViaCepResolved={setViaCepAddress}
        selectedShippingMethod={selectedShippingMethod}
        onSelectShippingMethod={(quote) => setSelectedShippingMethod(quote.method)}
        isFavorite={
          selectedProduct
            ? currentCustomer?.favoriteProductIds.includes(selectedProduct.id) ?? false
            : false
        }
        onToggleFavorite={handleToggleFavorite}
        onClose={() => setSelectedProduct(null)}
        onAddToCart={handleAddToCart}
      />

      <CartCheckoutDrawer
        isOpen={isCartOpen}
        onClose={() => setIsCartOpen(false)}
        cart={cart}
        store={store}
        currentCustomer={currentCustomer}
        cep={shippingCep}
        onCepChange={setShippingCep}
        viaCepAddress={viaCepAddress}
        onViaCepResolved={setViaCepAddress}
        selectedShippingMethod={selectedShippingMethod}
        onSelectShippingMethod={(quote) => setSelectedShippingMethod(quote.method)}
        onUpdateQty={updateCartQty}
        onRemoveItem={removeFromCart}
        onClearCart={clearCart}
        onCreateOrder={createOrder}
        onMarkOrderAsPaid={markOrderAsPaid}
        onMarkOrderEmailSent={markOrderEmailSent}
        onPaymentApprovedPopup={(paidOrder) => {
          setIsCartOpen(false);
          setPaymentReturnModal({
            open: true,
            orderId: paidOrder.id,
            phase: 'approved',
            captureMethod: paidOrder.paymentMethod === 'pix' ? 'pix' : paidOrder.infinitePay?.captureMethod,
            receiptUrl: paidOrder.infinitePay?.receiptUrl,
            transactionNsu: paidOrder.infinitePay?.transactionNsu,
            slug: paidOrder.infinitePay?.slug,
          });
        }}
        onRefreshCloud={refreshFromCloud}
      />

      {paymentReturnModal?.open &&
        (() => {
          const returnedOrder = store.orders.find(
            (o) => o.id === paymentReturnModal.orderId
          );
          const closeReturnModal = () => {
            setPaymentReturnModal(null);
            try {
              window.history.replaceState({}, '', '/');
            } catch {
              // Ignore history replacement warnings
            }
          };

          return (
            <div
              className="fixed inset-0 z-[95] flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm"
              role="dialog"
              aria-modal="true"
              aria-label="Confirmação de Pagamento"
              onClick={closeReturnModal}
            >
              <div
                className="w-full max-w-md bg-[#161A20] border border-[#272D38] rounded-md p-6 shadow-2xl space-y-4 text-center"
                onClick={(e) => e.stopPropagation()}
              >
                {paymentReturnModal.phase === 'verifying' ? (
                  <>
                    <Loader2 className="w-11 h-11 text-[#FF6500] animate-spin mx-auto" />
                    <h3 className="font-display font-extrabold text-2xl uppercase tracking-wider text-white">
                      Confirmando Pagamento...
                    </h3>
                    <p className="text-xs text-slate-300 leading-relaxed">
                      Validando o retorno do pedido{' '}
                      <strong className="font-mono-num text-white">
                        #{paymentReturnModal.orderId}
                      </strong>{' '}
                      junto à InfinitePay e ao Supabase.
                    </p>
                  </>
                ) : paymentReturnModal.phase === 'approved' ? (
                  <>
                    <CheckCircle2 className="w-12 h-12 text-[#00E676] mx-auto" />
                    <h3 className="font-display font-extrabold text-2xl uppercase tracking-wider text-white">
                      Pagamento Confirmado!
                    </h3>
                    <p className="text-xs text-slate-300 leading-relaxed">
                      Seu pedido{' '}
                      <strong className="font-mono-num text-white">
                        #{paymentReturnModal.orderId}
                      </strong>{' '}
                      foi confirmado com status <strong className="text-[#00E676]">Pago</strong>.
                      A mensagem de confirmação foi enviada para o seu e-mail e em breve você receberá a NF-e.
                    </p>
                    {returnedOrder && (
                      <div className="p-3 rounded bg-[#0B0D10] border border-[#272D38] text-xs space-y-1">
                        <div className="text-slate-400">
                          Valor Total:{' '}
                          <strong className="font-mono-num text-[#00E676]">
                            {formatBRL(returnedOrder.totalAmount)}
                          </strong>
                        </div>
                        {paymentReturnModal.captureMethod && (
                          <div className="text-slate-400">
                            Meio:{' '}
                            <strong className="text-white uppercase">
                              {paymentReturnModal.captureMethod === 'pix'
                                ? 'PIX (InfinitePay)'
                                : paymentReturnModal.captureMethod === 'credit_card'
                                ? 'Cartão de Crédito (InfinitePay)'
                                : paymentReturnModal.captureMethod}
                            </strong>
                          </div>
                        )}
                      </div>
                    )}
                    <div className="flex flex-col gap-2 pt-1">
                      {paymentReturnModal.receiptUrl && (
                        <a
                          href={paymentReturnModal.receiptUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="w-full h-10 rounded bg-[#0B0D10] border border-[#272D38] hover:border-slate-500 text-xs font-semibold text-white inline-flex items-center justify-center gap-1.5"
                        >
                          <ExternalLink className="w-4 h-4 text-[#00E676]" />
                          <span>Ver Comprovante InfinitePay</span>
                        </a>
                      )}
                      <button
                        type="button"
                        onClick={() => {
                          closeReturnModal();
                          openAccount();
                        }}
                        className="w-full h-11 rounded font-display font-extrabold text-sm uppercase tracking-wider text-white inline-flex items-center justify-center gap-2"
                        style={{ backgroundColor: store.visual.accentColor || '#FF6500' }}
                      >
                        <ShoppingBag className="w-4 h-4" />
                        <span>Acompanhar em Meus Pedidos</span>
                      </button>
                      <button
                        type="button"
                        onClick={closeReturnModal}
                        className="w-full h-10 rounded border border-[#272D38] text-xs font-semibold text-slate-300 hover:text-white"
                      >
                        Continuar Navegando na Loja
                      </button>
                    </div>
                  </>
                ) : (
                  <>
                    <AlertCircle className="w-11 h-11 text-amber-400 mx-auto" />
                    <h3 className="font-display font-extrabold text-2xl uppercase tracking-wider text-white">
                      Pedido #{paymentReturnModal.orderId} Registrado
                    </h3>
                    <p className="text-xs text-slate-300 leading-relaxed">
                      {paymentReturnModal.message ||
                        'Assim que a InfinitePay confirmar o pagamento, o status será atualizado automaticamente para Pago.'}
                    </p>
                    <div className="flex flex-col gap-2 pt-1">
                      <button
                        type="button"
                        onClick={() => {
                          setPaymentReturnModal((prev) =>
                            prev ? { ...prev, phase: 'verifying' } : null
                          );
                          void verifyReturnedPayment({
                            orderId: paymentReturnModal.orderId,
                            transactionNsu: paymentReturnModal.transactionNsu,
                            slug: paymentReturnModal.slug,
                            captureMethod: paymentReturnModal.captureMethod,
                            receiptUrl: paymentReturnModal.receiptUrl,
                          });
                        }}
                        className="w-full h-11 rounded font-display font-extrabold text-sm uppercase tracking-wider text-white inline-flex items-center justify-center gap-2"
                        style={{ backgroundColor: store.visual.accentColor || '#FF6500' }}
                      >
                        <RotateCcw className="w-4 h-4" />
                        <span>Verificar Confirmação Agora</span>
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          closeReturnModal();
                          setIsCartOpen(true);
                        }}
                        className="w-full h-10 rounded bg-[#0B0D10] border border-[#00E676]/60 hover:bg-[#00E676]/10 text-xs font-bold uppercase tracking-wider text-[#00E676]"
                      >
                        Trocar Forma de Pagamento (Abrir Carrinho)
                      </button>
                      <button
                        type="button"
                        onClick={closeReturnModal}
                        className="w-full h-10 rounded border border-[#272D38] text-xs font-semibold text-slate-300 hover:text-white"
                      >
                        Fechar
                      </button>
                    </div>
                  </>
                )}
              </div>
            </div>
          );
        })()}

    </div>
  );
}
