$files = @(
  'c:\mobile2\src\screens\markets\NewsDetail.tsx',
  'c:\mobile2\src\screens\markets\MarketDetails.tsx',
  'c:\mobile2\src\screens\markets\StockMarket.tsx',
  'c:\mobile2\src\screens\markets\CryptoMarket.tsx',
  'c:\mobile2\src\screens\markets\ViopMarket.tsx',
  'c:\mobile2\src\screens\channels\ArchivedMessages.tsx',
  'c:\mobile2\src\screens\profile\Notifications.tsx',
  'c:\mobile2\src\components\modals\PollModal.tsx',
  'c:\mobile2\src\screens\profile\Profile.tsx',
  'c:\mobile2\src\screens\channels\VideoConferenceScreen.tsx'
)
foreach ($f in $files) {
  Write-Host "===== $($f.Replace('c:\mobile2\',''))  ====="
  Select-String -Path $f -Pattern 'aiSummary|summary/|tensorflow|VoiceMic|getConferencePrompt|conference-prompt|notificationsDigest|/predict|/chat|/rag|ragChat|askMarket|summaryArchive|summaryMarketCards' 2>$null | ForEach-Object { "L$($_.LineNumber): $($_.Line.Trim())" }
}
