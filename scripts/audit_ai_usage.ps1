$patterns = @(
  'summary/market-cards',
  'summary/archive',
  'summary/conference-prompt',
  'summary/notifications-digest',
  'tensorflow/predict',
  'tensorflow/transcribe',
  'tensorflow/chat',
  'VoiceMicButton',
  '/rag/'
)
$files = Get-ChildItem C:\mobile2\src -Recurse -Include *.ts,*.tsx
foreach ($p in $patterns) {
  Write-Host "===== $p ====="
  $files | Select-String -SimpleMatch -Pattern $p -List | ForEach-Object { $_.Path.Replace('C:\mobile2\','') }
}
