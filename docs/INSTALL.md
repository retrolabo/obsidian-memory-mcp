# インストール手順書（macOS / Windows）

obsidian-memory MCP を、Claude Code と Antigravity の両方から使うための手順です。
2台目の PC（Windows を含む）でも、この手順をそのままなぞれば同じ環境になります。

## 全体像

| 置くもの | 場所 | PC ごとに必要か |
|---|---|---|
| MCP サーバー（このリポジトリ） | 任意（例: `~/mcp-servers/obsidian-memory-mcp`） | 必要（clone + build） |
| Obsidian vault | Google Drive などで同期するフォルダ | 不要（同期される） |
| 共通メモリ運用 `_system/agent-memory-policy.md` | vault の中 | 不要（同期される。最初の1回だけ置く） |
| Claude Code の MCP 登録・hook・`CLAUDE.md` | `~/.claude.json` / `~/.claude/settings.json` / `~/.claude/CLAUDE.md` | 必要 |
| Antigravity の MCP 登録・hook | `~/.gemini/config/mcp_config.json` / `~/.gemini/config/hooks.json` | 必要 |

以下では、例として次のパスを使います。自分の環境に合わせて読み替えてください。

| | macOS | Windows |
|---|---|---|
| リポジトリ | `/Users/me/mcp-servers/obsidian-memory-mcp` | `C:/Users/me/mcp-servers/obsidian-memory-mcp` |
| vault | `/Users/me/Google Drive/マイドライブ/Obsidian/Memory` | `G:/マイドライブ/Obsidian/Memory` |
| node | `/usr/local/bin/node`（`which node` の結果） | `C:/Program Files/nodejs/node.exe`（`where node` の結果） |
| ホーム | `~` | `%USERPROFILE%`（例: `C:\Users\me`） |

> **Windows のパスは `/` 区切りで書くのがおすすめです。** Node は `C:/Users/...` をそのまま扱えます。
> JSON に `\` で書く場合は `C:\\Users\\...` のように二重にする必要があり、間違えやすくなります。

---

## 1. 前提

- Node.js 20 以上と git
- Obsidian（vault を見るため。MCP の動作自体には不要）
- vault の同期手段（Google Drive for desktop など）

**Windows の追加の準備**

- **長いパスを有効にする。** ノート名が長く、Windows 標準の 260 文字制限に近づくことがあります。管理者の PowerShell で次を実行して再起動します。
  ```powershell
  New-ItemProperty -Path "HKLM:\SYSTEM\CurrentControlSet\Control\FileSystem" -Name LongPathsEnabled -Value 1 -PropertyType DWORD -Force
  git config --global core.longpaths true
  ```
- **Google Drive は「ミラーリング」にするか、vault フォルダを「オフラインで使用可能」にする。** ストリーミングのままだと、MCP がノートを読むたびにダウンロードが走って遅くなります。
- ノート名に `< > : " / \ | ? *` は使えません。MCP が作るノートでは自動で `_` に置き換わりますが、Mac で手作業で作ったノートに含まれていると、Windows 側で同期できません。

## 2. MCP サーバーを入れる

macOS / Linux:

```bash
mkdir -p ~/mcp-servers && cd ~/mcp-servers
git clone https://github.com/retrolabo/obsidian-memory-mcp.git
cd obsidian-memory-mcp
npm install        # prepare スクリプトでビルドまで行われる
npm test           # 仮の vault で一通り動作確認（全項目 ok なら成功）
```

Windows（PowerShell）:

```powershell
mkdir $HOME\mcp-servers -Force; cd $HOME\mcp-servers
git clone https://github.com/retrolabo/obsidian-memory-mcp.git
cd obsidian-memory-mcp
npm install
npm test
```

## 3. vault を用意する

- **すでに vault がある（2台目の PC）** → 同期が終わるのを待つだけです。ここは飛ばして 4 へ進みます。
- **新しく作る** → 空のフォルダを作り、Obsidian で「フォルダを vault として開く」。フォルダ構成は、MCP がノートを作るときに自動で作られます。
- **旧版（フラット構成）の vault を使っている** → 移行します。

  ```bash
  MEMORY_DIR="/path/to/vault" npm run migrate              # ドライラン（移動予定の一覧が出るだけ）
  MEMORY_DIR="/path/to/vault" npm run migrate -- --apply   # 実行。_system/migrations/ に戻し用ログが残る
  ```
  PowerShell では `$env:MEMORY_DIR="G:/マイドライブ/Obsidian/Memory"; npm run migrate` のように書きます。

