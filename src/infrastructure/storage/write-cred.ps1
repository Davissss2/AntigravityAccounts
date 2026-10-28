# Writes the Antigravity agent credential into Windows Credential Manager.
#
# Since Antigravity 1.107 the agent (agy.exe --hub) authenticates with the generic
# credential "gemini:antigravity", a plain-JSON blob holding the OAuth token set.
# state.vscdb no longer drives the session, so switching accounts requires updating
# this credential too.
#
# Usage: powershell -NoProfile -ExecutionPolicy Bypass -File write-cred.ps1 -PayloadPath <json>
param(
    [Parameter(Mandatory = $true)][string]$PayloadPath,
    [string]$Target = "gemini:antigravity",
    [string]$UserName = "antigravity"
)

$ErrorActionPreference = "Stop"

if (-not (Test-Path $PayloadPath)) {
    Write-Output "payload not found: $PayloadPath"
    exit 1
}

Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public class AgCred {
  [DllImport("advapi32.dll", SetLastError=true, CharSet=CharSet.Unicode)]
  public static extern bool CredRead(string target, int type, int flags, out IntPtr credentialPtr);
  [DllImport("advapi32.dll", SetLastError=true, CharSet=CharSet.Unicode)]
  public static extern bool CredWrite(ref CREDENTIAL credential, int flags);
  [DllImport("advapi32.dll", SetLastError=true)]
  public static extern void CredFree(IntPtr cred);
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
  public struct CREDENTIAL {
    public int Flags; public int Type; public string TargetName; public string Comment;
    public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
    public int CredentialBlobSize; public IntPtr CredentialBlob;
    public int Persist; public int AttributeCount; public IntPtr Attributes;
    public string TargetAlias; public string UserName;
  }
}
"@

# Preserve the persistence flag of the existing entry (2 = local machine).
$persist = 2
$ptr = [IntPtr]::Zero
if ([AgCred]::CredRead($Target, 1, 0, [ref]$ptr)) {
    try {
        $existing = [Runtime.InteropServices.Marshal]::PtrToStructure($ptr, [type][AgCred+CREDENTIAL])
        if ($existing.Persist -ne 0) { $persist = $existing.Persist }
    } finally {
        [AgCred]::CredFree($ptr)
    }
}

$text = [IO.File]::ReadAllText($PayloadPath)
if ($text.Length -eq 0) {
    Write-Output "payload is empty"
    exit 1
}
# Fail early on malformed JSON so a broken blob is never written.
$null = $text | ConvertFrom-Json

$bytes = [Text.Encoding]::UTF8.GetBytes($text)
$blobPtr = [Runtime.InteropServices.Marshal]::AllocHGlobal($bytes.Length)
try {
    [Runtime.InteropServices.Marshal]::Copy($bytes, 0, $blobPtr, $bytes.Length)

    $cred = New-Object AgCred+CREDENTIAL
    $cred.Flags = 0
    $cred.Type = 1
    $cred.TargetName = $Target
    $cred.Comment = $null
    $cred.CredentialBlobSize = $bytes.Length
    $cred.CredentialBlob = $blobPtr
    $cred.Persist = $persist
    $cred.AttributeCount = 0
    $cred.Attributes = [IntPtr]::Zero
    $cred.TargetAlias = $null
    $cred.UserName = $UserName

    if (-not [AgCred]::CredWrite([ref]$cred, 0)) {
        $code = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
        Write-Output ("CredWrite failed ({0}): {1}" -f $code, ([ComponentModel.Win32Exception]::new($code)).Message)
        exit 1
    }
} finally {
    [Runtime.InteropServices.Marshal]::FreeHGlobal($blobPtr)
}

Write-Output "credential written ($($text.Length) chars)"
exit 0
