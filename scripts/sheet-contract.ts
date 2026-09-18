/**
 * 紙面契約 (Sheet Contract) — **モックと実装を機械で突き合わせるための共通の形**。
 *
 * 正本: docs/elith/AI疾病予防報告書_仕様書.md  ※ § 番号は旧版 docs/旧版・ボツ/ai_prevention_report_generation_spec.md §1.3.10
 *
 * 【なぜ要るか】モックを作っても、それが実装に反映されたかを誰も検査していなかった。
 *   結果、パイロット版 v0.1 は**モックと違う紙面**で本番に出た (順序・判定文・選ぶ文が違う)。
 *   さらに旧世代の検体で主軸 B が白紙になったのも、モックとの照合が無かったから
 *   「モックにはカードが 7 枚あるのに実装は 1 枚」に誰も気づけなかった。
 *   → **モックから契約を機械抽出し、実装の表示モデルと突き合わせる。**
 *
 * 【契約に入れるもの / 入れないもの】
 *   入れる = **紙面の中身**: どのカードが / どの見出しで / どの文を / どの順で 出るか。
 *   入れない = **見た目**: 色・余白・角丸・影・フォント。CSS を契約にすると、
 *     デザインの微調整のたびに CI が落ちて誰も直さなくなる (= 契約が死ぬ)。
 *     幅とレイアウトの回帰は `verify-layout.mjs` が実測値で別に見る。
 *
 * 【この形は `ReportVM` の部分集合】新しいブロック種を足したら、ここにも足す。
 *   足し忘れると**そのブロックは契約に入らず素通りする**ので、`KNOWN_KINDS` で検知する。
 */

import type { ReportVM } from '../src/lib/report-model';

export interface ContractBlock {
  kind: 'paragraphs' | 'steps' | 'table' | 'pairs' | 'weeks';
  /** paragraphs: 段落。steps/weeks: `見出し\t本文`。pairs: `見出し\t現状評価\t行動提案`。 */
  items?: string[];
  /** table: `項目\t今回\t基準値\t判定`。 */
  rows?: string[];
}

export interface ContractCard {
  key: string;
  axis: 'a' | 'b';
  title: string;
  blocks: ContractBlock[];
}

export interface SheetContract {
  cards: ContractCard[];
}

const KNOWN_KINDS = new Set(['paragraphs', 'steps', 'table', 'pairs', 'weeks']);

/** 比較用の正規化。**空白だけを潰す。** 文字は 1 文字も変えない (逐語の検査なので)。 */
export function norm(s: string): string {
  return s.replace(/\s+/g, '').trim();
}

// ── ① モック HTML から契約を抽出する ──────────────────────────────
//
// 依存を足さないため (CLAUDE.md「追加依存なし方針」)、DOM パーサは使わず
// タグを素直に走査する。モックは当リポジトリが書いた HTML なので、
// 外部の任意 HTML を相手にする必要がない。

