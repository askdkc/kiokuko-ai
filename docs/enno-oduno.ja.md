# 役小角(enno-oduno)

![役小角(enno-oduno)](../skills/kiokuko-enno-oduno/enno-oduno.png)

build、debug、review、devopsでは、Enno-Odunoがrun-bound loopを管理します。

```text
intake → ideal → plan → 確認 → WorkUnit実行 → 最終検証 → meditation
```

clientを特定し、Akinatorのintakeを解決し、理想の結果を保存してから、revision-bound planをZenkiへ渡します。
Zenkiは変更を責務と理由が1つのWorkUnitへ分割し、Gokiは承認済みunitだけを実行します。unitにはcode/ui/test/docs/operationsのローカルrouteがあります。

確認画面にはscope、除外、完了条件、Skill、expertise、command、timeoutを利用者の言語で表示します。内部IDやraw JSONは表示しません。

plan環境が欠落・変更した場合、discovery、plan保存、実装の前に停止し、continue/review/restart/cancelを選びます。継続は短命のroute-epoch-bound resume tokenと
単一ownerのexecution leaseを使い、期限切れleaseだけ安全に回収できます。曖昧なrunはrerouteしません。

Final Reviewはshell無効・repository相対pathでverifierを実行し、contract/mutation revision、verifier仕様、repository stateにevidenceを束縛します。
完全なpass evidenceだけを`enno_finish`が受理します。失敗時はGokiへ直接戻らず、Zenkiが新revisionで再計画します。受理後はread-only meditationで削除候補を記録するだけです。

ideal、planning、final-reviewでは、親hostが最大3つの隔離read-only Advisory Round slotを使えます。Kiokuko自身はadvisorを起動せず、隔離を確認できないslotはunavailableになります。
