# 永続メモリ（Claude Code 固有）

obsidian-memory の共通運用（読み方・書き方・セッション終了時の手順）は、SessionStart hook がセッション開始時に注入する。
正本は vault の `_system/agent-memory-policy.md` で、Antigravity と共有している。

- Claude Code の auto-memory（`~/.claude/projects/*/memory/`）には書かない。長く残す情報はすべて obsidian-memory MCP に保存する。
- サブエージェントには SessionStart の注入が届かない。メモリの読み書きが必要な作業を任せるときは、関係するルールや state をプロンプトに含めて渡す。

## このファイルと共通運用の分け方
- 両方のエージェントに当てはまるメモリ運用 → `_system/agent-memory-policy.md` を編集する（ここには書かない）。
- Claude Code にしかない機能や設定に関わること（auto-memory、hooks、サブエージェント、Skill、settings.json など）→ このファイルに書く。
- ユーザーの指示・フィードバックそのもの → obsidian-memory の `rule` ノート（`10_Rules`）にする。
