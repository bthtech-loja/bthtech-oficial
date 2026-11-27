import defaultConfig from '../defaultConfig.json';
import { StoreState } from '../types/store';

const SUPABASE_URL = (
  (import.meta.env.VITE_SUPABASE_URL as string | undefined) ||
  defaultConfig.supabase?.url ||
  'https://yzjelmroikleduddentc.supabase.co'
)
  .trim()
  .replace(/\/+$/, '');

const SUPABASE_ANON_KEY = (
  (import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined) ||
  defaultConfig.supabase?.anonKey ||
  'sb_publishable_9ip-3TaQYG9ENG3pw0d1Og_8ntFKBsq'
).trim();

const SUPABASE_TABLE = (defaultConfig.supabase?.table || 'bthtech_store').trim();
const SUPABASE_ROW_ID = (defaultConfig.supabase?.rowId || 'main_store').trim();

export function hasValidSupabaseEndpoint(): boolean {
  try {
    const parsed = new URL(SUPABASE_URL);
    if (parsed.protocol !== 'https:') return false;
    // Bare https://supabase.co without a <project-ref> subdomain is not a REST API host
    const host = parsed.hostname.toLowerCase();
    if (host === 'supabase.co' || host === 'www.supabase.co') return false;
    return host.length > 0 && SUPABASE_ANON_KEY.length > 0;
  } catch {
    return false;
  }
}

function buildRestEndpoint(query = ''): string {
  return `${SUPABASE_URL}/rest/v1/${SUPABASE_TABLE}${query}`;
}

function buildHeaders(extra?: Record<string, string>): Record<string, string> {
  return {
    apikey: SUPABASE_ANON_KEY,
    Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
    ...(extra || {}),
  };
}

export type CloudFetchResult =
  | { status: 'found'; data: Partial<StoreState>; updatedAt: string }
  | { status: 'empty' }
  | { status: 'error'; reason: string };

interface SupabaseStoreRow {
  id: string;
  data: Partial<StoreState> | null;
  updated_at?: string;
}

export async function fetchCloudStore(): Promise<CloudFetchResult> {
  if (!hasValidSupabaseEndpoint()) {
    return { status: 'error', reason: 'missing_project_subdomain' };
  }

  try {
    const response = await fetch(
      buildRestEndpoint(
        `?id=eq.${encodeURIComponent(SUPABASE_ROW_ID)}&select=id,data,updated_at`
      ),
      {
        method: 'GET',
        headers: buildHeaders({
          Accept: 'application/json',
        }),
        cache: 'no-store',
      }
    );

    if (!response.ok) {
      return { status: 'error', reason: `http_${response.status}` };
    }

    const rows = (await response.json()) as SupabaseStoreRow[];
    if (!Array.isArray(rows)) {
      return { status: 'error', reason: 'invalid_payload' };
    }

    if (rows.length === 0) {
      return { status: 'empty' };
    }

    const row = rows[0];
    if (!row?.data || typeof row.data !== 'object') {
      return { status: 'empty' };
    }

    return {
      status: 'found',
      data: row.data,
      updatedAt: row.updated_at || '',
    };
  } catch {
    return { status: 'error', reason: 'network_error' };
  }
}

export async function upsertCloudStore(
  storeData: StoreState
): Promise<{ ok: boolean; reason?: string }> {
  if (!hasValidSupabaseEndpoint()) {
    return { ok: false, reason: 'missing_project_subdomain' };
  }

  try {
    const response = await fetch(buildRestEndpoint(), {
      method: 'POST',
      headers: buildHeaders({
        'Content-Type': 'application/json',
        Prefer: 'resolution=merge-duplicates',
      }),
      body: JSON.stringify({
        id: SUPABASE_ROW_ID,
        data: storeData,
        updated_at: new Date().toISOString(),
      }),
    });

    if (!response.ok) {
      return { ok: false, reason: `http_${response.status}` };
    }

    return { ok: true };
  } catch {
    return { ok: false, reason: 'network_error' };
  }
}
