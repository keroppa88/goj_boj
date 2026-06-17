# ReadMe
### 何？
* jpxが発表する投資部門別売買動向をjpxのAPIで取得する。
* 昔は「投資主体別売買動向」など。
* update_bumon.jsが木金月火の18時台に稼働して情報を取得する。
* dataフォルダ内のcsvを都度、上書きする。
* csvをindex.htmlで閲覧する。

### 情報発表タイミング
* 投資部門別情報・週次の第4営業日＝木曜日の18:00頃
* 通常は木曜日、祝日等非営業日がある場合はその分後ろ倒し。
* 連休等により通常と異なる公表スケジュールとなる場合はこちら。
* https://www.jpx.co.jp/markets/statistics-equities/investor-type/index.html

### 各項目定義
* 総計＝自己＋委託
* 委託＝自己以外の全て

### 各項目の対応
公表日	PubDate
開始日	StDate
終了日	EnDate
市場名	Section
自己計_売	PropSell
自己計_買	PropBuy
自己計_合計	PropTot
自己計_差引	PropBal
委託計_売	BrkSell
委託計_買	BrkBuy
委託計_合計	BrkTot
委託計_差引	BrkBal
総計_売	TotSell
総計_買	TotBuy
総計_合計	TotTot
総計_差引	TotBal
個人_売	IndSell
個人_買	IndBuy
個人_合計	IndTot
個人_差引	IndBal
海外投資家_売	FrgnSell
海外投資家_買	FrgnBuy
海外投資家_合計	FrgnTot
海外投資家_差引	FrgnBal
証券会社_売	SecCoSell
証券会社_買	SecCoBuy
証券会社_合計	SecCoTot
証券会社_差引	SecCoBal
投資信託_売	InvTrSell
投資信託_買	InvTrBuy
投資信託_合計	InvTrTot
投資信託_差引	InvTrBal
事業法人_売	BusCoSell
事業法人_買	BusCoBuy
事業法人_合計	BusCoTot
事業法人_差引	BusCoBal
その他法人_売	OthCoSell
その他法人	OthCoBuy
その他法人_合計	OthCoTot
その他法人_差引	OthCoBal
生保・損保_売	InsCoSell
生保・損保_買	InsCoBuy
生保・損保_合計	InsCoTot
生保・損保_差引	InsCoBal
都銀・地銀等_売	BankSell
都銀・地銀等_買	BankBuy
都銀・地銀等_合計	BankTot
都銀・地銀等_差引	BankBal
信託銀行_売	TrstBnkSell
信託銀行_買	TrstBnkBuy
信託銀行_合計	TrstBnkTot
信託銀行_差引	TrstBnkBal
その他金融機関_売	OthFinSell
その他金融機関_買	OthFinBuy
その他金融機関_合計	OthFinTot
その他金融機関_差引	OthFinBal

### PtoCSV_long.csv
ほぼ役目を終えた。デスクトップ収集を移行後に削除予定。

### 政府統計（日銀API・最下段チャート）
* `update_boj.js` が日本銀行「時系列統計データ検索サイト」APIから政府統計（為替・金利・マネー・短観・物価等）を取得する。
* 階層API(getDataLayer)でDBを丸ごと取得し、`data/boj/<DB>_<期種>.csv`（ワイド形式）と `data/boj/_catalog.csv` を出力する。
* `bojlist.csv` でチャートのプルダウンに出す系列を厳選できる（空なら _catalog.csv の全系列を自動表示）。列に集約方法(last=期末値 / sum=合計)を指定可能。
* APIキー不要。クレジット表示はindex.html下部に記載。高頻度アクセス禁止のためリクエスト間隔を空けている。
* `.github/workflows/update_boj.yml` で取得（当面は手動実行のみ。安定後に毎週金曜20:00の自動化を有効化予定）。

### 時間軸の粒度切替
* 画面上部の「日次／週次／月次」ボタンで全4段チャートの時間軸を連動切替する。
* 集約ルール：水準系（株価・為替・金利等）＝期末値、フロー系（部門別差引等）＝期間合計。
