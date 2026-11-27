import { useMemo, useState } from 'react';
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import {
  BarChart3,
  Clock,
  CreditCard,
  DollarSign,
  Package,
  RefreshCw,
  TrendingUp,
} from 'lucide-react';
import { Order } from '../types/store';
import { formatBRL, roundCurrency } from '../utils/formatters';

interface AdminReportsTabProps {
  orders: Order[];
  accentColor: string;
  onRefreshCloud?: () => Promise<unknown> | void;
}

type PeriodFilter = 'today' | '7d' | '30d' | 'all';

const PAID_STATUSES = new Set([
  'Pago',
  'Pagamento Aprovado',
  'Em Separação',
  'Produto Enviado',
  'Produto Entregue',
]);

const PENDING_STATUSES = new Set(['Aguardando Pagamento', 'Pedido Realizado']);

const PERIOD_OPTIONS: { id: PeriodFilter; label: string }[] = [
  { id: 'today', label: 'Hoje' },
  { id: '7d', label: 'Últimos 7 dias' },
  { id: '30d', label: 'Últimos 30 dias' },
  { id: 'all', label: 'Tudo' },
];

function getPeriodStart(period: PeriodFilter): number | null {
  const now = new Date();
  if (period === 'today') {
    const start = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);
    return start.getTime();
  }
  if (period === '7d') {
    return now.getTime() - 7 * 24 * 60 * 60 * 1000;
  }
  if (period === '30d') {
    return now.getTime() - 30 * 24 * 60 * 60 * 1000;
  }
  return null;
}

function formatDayKey(iso: string): { sortKey: string; label: string } {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) {
    return { sortKey: '0000-00-00', label: '--/--' };
  }
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return {
    sortKey: `${yyyy}-${mm}-${dd}`,
    label: `${dd}/${mm}`,
  };
}

