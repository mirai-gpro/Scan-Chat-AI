/**
 * `/api/share/end` は **`/share/end` と同じ処理**（仕様書 §33.4 のファイル配置に合わせた別名）。
 * **中身を写さない** — 実体は `src/pages/share/end.ts` の 1 か所だけ（二重管理しない）。
 */
export { POST, prerender } from '../../share/end';
