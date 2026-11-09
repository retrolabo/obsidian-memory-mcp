---
entityType: system
tags:
  - system
  - agent-policy
---

# エージェント共通のメモリ運用

<!--
このファイルの扱い（編集する人・エージェント向け）
- 正本はこのファイル。Claude Code と Antigravity の両方に、セッション開始時の hook
  （~/.claude/hooks/obsidian-rules-index.mjs）が中身をそのまま注入する。
- ここに書いてよいのは「どのエージェントでも同じに当てはまる obsidian-memory の使い方」だけ。
  - 書かない: 特定エージェントの機能名（auto-memory、Skill、サブエージェント、settings.json など）、
    特定エージェントの設定ファイルの話、モデル固有の癖。
  - それらは各エージェント側に置く: Claude Code → ~/.claude/CLAUDE.md、Antigravity → agy 側のルール。
- 迷ったら「もう片方のエージェントが読んでも正しく実行できるか」で判断する。
- 内容のルール（ユーザーの指示・フィードバック）はここではなく 10_Rules のノートにする。
  ここは「メモリをどう読み書きするか」の手順だけ。
-->

長く残す情報は obsidian-memory MCP に保存する。各エージェントの組み込みメモリ機能より優先する。

## 読む
- セッション開始時に、この運用と `10_Rules` の一覧が注入される。作業に関係するルールは `open_nodes` で全文を読んでから従う。
- プロジェクトの作業に入るとき（再開・引き継ぎを含む）は、まず `list_nodes(project: "<p>")` で一覧を取り、`20_Projects/<p>/state/`（現在地・TODO・再開位置）を `open_nodes` で読む。必要に応じて `decisions/` も読む。
- 調べ物や詰まったときは `search_nodes` で `30_Knowledge`（tips / antipatterns / reference）を探す。`90_Archive` と `status: superseded` は既定では参照しない。

## 書く
- 置き場所は `entityType` と `project` で自動的に決まる。フォルダは原則指定しない。
  - ユーザーからの指示・フィードバック → `entityType: rule`（project 固有なら project も付ける）
  - 進捗・現在地・TODO → `state`（既存の state ノートに `add_observations` で追記・更新する。新規乱立させない）
  - 方針・設計の決定 → `decision`。覆ったら旧ノートを `update_entities` で `status: superseded` にし、新ノートからリンクする
  - 知見 → `tip` / `antipattern` / `reference`。**プロジェクト名を外しても意味が通るなら project を付けない**（`30_Knowledge` に入る）
- ノート名は主張・結論そのものにする（例:「skip を緑と数えない」）。vault 全体で一意。
- 書く前に `search_nodes` で既存ノートを探し、あれば追記する。
- `00_Inbox` に入ったものは、分かった時点で `update_entities` で正しい type / project に直す。
- 別のエージェントが同じ vault を並行して読み書きしている前提で、他人のノートを消したり全面的に書き換えたりしない（追記・status 変更で表現する）。

## セッション終了時
- まとまった作業の区切りで `create_session`（`project` を指定）を作る。
- セッションの決定・知見のうち長く効くものは、セッションノートだけに残さず rule / decision / tip などのノートへ抜き出し、該当プロジェクトの state を更新する。