export function AdminReportsTab({
  orders,
  accentColor,
  onRefreshCloud,
}: AdminReportsTabProps) {
  const [period, setPeriod] = useState<PeriodFilter>('30d');
  const [isRefreshing, setIsRefreshing] = useState(false);

  const handleRefresh = async () => {
    if (!onRefreshCloud || isRefreshing) return;
    setIsRefreshing(true);
    try {
      await onRefreshCloud();
    } finally {
      setIsRefreshing(false);
    }
  };

  const filteredOrders = useMemo(() => {
    const startMs = getPeriodStart(period);
    return orders.filter((o) => {
      if (startMs === null) return true;
      const t = new Date(o.createdAt).getTime();
      return !Number.isNaN(t) && t >= startMs;
    });
  }, [orders, period]);

  const metrics = useMemo(() => {
    const paidOrders = filteredOrders.filter((o) => PAID_STATUSES.has(o.status));
    const pendingOrders = filteredOrders.filter((o) => PENDING_STATUSES.has(o.status));

    const totalRevenue = roundCurrency(
      paidOrders.reduce((acc, o) => acc + (Number(o.totalAmount) || 0), 0)
    );
    const pendingRevenue = roundCurrency(
      pendingOrders.reduce((acc, o) => acc + (Number(o.totalAmount) || 0), 0)
    );
    const averageTicket =
      paidOrders.length > 0 ? roundCurrency(totalRevenue / paidOrders.length) : 0;

    return {
      totalRevenue,
      averageTicket,
      paidCount: paidOrders.length,
      pendingCount: pendingOrders.length,
      pendingRevenue,
    };
  }, [filteredOrders]);

  const dailySeries = useMemo(() => {
    const grouped = new Map<
      string,
      { sortKey: string; day: string; faturamento: number; pedidosPagos: number; totalPedidos: number }
    >();

    filteredOrders.forEach((order) => {
      if (order.status === 'Cancelado') return;
      const { sortKey, label } = formatDayKey(order.createdAt);
      const current = grouped.get(sortKey) || {
        sortKey,
        day: label,
        faturamento: 0,
        pedidosPagos: 0,
        totalPedidos: 0,
      };
      current.totalPedidos += 1;
      if (PAID_STATUSES.has(order.status)) {
        current.faturamento = roundCurrency(
          current.faturamento + (Number(order.totalAmount) || 0)
        );
        current.pedidosPagos += 1;
      }
      grouped.set(sortKey, current);
    });

    return Array.from(grouped.values()).sort((a, b) => a.sortKey.localeCompare(b.sortKey));
  }, [filteredOrders]);

  const topProducts = useMemo(() => {
    const map = new Map<
      string,
      { id: string; sku: string; name: string; shortName: string; quantity: number; revenue: number }
    >();

    filteredOrders.forEach((order) => {
      if (order.status === 'Cancelado') return;
      order.items.forEach((item) => {
        const key = item.productId || item.sku || item.name;
        const unitPrice =
          order.paymentMethod === 'pix' ? item.unitPixPrice : item.unitBasePrice;
        const lineRevenue = roundCurrency((Number(unitPrice) || 0) * (item.quantity || 1));
        const existing = map.get(key) || {
          id: key,
          sku: item.sku || '',
          name: item.name || 'Produto BTHTECH',
          shortName:
            (item.name || 'Produto').length > 26
              ? `${(item.name || 'Produto').slice(0, 24)}...`
              : item.name || 'Produto',
          quantity: 0,
          revenue: 0,
        };
        existing.quantity += Number(item.quantity) || 1;
        existing.revenue = roundCurrency(existing.revenue + lineRevenue);
        map.set(key, existing);
      });
    });

    return Array.from(map.values()).sort(
      (a, b) => b.quantity - a.quantity || b.revenue - a.revenue
    );
  }, [filteredOrders]);

  const topProductsChartData = useMemo(() => topProducts.slice(0, 6), [topProducts]);

  return (
    <div className="space-y-6">
      {/* Header & Period Filter Bar */}
      <div className="bg-[#161A20] border border-[#272D38] rounded-md p-4 sm:p-5 flex flex-wrap items-center justify-between gap-4">
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <BarChart3 className="w-5 h-5" style={{ color: accentColor }} />
            <h2 className="font-display font-bold text-lg uppercase tracking-wider text-white">
              Relatórios de Vendas e Desempenho
            </h2>
          </div>
          <p className="text-xs text-slate-400">
            Dados consolidados diretamente dos pedidos armazenados no Supabase (`bthtech_store` / `main_store`).
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <div
            className="inline-flex items-center gap-1 p-1 rounded bg-[#0B0D10] border border-[#272D38]"
            role="group"
            aria-label="Filtrar período dos relatórios"
          >
            {PERIOD_OPTIONS.map((opt) => {
              const active = period === opt.id;
              return (
                <button
                  key={opt.id}
                  type="button"
                  onClick={() => setPeriod(opt.id)}
                  className={`px-3 py-1.5 rounded text-xs font-semibold whitespace-nowrap shrink-0 transition-colors ${
                    active ? 'text-white' : 'text-slate-400 hover:text-white'
                  }`}
                  style={active ? { backgroundColor: accentColor } : undefined}
                >
                  {opt.label}
                </button>
              );
            })}
          </div>

          {onRefreshCloud && (
            <button
              type="button"
              onClick={handleRefresh}
              disabled={isRefreshing}
              className="inline-flex items-center gap-1.5 px-3 py-2 rounded bg-[#0B0D10] border border-[#272D38] hover:border-slate-500 text-xs font-semibold text-slate-200 whitespace-nowrap shrink-0 disabled:opacity-60"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${isRefreshing ? 'animate-spin' : ''}`} />
              <span>{isRefreshing ? 'Atualizando...' : 'Atualizar'}</span>
            </button>
          )}
        </div>
      </div>

      {/* 4 KPI Summary Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="bg-[#161A20] border border-[#272D38] rounded-md p-4 space-y-2">
          <div className="flex items-center justify-between text-xs text-slate-400">
            <span className="font-semibold uppercase tracking-wider">Faturamento Total</span>
            <DollarSign className="w-4 h-4 text-[#00E676]" />
          </div>
          <div className="text-2xl font-mono-num font-bold tabular-nums text-[#00E676]">
            {formatBRL(metrics.totalRevenue)}
          </div>
          <div className="text-[11px] text-slate-400">
            Soma dos pedidos confirmados e pagos
          </div>
        </div>

        <div className="bg-[#161A20] border border-[#272D38] rounded-md p-4 space-y-2">
          <div className="flex items-center justify-between text-xs text-slate-400">
            <span className="font-semibold uppercase tracking-wider">Ticket Médio</span>
            <TrendingUp className="w-4 h-4" style={{ color: accentColor }} />
          </div>
          <div className="text-2xl font-mono-num font-bold tabular-nums text-white">
            {formatBRL(metrics.averageTicket)}
          </div>
          <div className="text-[11px] text-slate-400">
            Média por pedido pago no período
          </div>
        </div>

        <div className="bg-[#161A20] border border-[#272D38] rounded-md p-4 space-y-2">
          <div className="flex items-center justify-between text-xs text-slate-400">
            <span className="font-semibold uppercase tracking-wider">Pedidos Pagos</span>
            <CreditCard className="w-4 h-4 text-[#00E676]" />
          </div>
          <div className="text-2xl font-mono-num font-bold tabular-nums text-white">
            {metrics.paidCount}
          </div>
          <div className="text-[11px] text-slate-400">
            Pagos, aprovados, em separação ou enviados
          </div>
        </div>

        <div className="bg-[#161A20] border border-[#272D38] rounded-md p-4 space-y-2">
          <div className="flex items-center justify-between text-xs text-slate-400">
            <span className="font-semibold uppercase tracking-wider">Aguardando Pagamento</span>
            <Clock className="w-4 h-4 text-amber-400" />
          </div>
          <div className="text-2xl font-mono-num font-bold tabular-nums text-amber-300">
            {metrics.pendingCount}
          </div>
          <div className="text-[11px] font-mono-num tabular-nums text-slate-400">
            Em aberto: {formatBRL(metrics.pendingRevenue)}
          </div>
        </div>
      </div>

      {/* Daily Revenue & Volume Chart */}
      <div className="bg-[#161A20] border border-[#272D38] rounded-md p-5 space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[#272D38] pb-3">
          <div>
            <h3 className="font-display font-bold text-base uppercase tracking-wider text-white">
              Faturamento e Volume por Dia
            </h3>
            <p className="text-xs text-slate-400">
              Evolução diária do faturamento confirmado em reais (R$) e quantidade de pedidos.
            </p>
          </div>
          <span className="text-xs font-mono-num tabular-nums text-slate-400">
            {dailySeries.length} {dailySeries.length === 1 ? 'dia com movimento' : 'dias com movimento'}
          </span>
        </div>

        {dailySeries.length === 0 ? (
          <div className="py-12 text-center space-y-2 border border-dashed border-[#272D38] rounded bg-[#0B0D10]/50">
            <BarChart3 className="w-8 h-8 text-slate-500 mx-auto" />
            <p className="text-sm font-semibold text-slate-300">
              Nenhum pedido encontrado para este período
            </p>
            <p className="text-xs text-slate-400">
              Assim que novos pedidos forem realizados, a evolução diária aparecerá automaticamente aqui.
            </p>
          </div>
        ) : (
          <div className="h-72 w-full">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart
                data={dailySeries}
                margin={{ top: 10, right: 16, left: 8, bottom: 0 }}
              >
                <defs>
                  <linearGradient id="bthtechRevenueGrad" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#00E676" stopOpacity={0.35} />
                    <stop offset="95%" stopColor="#00E676" stopOpacity={0.02} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="#272D38" vertical={false} />
                <XAxis
                  dataKey="day"
                  stroke="#94A3B8"
                  tick={{ fill: '#94A3B8', fontSize: 11 }}
                  axisLine={{ stroke: '#272D38' }}
                  tickLine={false}
                />
                <YAxis
                  stroke="#94A3B8"
                  tick={{ fill: '#94A3B8', fontSize: 11 }}
                  axisLine={false}
                  tickLine={false}
                  tickFormatter={(val: number) =>
                    val >= 1000 ? `R$ ${(val / 1000).toFixed(1)}k` : `R$ ${val}`
                  }
                />
                <Tooltip
                  content={({ active, payload, label }) => {
                    if (!active || !payload || payload.length === 0) return null;
                    const row = payload[0]?.payload as {
                      faturamento: number;
                      pedidosPagos: number;
                      totalPedidos: number;
                    };
                    return (
                      <div className="bg-[#0B0D10] border border-[#272D38] rounded p-3 shadow-xl text-xs space-y-1">
                        <div className="font-bold text-white border-b border-[#272D38] pb-1">
                          Data: {label}
                        </div>
                        <div className="flex items-center justify-between gap-4 font-mono-num tabular-nums">
                          <span className="text-slate-400">Faturamento Pago:</span>
                          <span className="font-bold text-[#00E676]">
                            {formatBRL(row.faturamento)}
                          </span>
                        </div>
                        <div className="flex items-center justify-between gap-4 font-mono-num tabular-nums">
                          <span className="text-slate-400">Pedidos Pagos:</span>
                          <span className="font-bold text-white">{row.pedidosPagos}</span>
                        </div>
                        <div className="flex items-center justify-between gap-4 font-mono-num tabular-nums">
                          <span className="text-slate-400">Total de Pedidos:</span>
                          <span className="font-semibold text-slate-300">{row.totalPedidos}</span>
                        </div>
                      </div>
                    );
                  }}
                />
                <Area
                  type="monotone"
                  dataKey="faturamento"
                  name="Faturamento"
                  stroke="#00E676"
                  strokeWidth={2.5}
                  fillOpacity={1}
                  fill="url(#bthtechRevenueGrad)"
                />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        )}
      </div>

      {/* Top Selling Products Chart & Ranking Table */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="bg-[#161A20] border border-[#272D38] rounded-md p-5 space-y-4">
          <div className="flex items-center justify-between border-b border-[#272D38] pb-3">
            <div className="flex items-center gap-2">
              <Package className="w-4 h-4" style={{ color: accentColor }} />
              <h3 className="font-display font-bold text-base uppercase tracking-wider text-white">
                Gráfico de Produtos Mais Vendidos
              </h3>
            </div>
            <span className="text-xs text-slate-400">Por unidades</span>
          </div>

          {topProductsChartData.length === 0 ? (
            <div className="py-12 text-center text-xs text-slate-400 border border-dashed border-[#272D38] rounded bg-[#0B0D10]/50">
              Sem vendas de produtos registradas no período selecionado.
            </div>
          ) : (
            <div className="h-72 w-full">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart
                  data={topProductsChartData}
                  layout="vertical"
                  margin={{ top: 4, right: 20, left: 10, bottom: 4 }}
                >
                  <CartesianGrid strokeDasharray="3 3" stroke="#272D38" horizontal={false} />
                  <XAxis
                    type="number"
                    allowDecimals={false}
                    stroke="#94A3B8"
                    tick={{ fill: '#94A3B8', fontSize: 11 }}
                    axisLine={{ stroke: '#272D38' }}
                    tickLine={false}
                  />
                  <YAxis
                    type="category"
                    dataKey="shortName"
                    width={145}
                    stroke="#94A3B8"
                    tick={{ fill: '#E2E8F0', fontSize: 11 }}
                    axisLine={false}
                    tickLine={false}
                  />
                  <Tooltip
                    cursor={{ fill: 'rgba(255,255,255,0.04)' }}
                    content={({ active, payload }) => {
                      if (!active || !payload || payload.length === 0) return null;
                      const item = payload[0]?.payload as {
                        name: string;
                        quantity: number;
                        revenue: number;
                      };
                      return (
                        <div className="bg-[#0B0D10] border border-[#272D38] rounded p-3 shadow-xl text-xs max-w-xs space-y-1">
                          <div className="font-semibold text-white">{item.name}</div>
                          <div className="flex justify-between gap-4 font-mono-num tabular-nums">
                            <span className="text-slate-400">Qtd. Vendida:</span>
                            <span className="font-bold text-white">{item.quantity} un.</span>
                          </div>
                          <div className="flex justify-between gap-4 font-mono-num tabular-nums">
                            <span className="text-slate-400">Receita Gerada:</span>
                            <span className="font-bold text-[#00E676]">
                              {formatBRL(item.revenue)}
                            </span>
                          </div>
                        </div>
                      );
                    }}
                  />
                  <Bar dataKey="quantity" radius={[0, 4, 4, 0]} barSize={22}>
                    {topProductsChartData.map((_, idx) => (
                      <Cell
                        key={`cell-${idx}`}
                        fill={idx === 0 ? accentColor : idx === 1 ? '#00E676' : '#3B82F6'}
                      />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}
        </div>

        {/* Ranking Table */}
        <div className="bg-[#161A20] border border-[#272D38] rounded-md p-5 space-y-4">
          <div className="flex items-center justify-between border-b border-[#272D38] pb-3">
            <h3 className="font-display font-bold text-base uppercase tracking-wider text-white">
              Ranking de Produtos Campeões
            </h3>
            <span className="text-xs font-mono-num tabular-nums text-slate-400">
              {topProducts.length} {topProducts.length === 1 ? 'item' : 'itens'}
            </span>
          </div>

          {topProducts.length === 0 ? (
            <div className="py-12 text-center text-xs text-slate-400 border border-dashed border-[#272D38] rounded bg-[#0B0D10]/50">
              Os produtos mais vendidos aparecerão aqui assim que houver pedidos no período.
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-xs text-left border-collapse">
                <thead>
                  <tr className="border-b border-[#272D38] text-[11px] uppercase tracking-wider text-slate-400">
                    <th className="py-2 pr-2 font-semibold">#</th>
                    <th className="py-2 px-2 font-semibold">Produto</th>
                    <th className="py-2 px-2 font-semibold text-right">Qtd.</th>
                    <th className="py-2 pl-2 font-semibold text-right">Receita</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[#272D38]">
                  {topProducts.slice(0, 10).map((item, idx) => (
                    <tr key={item.id} className="hover:bg-[#0B0D10]/60 transition-colors">
                      <td className="py-2.5 pr-2 font-mono-num tabular-nums font-bold text-slate-400">
                        {idx + 1}º
                      </td>
                      <td className="py-2.5 px-2">
                        <div className="font-medium text-white line-clamp-1">{item.name}</div>
                        {item.sku && (
                          <div className="text-[11px] font-mono-num text-slate-400">
                            SKU: {item.sku}
                          </div>
                        )}
                      </td>
                      <td className="py-2.5 px-2 text-right font-mono-num tabular-nums font-bold text-white whitespace-nowrap">
                        {item.quantity}
                      </td>
                      <td className="py-2.5 pl-2 text-right font-mono-num tabular-nums font-bold text-[#00E676] whitespace-nowrap">
                        {formatBRL(item.revenue)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
