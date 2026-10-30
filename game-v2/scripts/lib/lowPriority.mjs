// Keep a headless Chrome considerate on Kieran's machine: every process in its tree at Idle priority, so it only gets
// CPU nothing else wants (Chrome lifts its own GPU and renderer processes above the priority they inherit). Run once
// shortly after launch, and again once its renderer is up.
import { execFile } from 'child_process';

export function idleTree(rootPid) {
  if (process.platform !== 'win32') return;
  const ps = `$all = Get-CimInstance Win32_Process; $ids = @(${rootPid}); for ($i = 0; $i -lt $ids.Count; $i++) { $ids += @($all | Where-Object { $_.ParentProcessId -eq $ids[$i] } | ForEach-Object { $_.ProcessId }) }; foreach ($id in $ids) { try { (Get-Process -Id $id -ErrorAction Stop).PriorityClass = 'Idle' } catch {} }`;
  execFile('powershell', ['-NoProfile', '-Command', ps], { windowsHide: true }, () => {});
}

/** Clamp now-ish and again once the page has spun up its processes */
export function keepIdle(rootPid) {
  for (const ms of [1500, 6000, 15000]) setTimeout(() => idleTree(rootPid), ms).unref?.();
}