/** タグを剥がして地の文にする。`<br>` は改行でなく空白に落とす (norm で消える)。 */
function textOf(html: string): string {
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

/** `<tag ...>…</tag>` を、入れ子を数えながら取り出す。 */
function blocksOf(html: string, tag: string, filter?: (openTag: string) => boolean): string[] {
  const out: string[] = [];
  const open = new RegExp(`<${tag}(\\s[^>]*)?>`, 'g');
  let m: RegExpExecArray | null;
  while ((m = open.exec(html))) {
    const openTag = m[0];
    if (filter && !filter(openTag)) continue;
    let depth = 1;
    let i = open.lastIndex;
    const scan = new RegExp(`<(/)?${tag}(\\s[^>]*)?>`, 'g');
    scan.lastIndex = i;
    let s: RegExpExecArray | null;
    while (depth > 0 && (s = scan.exec(html))) {
      depth += s[1] ? -1 : 1;
      i = s.index;
    }
    out.push(html.slice(open.lastIndex, i));
    open.lastIndex = i;
  }
  return out;
}

function attr(openTag: string, name: string): string | null {
  const m = new RegExp(`${name}="([^"]*)"`).exec(openTag);
  if (m) return m[1];
  return new RegExp(`${name}(?=[\\s>])`).test(openTag) ? '' : null;
}

export function contractFromMockHtml(html: string): SheetContract {
  const cards: ContractCard[] = [];
  const openRe = /<div\s[^>]*>/g;
  let m: RegExpExecArray | null;
  while ((m = openRe.exec(html))) {
    const openTag = m[0];
    const key = attr(openTag, 'data-card');
    // `data-note` の注釈カード・素の div は契約に入れない。
    if (key === null) continue;
    // 対応する閉じ div まで取る。
    let depth = 1;
    let end = openRe.lastIndex;
    const scan = /<(\/)?div(\s[^>]*)?>/g;
    scan.lastIndex = end;
    let s: RegExpExecArray | null;
    while (depth > 0 && (s = scan.exec(html))) {
      depth += s[1] ? -1 : 1;
      end = s.index;
    }
    const body = html.slice(openRe.lastIndex, end);
    openRe.lastIndex = end;

    const axis = (attr(openTag, 'data-axis') ?? 'b') as 'a' | 'b';
    const h3 = /<h3[^>]*>([\s\S]*?)<\/h3>/.exec(body);
    // 見出しの中の `<span class="tag …">` はラベルであって見出しではない。
    const title = h3 ? textOf(h3[1].replace(/<span class="tag[\s\S]*?<\/span>/g, '')) : '';

    const blocks: ContractBlock[] = [];

    // paragraphs … カード直下の <p>。`.muted` (注釈) は紙面ではないので外す。
    const paras: string[] = [];
    for (const p of body.matchAll(/<p(\s[^>]*)?>([\s\S]*?)<\/p>/g)) {
      if ((p[1] ?? '').includes('muted')) continue;
      const t = textOf(p[2]);
      if (t) paras.push(t);
    }
    if (paras.length) blocks.push({ kind: 'paragraphs', items: paras });

    // steps … <ol class="steps"> の各 <li>。先頭の <b> が見出し。
    const ol = /<ol class="steps"[^>]*>([\s\S]*?)<\/ol>/.exec(body);
    if (ol) {
      const items: string[] = [];
      for (const li of ol[1].matchAll(/<li[^>]*>([\s\S]*?)<\/li>/g)) {
        const b = /<b>([\s\S]*?)<\/b>/.exec(li[1]);
        const head = b ? textOf(b[1]) : '';
        const rest = textOf(li[1].replace(/<b>[\s\S]*?<\/b>/, ''));
        items.push(`${head}\t${rest}`);
      }
      if (items.length) blocks.push({ kind: 'steps', items });
    }

    // table … <tbody> の各行。
    const tb = /<tbody>([\s\S]*?)<\/tbody>/.exec(body);
    if (tb) {
      const rows: string[] = [];
      for (const tr of tb[1].matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)) {
        const tds = [...tr[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((t) => textOf(t[1]));
        rows.push(tds.join('\t'));
      }
      if (rows.length) blocks.push({ kind: 'table', rows });
    }

    // pairs … <div class="lsit"> の h4 + 現状評価 + 行動提案。
    const pairs: string[] = [];
    for (const it of blocksOf(body, 'div', (t) => t.includes('class="lsit"'))) {
      const h4 = /<h4[^>]*>([\s\S]*?)<\/h4>/.exec(it);
      const rows = [...it.matchAll(/<div class="lsrow">([\s\S]*?)<\/div>\s*(?=<div class="lsrow">|$)/g)];
      const vals = [...it.matchAll(/<span class="k">[\s\S]*?<\/span><span>([\s\S]*?)<\/span>/g)]
        .map((r) => textOf(r[1]));
      void rows;
      if (h4 && vals.length >= 2) pairs.push(`${textOf(h4[1])}\t${vals[0]}\t${vals[1]}`);
    }
    if (pairs.length) blocks.push({ kind: 'pairs', items: pairs });

    // weeks … <div class="wk"> の <b> と <span>。
    const weeks: string[] = [];
    for (const w of body.matchAll(/<div class="wk">\s*<b>([\s\S]*?)<\/b>\s*<span>([\s\S]*?)<\/span>/g)) {
      weeks.push(`${textOf(w[1])}\t${textOf(w[2])}`);
    }
    if (weeks.length) blocks.push({ kind: 'weeks', items: weeks });

    cards.push({ key, axis, title, blocks });
  }
  return { cards };
}

// ── ② 実装の表示モデルから、同じ形の契約を作る ─────────────────────

export function contractFromVM(vm: ReportVM): SheetContract {
  return {
    cards: vm.digest.map((c) => ({
      key: c.key,
      axis: c.axis,
      title: c.title,
      blocks: c.blocks.map((b): ContractBlock => {
        if (!KNOWN_KINDS.has(b.kind)) {
          throw new Error(`未知のブロック種 "${b.kind}" — sheet-contract.ts に追加すること`);
        }
        switch (b.kind) {
          case 'paragraphs':
            return { kind: 'paragraphs', items: [...b.items] };
          case 'steps':
          case 'weeks':
            return { kind: b.kind, items: b.items.map((i) => `${i.heading}\t${i.text}`) };
          case 'pairs':
            return { kind: 'pairs', items: b.items.map((p) => `${p.heading}\t${p.current}\t${p.action}`) };
          case 'table':
            return {
              kind: 'table',
              rows: b.rows.map((r) => [r.name, r.value].join('\t')),  // 基準値・判定の欄は 2026-09-18 に廃止
            };
        }
      }),
    })),
  };
}

// ── ③ 差分 ────────────────────────────────────────────────────

export interface Diff { where: string; mock: string; impl: string }

/** モック (期待) と 実装 (実際) の差分を、**紙面の言葉で**列挙する。 */
export function diffContract(mock: SheetContract, impl: SheetContract): Diff[] {
  const out: Diff[] = [];
  const mKeys = mock.cards.map((c) => c.key);
  const iKeys = impl.cards.map((c) => c.key);
  if (mKeys.join(',') !== iKeys.join(',')) {
    out.push({ where: 'カードの並び', mock: mKeys.join(' → '), impl: iKeys.join(' → ') });
  }

  for (const mc of mock.cards) {
    const ic = impl.cards.find((c) => c.key === mc.key);
    if (!ic) { out.push({ where: `${mc.key}`, mock: '出る', impl: '**出ない**' }); continue; }
    if (mc.axis !== ic.axis) out.push({ where: `${mc.key} の軸`, mock: mc.axis, impl: ic.axis });
    if (norm(mc.title) !== norm(ic.title)) {
      out.push({ where: `${mc.key} の見出し`, mock: mc.title, impl: ic.title });
    }
    const mKinds = mc.blocks.map((b) => b.kind).join(',');
    const iKinds = ic.blocks.map((b) => b.kind).join(',');
    if (mKinds !== iKinds) {
      out.push({ where: `${mc.key} のブロック構成`, mock: mKinds, impl: iKinds });
      continue;
    }
    mc.blocks.forEach((mb, n) => {
      const ib = ic.blocks[n];
      const ml = mb.items ?? mb.rows ?? [];
      const il = ib.items ?? ib.rows ?? [];
      const len = Math.max(ml.length, il.length);
      for (let i = 0; i < len; i++) {
        const a = ml[i] ?? '(無し)';
        const b = il[i] ?? '(無し)';
        if (norm(a) !== norm(b)) {
          out.push({ where: `${mc.key} / ${mb.kind}[${i}]`, mock: a, impl: b });
        }
      }
    });
  }

  for (const ic of impl.cards) {
    if (!mock.cards.some((c) => c.key === ic.key)) {
      out.push({ where: `${ic.key}`, mock: '**モックに無い**', impl: '出る' });
    }
  }
  return out;
}
