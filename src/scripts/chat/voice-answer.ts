/**
 * AI問診 — 音声の発話を選択肢へ当てる (2026-09-18・実障害を受けて切り出し)。
 *
 * 【なぜ別ファイルか】ここは**取り違えると誤った回答が医療問診に記録される**場所なのに、
 * コントローラのクロージャの中にあって単体で試せなかった。純粋関数にして検査を書く。
 *
 * 【直した 2 件】
 * ① **「なし」と言っても採用されなかった**。照合が部分一致だけだったため、
 *    発話「なし」と選択肢「ない」が**別物**になっていた (どちらも相手を含まない)。
 *    → 否定の言い方は**同義として扱う**。
 * ② **誤った選択肢が採用され得た** (こちらの方が重い)。喫煙の設問で「ない」と言うと
 *    「過去に吸っていたが現在は吸わない」「吸ったことはない」の両方が部分一致し、
 *    **最長のラベル = 「過去に吸っていた」が採用**されていた。`when` 分岐にも直結する。
 *    → **当てずっぽうで長いラベルへ吸わせない**。決められないときは採用しない。
 *
 * 【方針】**採らないより、誤って採る方が悪い。** 迷ったら `null` を返し、
 * 利用者に画面でタップしてもらう (行き止まりにはならない)。
 */

/** 表記ゆれを吸う。括弧の中・記号・空白を落とす。 */
export function normalizeVoice(s: string): string {
  return s
    .normalize('NFKC')
    .replace(/[（(][^）)]*[）)]/g, '')
    .replace(/[\s　・、。，．,.!！?？「」『』〜~ー\-/]/g, '')
    .toLowerCase();
}

/** 話し言葉の語尾。「特にないよ」「なしです」を「特にない」「なし」として扱うため。 */
const TRAILING = /(?:ですね|ですよ|です|でーす|だよ|だね|だ|かな|かなあ|よね|よ|ね|な|わ)+$/;

/**
 * 「なし」系の言い方。**同じ意味で文字が違うだけ**なので、発話側も選択肢側も同じ物差しで見る。
 * ここに無い言い方は否定と見なさない (勝手に広げない)。
 */
const NEGATIVE = /^(?:とくに|特に)?(?:なし|ない|無し|無い|ないです|ありません|ございません|該当なし|該当するものはない|どれもない|いずれもない)$/;

export interface VoiceOption { label: string }

function core(label: string): string { return normalizeVoice(label); }
function isNegative(s: string): boolean { return NEGATIVE.test(s); }

/**
 * 発話を選択肢の label へ当てる。当てられなければ `null` (回答にしない)。
 *
 * @param isMulti 複数選択なら配列で返す
 */
export function pickVoiceOption(
  options: VoiceOption[],
  transcript: string,
  isMulti: boolean,
): string | string[] | null {
  const t = normalizeVoice(transcript);
  if (!t || options.length === 0) return null;
  /** 語尾を落とした形。①② の判定にだけ使う (③ の部分一致は従来どおり素の t)。 */
  const tt = t.replace(TRAILING, '') || t;
  const pick = (label: string) => (isMulti ? [label] : label);

  // ① 完全一致が最優先。
  //    これが無いと、「なし」と言ったのに部分一致で長いラベルへ吸われる余地が残る。
  const exact = options.filter((o) => core(o.label) === t || core(o.label) === tt);
  if (exact.length === 1) return pick(exact[0].label);

  // ② 否定の言い方は同義。**選択肢側の否定がちょうど 1 つのときだけ**採る。
  if (isNegative(tt)) {
    const negs = options.filter((o) => isNegative(core(o.label)));
    if (negs.length === 1) return pick(negs[0].label);
    /*
     * 0 件 = その設問に「なし」の選択肢が無い (例: 喫煙は 現在/過去/吸ったことはない)。
     * 複数 = どれを指したか分からない。
     * **どちらも部分一致へ落とさない** — 「ない」が「過去に吸っていたが現在は吸わない」に
     * 吸われる事故がこれ (実測)。
     */
    return null;
  }

  // ③ 部分一致 (従来どおり)。「週3回」「はい」等はこれで当たる。
  const matched = options
    .map((o) => ({ label: o.label, core: core(o.label) }))
    .filter((m) => m.core && (t.includes(m.core) || m.core.includes(t)));
  if (matched.length === 0) return null;
  if (isMulti) return matched.map((m) => m.label);
  // 単一: 最も具体的 (核が長い) 候補を採用
  matched.sort((a, b) => b.core.length - a.core.length);
  return matched[0].label;
}
