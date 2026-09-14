// src/pages/api/admin/transcos-emergency/_shared.ts
// トランスコスモス緊急専用 API の共通部。
// **認可は既存の臨時診断 API と同じものを使い回す** (§22「既存 admin auth と同等以上」)。
// 判定を 2 つ書かない — ここは re-export だけ。`_` 始まりなのでルートにならない。
export { json, authorized, actorFrom, readJson, str, num, fail } from '../ad-hoc-diagnosis/_shared';
