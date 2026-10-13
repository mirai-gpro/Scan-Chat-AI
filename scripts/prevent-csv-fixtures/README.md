# プリベント問診CSV の fixture

**ここに在るのは「先方確定の様式」ではありません。**

`expected_704000111.csv` は、現在の `src/lib/prevent-questionnaire-csv.ts`
（`PREVENT_CSV_FORMAT_STATUS = 'unconfirmed'`）が出力する**暫定様式**の写しです。

## なぜ置くのか

様式が動いたら **PR の差分に出る**ようにするため。`verify:prevent-questionnaire` が
`buildPreventQuestionnaireCsv()` の出力とこのファイルを**1 バイト単位**で突き合わせます。
列を増やす／ヘッダを変える／改行や BOM を変える、のどれをやっても検査が落ちるので、
「気づかないうちに様式が変わっていた」が起きません。

## 作り直し方

**手で編集しないこと。** 実装を直したら、実装から書き出し直します。

```
node -e "
const ts=require('typescript');const fs=require('fs');
const js=ts.transpileModule(fs.readFileSync('src/lib/prevent-questionnaire-csv.ts','utf8'),
  {compilerOptions:{target:'ES2022',module:'CommonJS'}}).outputText;
const m={};const mod={exports:m};new Function('module','exports',js)(mod,m);
fs.writeFileSync('scripts/prevent-csv-fixtures/expected_704000111.csv',
  mod.exports.buildPreventQuestionnaireCsv({
    barcodeNo:'704000111',
    subject:{dateOfBirth:'1975-04-15',sex:'male'},
    answers:[{id:'B-HEIGHT',answer_label:'171.2'},{id:'B-WEIGHT',answer_label:'68.4'},
             {id:'S-STATUS',answer_label:'吸わない'},{id:'D-FREQ',answer_label:'週2〜3日飲む'}],
  }).csv);
"
```

## 先方提供 Excel を受領したら

1. 「ウェルフォート様_問診・アンケートデータ_例_問診1回.xlsx」の**ヘッダ行数・列順・
   列名・選択肢コード・文字コード・改行**に `PREVENT_CSV_COLUMNS` を合わせる。
2. `PREVENT_CSV_FORMAT_STATUS` を `'confirmed'` にする。
3. この fixture を**書き出し直す**（差分で何が変わったか分かる）。
4. そのうえで app_config `labid.prevent_csv_release` を on にする。

**番号（`704000111`）は架空値です。** 実物の外部検査IDをここへ入れないこと
（画面でも末尾 4 桁しか出さない値）。
