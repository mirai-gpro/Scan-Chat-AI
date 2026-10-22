# `scripts/barcode-fixtures/`

`npm run verify:external-id-capture` の ⑲ (§12.4 の決定論デコード) が使う画像。

## `codabar_704000123.jpg`

- **合成画像。実物の台紙ではない。** 個人情報も実在の検査IDも含まない。
- 値は **`A704000123A`**（Codabar / NW-7 の start・stop 文字 `A` 付き）。
  `704000123` は仕様書と画面の図で使っているダミーと同じ。
- 作り方: `bwip-js` の `rationalizedCodabar`（`scale:3 / height:12 / includetext`）で
  バーコードを描き、**1500×1125 の白地の中央に幅 600px で置いて** JPEG q92 で保存。
  1500px 幅は `camera-scan.ts` の実際の撮影サイズに合わせたもの
  （`getUserMedia` の `width:{ideal:1500}`）。
- **`bwip-js` はこのリポジトリの依存ではない**（画像を作るときだけ使った）。
  作り直す必要が出たら、同じ設定で生成して差し替える。

## これで何を見ているか

**`src/lib/barcode-decode.ts` が実際に読めること**（sharp → グレースケール →
`@undecaf/zbar-wasm` の `scanGrayBuffer` → `ZBAR_CODABAR` → `A704000123A`）。
ここが壊れると**黙って Gemini だけに戻る**（= 遅いまま）ので、目視では気づけない。
