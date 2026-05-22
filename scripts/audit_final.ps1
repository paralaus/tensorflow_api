$patterns = @('MarketSummaryCard','aiSummary','summaryMarketCards','MarketAIPanel','VoiceMicButton','transcribeAudio','/predict','intentDetect','zero_shot','classifyMessage','autoCategory','/tensorflow/predict')
foreach ($p in $patterns) {
  Write-Host "===== $p ====="
  Get-ChildItem C:\mobile2\src -Recurse -Include *.ts,*.tsx | Select-String -SimpleMatch -Pattern $p -List | ForEach-Object { $_.Path.Replace('C:\mobile2\','') }
}
