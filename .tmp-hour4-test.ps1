$ErrorActionPreference = 'Stop'
$tmp = Join-Path (Get-Location) '.tmp-hour4-test'
if (Test-Path $tmp) { Remove-Item $tmp -Recurse -Force }
New-Item -ItemType Directory -Path $tmp | Out-Null
Set-Content -Path (Join-Path $tmp 'a.txt') -Value 'alpha'
Set-Content -Path (Join-Path $tmp 'b.txt') -Value 'beta'
Set-Content -Path (Join-Path $tmp 'clip.json') -Value '{"imageBase64":"data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/6X0AAAAASUVORK5CYII=","burnAfterDownload":false}'

function Invoke-CurlRaw([string]$cmd) { Invoke-Expression $cmd }
function Parse-Resp([string]$raw) { $parts = $raw -split '\|HTTPSTATUS\|'; @{ body = $parts[0]; status = [int]$parts[1] } }
function Get-Code($body) { try { (($body | ConvertFrom-Json).code) } catch { '' } }

$results = [ordered]@{}

$r = Parse-Resp (Invoke-CurlRaw 'curl.exe -s -o - -w "|HTTPSTATUS|%{http_code}" http://localhost:3001/api/health')
$results.health = ($r.status -eq 200)

$u1 = Parse-Resp (Invoke-CurlRaw ('curl.exe -s -F "files=@{0}" -F "burnAfterDownload=false" -o - -w "|HTTPSTATUS|%{{http_code}}" http://localhost:3001/api/upload' -f (Join-Path $tmp 'a.txt')))
$codeUpload = Get-Code $u1.body
$results.upload = ($u1.status -eq 200 -and [string]::IsNullOrWhiteSpace($codeUpload) -eq $false)

$clip = Parse-Resp (Invoke-CurlRaw ('curl.exe -s -H "Content-Type: application/json" --data-binary "@{0}" -o - -w "|HTTPSTATUS|%{{http_code}}" http://localhost:3001/api/upload/clipboard' -f (Join-Path $tmp 'clip.json')))
$codeClip = Get-Code $clip.body
$results.clipboard = ($clip.status -eq 200 -and [string]::IsNullOrWhiteSpace($codeClip) -eq $false)

$meta = Parse-Resp (Invoke-CurlRaw ("curl.exe -s -o - -w \"|HTTPSTATUS|%{http_code}\" http://localhost:3001/api/file/$codeUpload"))
$results.metadata = ($meta.status -eq 200)

$dlStatus = Invoke-CurlRaw ("curl.exe -s -o \"$tmp\\dl.bin\" -w \"%{http_code}\" http://localhost:3001/api/download/$codeUpload")
$dlSize = (Get-Item (Join-Path $tmp 'dl.bin')).Length
$results.download = (($dlStatus -eq '200') -and ($dlSize -gt 0))

$nearSeed = Parse-Resp (Invoke-CurlRaw ('curl.exe -s -H "X-Forwarded-For: 192.168.88.11" -F "files=@{0}" -F "burnAfterDownload=false" -o - -w "|HTTPSTATUS|%{{http_code}}" http://localhost:3001/api/upload' -f (Join-Path $tmp 'a.txt')))
$nearCode = Get-Code $nearSeed.body
$near = Parse-Resp (Invoke-CurlRaw 'curl.exe -s -H "X-Forwarded-For: 192.168.88.55" -o - -w "|HTTPSTATUS|%{http_code}" http://localhost:3001/api/nearby')
$nearOk = $false
if ($near.status -eq 200) { try { $arr = ($near.body | ConvertFrom-Json).transfers; $nearOk = ($arr | Where-Object { $_.code -eq $nearCode }).Count -ge 1 } catch {} }
$results.nearby = $nearOk

$stats = Parse-Resp (Invoke-CurlRaw 'curl.exe -s -o - -w "|HTTPSTATUS|%{http_code}" http://localhost:3001/api/stats')
$statsOk = $false
if ($stats.status -eq 200) { try { $s = $stats.body | ConvertFrom-Json; $statsOk = ($null -ne $s.totalTransfers -and $null -ne $s.activeTransfers) } catch {} }
$results.stats = $statsOk

