$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding
$localMateSynth = $null
$localMateWave = $null
try {
  Add-Type -AssemblyName System.Speech
  $localMateRequest = [Console]::In.ReadToEnd() | ConvertFrom-Json
  $localMateSynth = New-Object System.Speech.Synthesis.SpeechSynthesizer
  $localMateVoices = @($localMateSynth.GetInstalledVoices() | Where-Object {$_.Enabled} | ForEach-Object {
    [pscustomobject]@{name=$_.VoiceInfo.Name; language=$_.VoiceInfo.Culture.Name}
  })
  if ($localMateRequest.operation -eq 'voices') {
    ConvertTo-Json -InputObject $localMateVoices -Compress
  } elseif ($localMateRequest.operation -eq 'speak') {
    $localMateText = [string]$localMateRequest.text
    if ([string]::IsNullOrWhiteSpace($localMateText) -or $localMateText.Length -gt 1800) {throw '읽을 내용은 1~1800자로 입력해 주세요.'}
    $localMateLanguage = 'en'
    if ($localMateText -match '[가-힣ㄱ-ㅎㅏ-ㅣ]') {$localMateLanguage = 'ko'}
    $localMateVoice = $localMateVoices | Where-Object {$_.language.StartsWith($localMateLanguage)} | Select-Object -First 1
    if (-not $localMateVoice) {throw '이 언어의 오프라인 Windows 음성이 설치되어 있지 않습니다.'}
    $localMateSynth.SelectVoice($localMateVoice.name)
    $localMateSynth.Rate = 0
    $localMateSynth.Volume = 100
    $localMateWave = New-Object System.IO.MemoryStream
    $localMateSynth.SetOutputToWaveStream($localMateWave)
    $localMateSynth.Speak($localMateText)
    $localMateSynth.SetOutputToNull()
    $localMateBytes = $localMateWave.ToArray()
    $localMateOutput = [Console]::OpenStandardOutput()
    $localMateOutput.Write($localMateBytes, 0, $localMateBytes.Length)
    $localMateOutput.Flush()
  } else {throw '지원하지 않는 음성 작업입니다.'}
} catch {
  [Console]::Error.WriteLine($_.Exception.Message)
  exit 1
} finally {
  if ($null -ne $localMateSynth) {$localMateSynth.Dispose()}
  if ($null -ne $localMateWave) {$localMateWave.Dispose()}
}
