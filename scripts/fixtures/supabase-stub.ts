/**
 * `diagnosis-cycle.ts` が使う Supabase クライアントの差し替え（fixture 専用）。
 * bridge の `diagnosis_cycle_status` と diagnosis スキーマの `cycle_links` だけを模す。
 * **本番コードからは参照されない。**
 */

type Row = Record<string, unknown>;

let cycles: Row[] = [];
let bridgeAvailable = true;
let linkFails = false;
let inserted: Row[] = [];

export function __setCycles(rows: Row[]): void { cycles = rows; }
export function __setBridgeAvailable(v: boolean): void { bridgeAvailable = v; }
export function __setLinkFails(v: boolean): void { linkFails = v; }
export function __inserted(): Row[] { return inserted; }
export function __reset(): void { cycles = []; bridgeAvailable = true; linkFails = false; inserted = []; }

/** `.select().eq().eq()...` を積んで最後に await されるチェーン。 */
function selectChain(rows: Row[]) {
  const filters: [string, unknown][] = [];
  const api: Record<string, unknown> = {
    select: () => api,
    eq: (col: string, v: unknown) => { filters.push([col, v]); return api; },
    in: () => api,
    not: () => api,
    limit: () => api,
    then: (resolve: (r: { data: Row[] | null; error: null }) => unknown) => {
      let out = rows;
      for (const [col, v] of filters) {
        // status は呼び出し側が 'open' で絞る。stub のデータは既に open のみを渡す想定。
        out = out.filter((r) => (r as Record<string, unknown>)[col] === undefined || r[col] === v);
      }
      return resolve({ data: out, error: null });
    },
  };
  return api;
}

export function getBridgeSupabase(): unknown {
  if (!bridgeAvailable) return null;
  return {
    from: (table: string) => (table === 'diagnosis_cycle_status' ? selectChain(cycles) : selectChain([])),
  };
}

export function getServerSupabase(): unknown {
  return {
    schema: () => ({
      from: () => ({
        upsert: async (row: Row) => {
          if (linkFails) return { error: { message: 'stub: upsert failed' } };
          inserted.push(row);
          return { error: null };
        },
        select: () => selectChain([]),
      }),
    }),
  };
}

export type BridgeOrigin = 'production' | 'staging';
