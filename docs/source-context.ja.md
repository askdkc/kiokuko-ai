# ripwireによるソース事前調査

任意導入のripwire 0.4.0で定義・呼び出し関係・テスト候補を絞ります。
結果は調査資料です。「影響なし」「検証済み」の判定には使いません。
Ennoの自動利用は受入評価を通過するまで無効で、明示呼び出しは利用できます。

```bash
kiokuko-ai source setup
kiokuko-ai source status
kiokuko-ai source inspect --task "モデル選択失敗時の処理を調査" --query "readExecutionRouting" --json
kiokuko-ai source configure --mode off
kiokuko-ai source configure --mode auto --binary /absolute/path/to/ripwire
kiokuko-ai source configure --managed
```

ダウンロードは`source setup`だけが行います。macOS/Linuxのarm64/x64用バイナリと
ライセンスをSHA-256検証後に配置します。上流Skill、他エージェント設定、シェル設定、
repository bindingは変更しません。PATH自動検出、自動更新、ソースビルドも行いません。
配置はatomicで、失敗時は既存導入を保持します。強制終了で`source-context/setup.lock`
が残った場合は、setupが動いていないことを確認して空ディレクトリを除き、再実行します。

設定はKiokukoデータディレクトリ配下の`source-context/config.json`です。
`KIOKUKO_DATA_DIR`も使えます。項目は`mode`（auto/off）、任意の絶対パス`binaryPath`、
`timeoutMs`（100〜10000、既定10000）、`maxTokens`（256〜8000、既定4000）、
`maxOutputBytes`（1024〜32768、既定32768）。未知のキーは拒否します。
`auto`は導入を許可せず、受入ゲートも解除しません。doctorはDBと別に状態を表示します。
`inspect`の終了コードは利用不能時2、部分的でも利用できる場合0です。

## 共通APIとEnno

MCPの`source_context({cwd, task, query?, maxTokens?})`はCLIと共通のサービスを使い、
メモリDBを開きません。`cwd`はGit repository内の絶対パスです。原文を入力digestへ保持し、
`query`で検索表現を変更できます。日本語や抽象的な依頼で不足したら識別子で補います。
翻訳用モデルは起動しません。

結果には相対パス・限定本文・関連シンボル・テスト候補・省略情報・digest・時間・取得量を含めます。
テストコマンドは非信頼の候補であり自動実行しません。生stderrは返さず、未知の出力形式は拒否します。
空のテスト一覧や欠落した関係を検証済みと解釈しません。
対象パスがない呼び出し先は`unresolvedCallees`へ名前とsignatureだけを返し、確定した所在として扱いません。

受入後の自動経路はideal／Zenkiの委譲直前だけに結果を追加し、追加後のプロンプトでdigestを計算します。
調査後にもモデルと実行状態を再確認します。同じ入力・対象内容だけを親のメモリ内で再利用し、
compaction／セッション削除時に破棄します。通常作業は明示呼び出しです。
初期版では固定advisorへ共有せず、既存allowlistとdigestを維持します。SQLiteへ本文を保存しません。

## 制限

- Gitが選ぶ通常ソースを非公開の一時ディレクトリへコピーして解析します。未コミット・未追跡ファイルとテストも対象です。
  symlink、submodule、特殊ファイル、非公開ツール用ディレクトリ、`.env*`、秘密情報らしい内容、
  2 MiB超のファイル、非対応拡張子は除外して明示します。
- 元repositoryとGit設定をパーサーへ渡しません。コピーはfile symlinkを追わず親パスも確認します。
  ただし、別プロセスによる親ディレクトリの悪意ある差し替えまで保証するOS sandboxではありません。
- コピーと前後の対象確認も時間予算へ含め、対象変更時は結果を破棄します。Git履歴・ripwire notes・
  文書変換は使いません。固定版JSONには完全な解析健全性と辺の確度がないため、成功時も`degraded`です。
- 索引はrepository外の`source-context/cache`に保存します。ソース内容を含み得るため非公開に保ちます。
  空き容量が必要なら調査の停止中に古いblobを削除できます。一時コピーは終了時に削除します。
- stdoutは256 KiB、stderrは16 KiB、返却JSONは32 KiBを上限とし、本文・行の省略を明示します。
  キャンセルは子プロセス群へ伝播します。未導入・時間超過は通常調査へ戻れます。
  パス・権限違反は調査操作を拒否し、勝手に探索を広げません。

## 検証と評価

```bash
KIOKUKO_TEST_RIPWIRE=/absolute/path/to/ripwire npm run test:source
npm run build
KIOKUKO_TEST_RIPWIRE=/absolute/path/to/ripwire node scripts/evaluate-source-context.mjs /tmp/source-evaluation.json
```

英日各6件、6サブシステムを固定課題にします。正解は採点だけに使います。
両方式は同じ検索語と先頭8件の一致ファイルを使い、ripwire側は関連定義が未取得のファイルを補完します。
取得結果と追加読解を同じjs-tiktoken 1.0.21/cl100k_baseで計数し、コピー・状態確認も時間へ算入します。
通常方式を先に測りOSキャッシュは消去しません。固定手順の所在特定比較であり、AIの完遂率の実証ではありません。

自動利用には発見率維持、トークン中央値30%以上削減、warm時間中央値の非悪化、誤った検証済み判定ゼロを要求します。
通過した実測結果をレビューしてから`SOURCE_AUTO_ACCEPTED`を変更します。設定だけでは有効化できません。

2026-09-08のmacOS arm64での[評価記録](source-context-evaluation.json)は不合格です。
補完後の発見率は維持し、総取得tokensの中央値は約40.0%減少しましたが、warm時間中央値は
通常10.5msに対して併用408.6msでした。したがって明示呼び出しだけを提供します。
削減率は両方式のtokens中央値の比で算出し、課題ごとの比の中央値も別項目に記録しています。
記録はレポート自身を追加する前のソースdigestに紐づき、この1台の測定を他環境へ一般化しません。

追加の[親内再利用の実測と実LLM比較手順](source-context-followup.ja.md)では、
ローカル取得時間、モデルへの入力tokens、計画品質を分けて扱います。

上流：[固定版](https://github.com/redhat-et/ripwire/releases/tag/v0.4.0)、
[CLI仕様](https://github.com/redhat-et/ripwire/blob/v0.4.0/docs/COMMANDS.md)。