$burnUp = Parse-Resp (Invoke-CurlRaw ('curl.exe -s -F "files=@{0}" -F "burnAfterDownload=true" -o - -w "|HTTPSTATUS|%{{http_code}}" http://localhost:3001/api/upload' -f (Join-Path $tmp 'a.txt')))
$burnCode = Get-Code $burnUp.body
$burnFirst = Invoke-CurlRaw ("curl.exe -s -o \"$tmp\\burn1.bin\" -w \"%{http_code}\" http://localhost:3001/api/download/$burnCode")
$burnSecond = Parse-Resp (Invoke-CurlRaw ("curl.exe -s -o - -w \"|HTTPSTATUS|%{http_code}\" http://localhost:3001/api/download/$burnCode"))
$burnErrShape = $false
try { $be = $burnSecond.body | ConvertFrom-Json; $burnErrShape = ($be.success -eq $false -and $null -ne $be.error.code -and $null -ne $be.error.message) } catch {}
$results.burn = ($burnFirst -eq '200' -and $burnSecond.status -eq 410 -and $burnErrShape)

$expUp = Parse-Resp (Invoke-CurlRaw ('curl.exe -s -F "files=@{0}" -F "burnAfterDownload=false" -o - -w "|HTTPSTATUS|%{{http_code}}" http://localhost:3001/api/upload' -f (Join-Path $tmp 'a.txt')))
$expCode = Get-Code $expUp.body
$nodeCmd = "require('dotenv').config(); const m=require('mongoose'); const T=require('./models/Transfer'); (async()=>{await m.connect(process.env.MONGO_URI); await T.updateOne({code:'$expCode'}, {`$set:{expiresAt:new Date(Date.now()-60000)}}); await m.disconnect();})();"
node -e $nodeCmd | Out-Null
$expDl = Parse-Resp (Invoke-CurlRaw ("curl.exe -s -o - -w \"|HTTPSTATUS|%{http_code}\" http://localhost:3001/api/download/$expCode"))
$expOk = $false
try { $ee = $expDl.body | ConvertFrom-Json; $expOk = ($expDl.status -eq 410 -and $ee.error.code -eq 'TRANSFER_EXPIRED') } catch {}
$results.expiry = $expOk

$zipUp = Parse-Resp (Invoke-CurlRaw ('curl.exe -s -F "files=@{0}" -F "files=@{1}" -F "burnAfterDownload=false" -o - -w "|HTTPSTATUS|%{{http_code}}" http://localhost:3001/api/upload' -f (Join-Path $tmp 'a.txt'), (Join-Path $tmp 'b.txt')))
$zipCode = Get-Code $zipUp.body
$zipStatus = Invoke-CurlRaw ("curl.exe -s -D \"$tmp\\zip.hdr\" -o \"$tmp\\zip.bin\" -w \"%{http_code}\" http://localhost:3001/api/download/$zipCode")
$zipHeader = Get-Content (Join-Path $tmp 'zip.hdr') -Raw
$zipBytes = [System.IO.File]::ReadAllBytes((Join-Path $tmp 'zip.bin'))
$zipMagic = ($zipBytes.Length -ge 2 -and $zipBytes[0] -eq 0x50 -and $zipBytes[1] -eq 0x4B)
$results.zip = (($zipStatus -eq '200') -and $zipMagic -and ($zipHeader -match 'application/zip'))

$del = Parse-Resp (Invoke-CurlRaw ("curl.exe -s -X DELETE -o - -w \"|HTTPSTATUS|%{http_code}\" http://localhost:3001/api/transfer/$zipCode"))
$results.delete = ($del.status -eq 200)

$e1 = Parse-Resp (Invoke-CurlRaw 'curl.exe -s -o - -w "|HTTPSTATUS|%{http_code}" http://localhost:3001/api/file/abc')
$e2 = Parse-Resp (Invoke-CurlRaw 'curl.exe -s -o - -w "|HTTPSTATUS|%{http_code}" http://localhost:3001/api/download/abc')
$e3 = Parse-Resp (Invoke-CurlRaw 'curl.exe -s -X DELETE -o - -w "|HTTPSTATUS|%{http_code}" http://localhost:3001/api/transfer/abc')
$shapeOk = $true
foreach ($e in @($e1,$e2,$e3)) { try { $j = $e.body | ConvertFrom-Json; if (-not ($j.success -eq $false -and $null -ne $j.error.code -and $null -ne $j.error.message)) { $shapeOk = $false } } catch { $shapeOk = $false } }
$results.errorshape = $shapeOk

$hit429 = $false
for ($i = 1; $i -le 40; $i++) {
  $st = Invoke-CurlRaw ('curl.exe -s -F "files=@{0}" -F "burnAfterDownload=false" -o NUL -w "%{{http_code}}" http://localhost:3001/api/upload' -f (Join-Path $tmp 'a.txt'))
  if ($st -eq '429') { $hit429 = $true; break }
}
$results.ratelimit = $hit429

$results | ConvertTo-Json -Compress
