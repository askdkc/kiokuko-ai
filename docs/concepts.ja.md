# 基本概念

## RAGと記憶のライフサイクル

KiokukoはRAG（retrieval-augmented generation）を使います。作業前にMCP serverが保存済みentryを検索し、関係する文脈だけを渡します。
作業後は決定、結果、教訓をcheckpointできます。記憶は参考情報なので、現在のリポジトリと実行結果が常に優先されます。

entryはcapture、validation、retrieval、review、必要ならpromotionを経ます。secretらしい内容は拒否され、checkpointは正しさの証明ではありません。

## スコープ

- **Project**: 1つのrepository専用。
- **Ecosystem**: 言語、framework、database、runtimeの条件が一致する場合に再利用。
- **Global**: 特定projectに依存しないと明示的に一般化した知識。

tagだけでProject記憶が別projectへ漏れることはありません。Curatorの確認後にGlobalへ昇格できます。

## Akinator

Akinatorはintake gateです。依頼が曖昧なとき、候補を分ける最小の質問をします。回答が必要な間はplan、編集、検証、checkpointを開始しません。
intakeがreadyまたはexhaustedになってから通常ルートへ進み、発見されたSkillは参照専用です。

## Semantic retrieval

基本はlexical検索です。任意のlocal embeddingがsemantic signalを追加します。詳細は[Semantic retrieval](semantic-retrieval.ja.md)を参照してください。