**共通メモリ運用を置く（vault ごとに最初の1回だけ）:**

```bash
mkdir -p "/path/to/vault/_system"
cp templates/agent-memory-policy.md "/path/to/vault/_system/agent-memory-policy.md"
```

以後は vault の中のこのファイルが正本です。リポジトリの `templates/` はひな形にすぎません。

## 4. Claude Code の設定

### 4-1. MCP を登録する

コマンドで登録する場合（ユーザー全体に効く `-s user`）:

```bash
# macOS
claude mcp add obsidian-memory -s user \
  -e MEMORY_DIR="/Users/me/Google Drive/マイドライブ/Obsidian/Memory" \
  -- node /Users/me/mcp-servers/obsidian-memory-mcp/dist/index.js
```

```powershell
# Windows
claude mcp add obsidian-memory -s user `
  -e MEMORY_DIR="G:/マイドライブ/Obsidian/Memory" `
  -- node C:/Users/me/mcp-servers/obsidian-memory-mcp/dist/index.js
```

`~/.claude.json` に直接書く場合の記述例（`mcpServers` に追加する）:

```json
{
  "mcpServers": {
    "obsidian-memory": {
      "type": "stdio",
      "command": "node",
      "args": ["C:/Users/me/mcp-servers/obsidian-memory-mcp/dist/index.js"],
      "env": { "MEMORY_DIR": "G:/マイドライブ/Obsidian/Memory" }
    }
  }
}
```

> fnm / nvm / volta で Node を入れている場合、Claude Code から `node` が見つからないことがあります。
> そのときは `command` に node の絶対パス（`which node` / `where node` の結果）を書きます。

### 4-2. SessionStart hook を登録する

`~/.claude/settings.json` の `hooks` に追加します（すでにある設定は消さずに足すこと）。
`args` 形式はシェルを通さずに実行されるので、macOS と Windows で同じ書き方になります。

macOS:

```json
{
  "hooks": {
    "SessionStart": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "/usr/local/bin/node",
            "args": [
              "/Users/me/mcp-servers/obsidian-memory-mcp/integrations/obsidian-rules-index.mjs",
              "--vault", "/Users/me/Google Drive/マイドライブ/Obsidian/Memory"
            ],
            "timeout": 15
          }
        ]
      }
    ]
  }
}
```

Windows:

```json
{
  "hooks": {
    "SessionStart": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "C:/Program Files/nodejs/node.exe",
            "args": [
              "C:/Users/me/mcp-servers/obsidian-memory-mcp/integrations/obsidian-rules-index.mjs",
              "--vault", "G:/マイドライブ/Obsidian/Memory"
            ],
            "timeout": 15
          }
        ]
      }
    ]
  }
}
```

### 4-3. CLAUDE.md を置く

```bash
cp templates/CLAUDE.md ~/.claude/CLAUDE.md          # macOS（既存がある場合は中身をマージする）
```
```powershell
Copy-Item templates\CLAUDE.md $HOME\.claude\CLAUDE.md   # Windows
```

ここには Claude Code 固有の指示だけを書きます。両方のエージェントに効かせたい運用は、vault の `_system/agent-memory-policy.md` に書きます。

## 5. Antigravity の設定

### 5-1. MCP を登録する

`~/.gemini/config/mcp_config.json`（Windows: `%USERPROFILE%\.gemini\config\mcp_config.json`）の `mcpServers` に追加します。

```json
{
  "mcpServers": {
    "obsidian-memory": {
      "command": "node",
      "args": ["C:/Users/me/mcp-servers/obsidian-memory-mcp/dist/index.js"],
      "env": { "MEMORY_DIR": "G:/マイドライブ/Obsidian/Memory" }
    }
  }
}
```

**Claude Code と同じリポジトリの `dist/index.js` を指定してください。** 別の clone を指すと、片方だけ古い版で動いてしまいます。

### 5-2. SessionStart hook を登録する

`~/.gemini/config/hooks.json`。`--agy` を付けると、Antigravity 用の JSON 形式（`injectSteps`）で出力されます。
パスを `"` で囲んだこの書き方は、bash / zsh / PowerShell / cmd のどれでも同じように動きます。

