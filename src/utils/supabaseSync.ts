import { StoreState } from '../types/store';

const SUPABASE_URL = 'https://yzjelmroikleduddentc.supabase.co';
const SUPABASE_ANON_KEY =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inl6amVsbXJvaWtsZWR1ZGRlbnRjIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTU3ODk5NjAsImV4cCI6MjExMTM2NTk2MH0.g82yYkBMIqosqI_JkGlU4zPMkD3dh72rOBCWUFRIqkk';
const SUPABASE_TABLE = 'bthtech_store';
const SUPABASE_ROW_ID = 'main_store';
const SUPABASE_REST_ENDPOINT = `${SUPABASE_URL}/rest/v1/${SUPABASE_TABLE}`;

const SUPABASE_HEADERS: Record<string, string> = {
  apikey: SUPABASE_ANON_KEY,
  Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
  'Content-Type': 'application/json',
  Prefer: 'resolution=merge-duplicates,return=representation',
};

export type CloudFetchResult =
  | { status: 'found'; data: Partial<StoreState> }
  | { status: 'empty' }
  | { status: 'error'; reason: string };

interface SupabaseStoreRow {
  id?: string;
  data: Partial<StoreState> | null;
}

async function extractSupabaseError(response: Response): Promise<string> {
  try {
    const raw = await response.text();
    if (!raw) return `HTTP ${response.status} ${response.statusText}`.trim();
    try {
      const parsed = JSON.parse(raw) as {
        message?: string;
        details?: string;
        hint?: string;
        error?: string;
      };
      const parts = [parsed.message, parsed.details, parsed.hint, parsed.error].filter(Boolean);
      if (parts.length > 0) {
        return `HTTP ${response.status}: ${parts.join(' — ')}`;
      }
    } catch {
      // Plain text error body
    }
    return `HTTP ${response.status}: ${raw}`;
  } catch {
    return `HTTP ${response.status} ${response.statusText}`.trim();
  }
}

export async function fetchCloudStore(): Promise<CloudFetchResult> {
  try {
    const response = await fetch(
      `${SUPABASE_REST_ENDPOINT}?id=eq.${SUPABASE_ROW_ID}&select=data`,
      {
        method: 'GET',
        headers: SUPABASE_HEADERS,
        cache: 'no-store',
      }
    );

    if (!response.ok) {
      return { status: 'error', reason: await extractSupabaseError(response) };
    }

    const rows = (await response.json()) as SupabaseStoreRow[];
    if (!Array.isArray(rows)) {
      return { status: 'error', reason: 'Resposta inválida do Supabase.' };
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
    };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Erro de rede';
    return { status: 'error', reason: `Falha de conexão com Supabase: ${msg}` };
  }
}

export async function upsertCloudStore(
  storeData: StoreState
): Promise<{ ok: boolean; message?: string; error?: string }> {
  try {
    const response = await fetch(SUPABASE_REST_ENDPOINT, {
      method: 'POST',
      headers: SUPABASE_HEADERS,
      body: JSON.stringify({
        id: SUPABASE_ROW_ID,
        data: storeData,
        updated_at: new Date().toISOString(),
      }),
    });

    if (!response.ok) {
      const detail = await extractSupabaseError(response);
      return { ok: false, error: `Falha ao salvar na nuvem (${detail})` };
    }

    return { ok: true, message: 'Sincronizado na nuvem com sucesso!' };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Erro de rede';
    return { ok: false, error: `Falha de conexão com Supabase: ${msg}` };
  }
}
