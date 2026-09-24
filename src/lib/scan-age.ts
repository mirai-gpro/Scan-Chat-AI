/**
 * スキャン確定 Markdown から「年齢」「性別」を拾う (決定論)。
 *
 * 用途:
 *   - ユーザースキャン保存時 (`scan-persist.saveScanResult`) に `age_at_test` / `sex` を埋める。
 *   - Elith 納品のウェルネス年齢算出 (`elith-delivery`) の年齢フォールバック。
 *
 * 人間ドック/健診は年齢・性別が印字される。表記ゆれ (全角数字・表形式・満N歳・Age: N 等) に
 * できるだけ対応する。**取れないときは null**（捏造しない）。範囲外 (18〜120 外) は採らない。
 */

/** 全角数字 → 半角。 */
function toHalfWidthDigits(s: string): string {
  return s.replace(/[０-９]/g, (d) => String.fromCharCode(d.charCodeAt(0) - 0xfee0));
}

const plausibleAge = (n: number): boolean => Number.isFinite(n) && n >= 18 && n <= 120;

/** 年齢を拾う。複数パターンを順に試し、最初に妥当な値。 */
export function extractAge(markdown: string): number | null {
  const md = toHalfWidthDigits(String(markdown ?? ''));
  const patterns: RegExp[] = [
    /(\d{1,3})\s*[歳才]/, // 54歳 / 満54歳 / 54 才
    /年齢[^\d]{0,8}(\d{1,3})/, // 年齢: 54 / 年齢 | 54 (表セル)
    /\bage\b[^\d]{0,8}(\d{1,3})/i, // Age: 54
    /(\d{1,3})\s*(?:y\.?\s*o\.?|yrs?|Y)\b/i, // 54 y.o. / 54yo / 54Y
  ];
  for (const re of patterns) {
    const m = md.match(re);
    if (m) {
      const n = Number.parseInt(m[1], 10);
      if (plausibleAge(n)) return n;
    }
  }
  return null;
}

/** 性別を拾う (男性/女性・性別: 男/女・N歳男/女)。曖昧な単独 M/F は採らない (誤検出防止)。 */
export function extractSex(markdown: string): 'male' | 'female' | null {
  const md = String(markdown ?? '');
  if (/女性|性別\s*[:：|｜]*\s*女|[歳才]\s*女/.test(md)) return 'female';
  if (/男性|性別\s*[:：|｜]*\s*男|[歳才]\s*男/.test(md)) return 'male';
  return null;
}

export function extractAgeSex(markdown: string): { age: number | null; sex: 'male' | 'female' | null } {
  return { age: extractAge(markdown), sex: extractSex(markdown) };
}