macOS:

```json
{
  "obsidian-rules-index": {
    "SessionStart": [
      {
        "type": "command",
        "command": "\"/usr/local/bin/node\" \"/Users/me/mcp-servers/obsidian-memory-mcp/integrations/obsidian-rules-index.mjs\" --agy --vault \"/Users/me/Google Drive/マイドライブ/Obsidian/Memory\"",
        "timeout": 15
      }
    ]
  }
}
```

Windows:

```json
{
  "obsidian-rules-index": {
    "SessionStart": [
      {
        "type": "command",
        "command": "\"C:/Program Files/nodejs/node.exe\" \"C:/Users/me/mcp-servers/obsidian-memory-mcp/integrations/obsidian-rules-index.mjs\" --agy --vault \"G:/マイドライブ/Obsidian/Memory\"",
        "timeout": 15
      }
    ]
  }
}
```

Antigravity 固有の指示は Antigravity 自身のルールファイルに置き、`CLAUDE.md` や共通運用には入れません。

## 6. 動作確認

1. **hook を手で実行する。** 共通運用とルール一覧が出力されれば成功です。
   ```bash
   node integrations/obsidian-rules-index.mjs --vault "/path/to/vault"
   node integrations/obsidian-rules-index.mjs --agy --vault "/path/to/vault"   # JSON が出る
   ```
   何も出ない（`--agy` では `{}` だけ出る）場合は、vault のパスが間違っているか、まだ同期されていません。
2. **エージェントを再起動する**（Claude Code / Antigravity とも、MCP と hook は起動時に読み込まれる）。
3. 起動直後のコンテキストに「エージェント共通のメモリ運用」と「行動ルール一覧」が入っていることを確認します（例:「注入されたルール一覧を見せて」と頼む）。
4. MCP を確認します。Claude Code なら `/mcp` で obsidian-memory が connected になっていること。どちらのエージェントでも、`list_nodes` に `folder: "10_Rules"` を渡して呼び、ルールが返ってくれば OK です。

## 7. 更新するとき

```bash
cd ~/mcp-servers/obsidian-memory-mcp
git pull
npm install        # ビルドも行われる
npm test
```

更新後は、両方のエージェントを再起動します。

## 7-1. 旧 clone から移行したとき

別の場所（例: `~/.mcp-servers/obsidian-memory-mcp`）に旧 clone が残っている場合は、次の順で片付けます。

1. 両エージェントの MCP 登録（5-1 など）の `args` を、新しいリポジトリの `dist/index.js` に書き換える。
2. エージェントを再起動し、6-4 の `list_nodes`（`folder: "10_Rules"`）でルールが返ることを確認する。
3. どの設定からも旧 clone が参照されていないことを確認してから、旧 clone を削除する。

## 8. 複数の PC で使うときの注意

- vault は同期されますが、**同じノートを2台で同時に書き換えると、同期ツールが「〜 (1).md」のような重複ファイルを作ることがあります。** サーバーは同じ名前のノートが複数あると、先に見つかった方を使い、ログに警告を出します。重複ファイルを見つけたら、手で統合してください。
- MCP サーバーのバージョンは PC ごとにそろえます（両方で `git pull`）。

## 9. うまく動かないとき

| 症状 | 確認すること |
|---|---|
| ルール一覧が注入されない | 6-1 の手動実行で出力が出るか。`settings.json` / `hooks.json` の JSON が正しいか（壊れていると、そのファイルの設定が丸ごと無視される） |
| MCP から vault が空に見える | `MEMORY_DIR` のパス。エージェントが別の clone の古い `dist/index.js` を指していないか |
| Windows で `node` が見つからない | `command` を node.exe の絶対パスにする |
| Windows で一部のノートが同期されない | ノート名に `< > : " / \ | ? *` が含まれていないか。パスが長すぎないか（1 の長いパス設定） |
| `Unknown tool: list_nodes` が出る | MCP が改修版に繋がっていない。起動中のプロセス（`ps aux \| grep obsidian-memory`）と、`~/.claude.json` / `~/.gemini/config/mcp_config.json` の `args` が、このリポジトリの `dist/index.js` を指しているか確認する。直したらエージェントを再起動 |
| 新しいノートが `00_Inbox` に入る | `entityType` に対して `project` が必要な種類（state / decision など）なのに `project` が無い。`update_entities` で直す |
