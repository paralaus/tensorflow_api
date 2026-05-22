$targets = @('PollModal','MarketDetails','NewsDetail','StockMarket','CryptoMarket','ViopMarket','Notification','Profile','Bio','Composer','VideoConferenceScreen','Archived')
foreach ($t in $targets) {
  Write-Host "===== $t ====="
  Get-ChildItem C:\mobile2\src -Recurse -Include *.ts,*.tsx -Filter "*$t*" 2>$null | ForEach-Object { $_.FullName.Replace('C:\mobile2\','') }
}
