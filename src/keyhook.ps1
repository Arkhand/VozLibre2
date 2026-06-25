# VozLibre2 — Hook global de teclado para PUSH-TO-TALK
# =====================================================
# Instala un low-level keyboard hook (WH_KEYBOARD_LL) y detecta cuándo se MANTIENE
# presionada la combinación del atajo (mods + tecla). Imprime por STDOUT:
#   DOWN  -> cuando la combinación pasa a estar presionada (keydown de la tecla
#            principal con los modificadores requeridos abajo)
#   UP    -> cuando se suelta la tecla principal
# El main (Electron) lee estas líneas y arranca/para la grabación => push-to-talk
# global real (globalShortcut de Electron NO detecta el keyup, por eso este hook).
#
# Args (todos opcionales, vienen del atajo configurado):
#   -Key   nombre de la tecla principal (ej: "Space", "K", "F8"). Default: Space
#   -Ctrl  -Shift  -Alt  -Win   switches: qué modificadores exige la combinación.
#
# Sin dependencias nativas: solo Win32 vía Add-Type. Empaquetable como recurso.

param(
  [string]$Key = "Space",
  [switch]$Ctrl,
  [switch]$Shift,
  [switch]$Alt,
  [switch]$Win
)

$ErrorActionPreference = "Stop"

# Para mapear símbolos ("/", ".", "-"…) a su virtual-key necesitamos VkKeyScan.
Add-Type -MemberDefinition '[DllImport("user32.dll")] public static extern short VkKeyScan(char ch);' -Name VK -Namespace W32 -ErrorAction SilentlyContinue

# Mapear el nombre de tecla a Virtual-Key code. Teclas con nombre (Space, F1…) van
# por la tabla; para A-Z y 0-9 el VK == código ASCII; para símbolos de 1 carácter
# ("/", ".", "-"…) usamos VkKeyScan (el byte bajo es el VK).
function Get-VK([string]$name) {
  switch ($name.ToUpper()) {
    "SPACE" { return 0x20 }
    "ENTER" { return 0x0D }
    "TAB"   { return 0x09 }
    "ESC"   { return 0x1B }   "ESCAPE" { return 0x1B }
    "F1" {return 0x70} "F2" {return 0x71} "F3" {return 0x72} "F4" {return 0x73}
    "F5" {return 0x74} "F6" {return 0x75} "F7" {return 0x76} "F8" {return 0x77}
    "F9" {return 0x78} "F10"{return 0x79} "F11"{return 0x7A} "F12"{return 0x7B}
    default {
      if ($name.Length -eq 1) {
        $ch = $name[0]
        # Letras/dígitos: VK == ASCII en mayúscula. Símbolos: VkKeyScan.
        if (($ch -ge 'A' -and $ch -le 'Z') -or ($ch -ge 'a' -and $ch -le 'z') -or ($ch -ge '0' -and $ch -le '9')) {
          return [int][char]([string]$ch).ToUpper()
        }
        $scan = [W32.VK]::VkKeyScan($ch)
        if ($scan -ne -1) { return ($scan -band 0xFF) }  # byte bajo = VK
      }
      return 0x20
    }
  }
}

$targetVK = Get-VK $Key

$signature = @'
using System;
using System.Runtime.InteropServices;

public static class KeyHook {
    public delegate IntPtr HookProc(int nCode, IntPtr wParam, IntPtr lParam);

    [DllImport("user32.dll", SetLastError=true)]
    public static extern IntPtr SetWindowsHookEx(int idHook, HookProc lpfn, IntPtr hMod, uint dwThreadId);
    [DllImport("user32.dll", SetLastError=true)]
    public static extern bool UnhookWindowsHookEx(IntPtr hhk);
    [DllImport("user32.dll")]
    public static extern IntPtr CallNextHookEx(IntPtr hhk, int nCode, IntPtr wParam, IntPtr lParam);
    [DllImport("kernel32.dll")]
    public static extern IntPtr GetModuleHandle(string lpModuleName);
    [DllImport("user32.dll")]
    public static extern short GetAsyncKeyState(int vKey);

    public const int WH_KEYBOARD_LL = 13;
    public const int WM_KEYDOWN = 0x0100;
    public const int WM_KEYUP   = 0x0101;
    public const int WM_SYSKEYDOWN = 0x0104;
    public const int WM_SYSKEYUP   = 0x0105;

    public const int VK_CONTROL = 0x11;
    public const int VK_SHIFT   = 0x10;
    public const int VK_MENU    = 0x12; // Alt
    public const int VK_LWIN = 0x5B, VK_RWIN = 0x5C;

    public static int TargetVK;
    public static bool NeedCtrl, NeedShift, NeedAlt, NeedWin;
    static bool down = false; // estado actual de la combinación

    static IntPtr hookId = IntPtr.Zero;
    static HookProc proc = HookCallback;

    static bool ModsOk() {
        bool ctrl = (GetAsyncKeyState(VK_CONTROL) & 0x8000) != 0;
        bool shift = (GetAsyncKeyState(VK_SHIFT) & 0x8000) != 0;
        bool alt = (GetAsyncKeyState(VK_MENU) & 0x8000) != 0;
        bool win = ((GetAsyncKeyState(VK_LWIN) & 0x8000) != 0) || ((GetAsyncKeyState(VK_RWIN) & 0x8000) != 0);
        if (NeedCtrl != ctrl) return false;
        if (NeedShift != shift) return false;
        if (NeedAlt != alt) return false;
        if (NeedWin != win) return false;
        return true;
    }

    static IntPtr HookCallback(int nCode, IntPtr wParam, IntPtr lParam) {
        if (nCode >= 0) {
            int msg = wParam.ToInt32();
            int vk = Marshal.ReadInt32(lParam);
            if (vk == TargetVK) {
                if ((msg == WM_KEYDOWN || msg == WM_SYSKEYDOWN) && !down && ModsOk()) {
                    down = true;
                    Console.Out.WriteLine("DOWN");
                    Console.Out.Flush();
                } else if ((msg == WM_KEYUP || msg == WM_SYSKEYUP) && down) {
                    down = false;
                    Console.Out.WriteLine("UP");
                    Console.Out.Flush();
                }
            }
        }
        return CallNextHookEx(hookId, nCode, wParam, lParam);
    }

    public static void Run() {
        hookId = SetWindowsHookEx(WH_KEYBOARD_LL, proc, GetModuleHandle(null), 0);
        if (hookId == IntPtr.Zero) {
            Console.Error.WriteLine("HOOK_FAIL:" + Marshal.GetLastWin32Error());
            return;
        }
        // Bombear mensajes para que el hook reciba eventos.
        System.Windows.Forms.Application.Run();
        UnhookWindowsHookEx(hookId);
    }
}
'@

Add-Type -TypeDefinition $signature -ReferencedAssemblies System.Windows.Forms -Language CSharp

[KeyHook]::TargetVK = $targetVK
[KeyHook]::NeedCtrl  = [bool]$Ctrl
[KeyHook]::NeedShift = [bool]$Shift
[KeyHook]::NeedAlt   = [bool]$Alt
[KeyHook]::NeedWin   = [bool]$Win

[Console]::Out.WriteLine("READY")
[Console]::Out.Flush()
[KeyHook]::Run()
