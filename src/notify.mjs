/**
 * Windows 桌面通知。
 * 用系统自带 PowerShell 发 Toast；失败就静默，绝不因为通知影响抓取。
 */
import { spawnSync } from 'node:child_process';

export function notify(title, body) {
  if (process.platform !== 'win32') return false;
  const esc = (s) =>
    String(s || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .slice(0, 200);

  const ps = `
try {
  [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
  [Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null
  $xmlStr = '<toast><visual><binding template="ToastGeneric"><text>${esc(title)}</text><text>${esc(body)}</text></binding></visual></toast>'
  $xml = New-Object Windows.Data.Xml.Dom.XmlDocument
  $xml.LoadXml($xmlStr)
  $toast = New-Object Windows.UI.Notifications.ToastNotification $xml
  [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('BOSS 岗位追踪').Show($toast)
} catch { }
`.trim();

  try {
    spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], {
      stdio: 'ignore',
      timeout: 15000,
      windowsHide: true,
    });
    return true;
  } catch {
    return false;
  }
}
