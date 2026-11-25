# Reads the Antigravity agent credential from Windows Credential Manager.
# Returns the raw JSON blob for "gemini:antigravity" to stdout (UTF-8), or exits 1 if absent.
param(
    [string]$Target = "gemini:antigravity"
)

$ErrorActionPreference = "Stop"

Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public class AgCredRead {
  [DllImport("advapi32.dll", SetLastError=true, CharSet=CharSet.Unicode)]
  public static extern bool CredRead(string target, int type, int flags, out IntPtr credentialPtr);
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

$ptr = [IntPtr]::Zero
if (-not [AgCredRead]::CredRead($Target, 1, 0, [ref]$ptr)) {
    exit 1
}

try {
    $cred = [Runtime.InteropServices.Marshal]::PtrToStructure($ptr, [type][AgCredRead+CREDENTIAL])
    if ($cred.CredentialBlobSize -le 0 -or $cred.CredentialBlob -eq [IntPtr]::Zero) {
        exit 1
    }
    $bytes = New-Object byte[] $cred.CredentialBlobSize
    [Runtime.InteropServices.Marshal]::Copy($cred.CredentialBlob, $bytes, 0, $cred.CredentialBlobSize)
    [Console]::OutputEncoding = [Text.Encoding]::UTF8
    [Console]::Out.Write([Text.Encoding]::UTF8.GetString($bytes))
} finally {
    [AgCredRead]::CredFree($ptr)
}
exit 0
