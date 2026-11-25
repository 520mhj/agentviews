import { spawn, execFileSync } from 'node:child_process';

export async function launchBrowser({ exe, userDataDir, profile = 'Default', urls = ['about:blank'], extension }) {
  if (!exe) throw new Error('未找到可用的 Chromium 浏览器；可设置 AV_CHROME');
  const args = ['--no-first-run', '--no-default-browser-check', '--profile-directory=' + profile];
  if (userDataDir) args.push('--user-data-dir=' + userDataDir);
  if (extension) args.push('--load-extension=' + extension);
  args.push(...urls);
  let pid;
  let launcher = 'spawn-detached';
  if (process.platform === 'win32') {
    const quote = value => '"' + String(value).replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1') + '"';
    const command = [exe, ...args].map(quote).join(' ');
    const encoded = Buffer.from(command).toString('base64');
    const script = '$browserCommand=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String("' + encoded + '"));'
      + '$launchResult=Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{CommandLine=$browserCommand};'
      + '"RET="+$launchResult.ReturnValue+" PID="+$launchResult.ProcessId';
    const output = execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
      { encoding: 'utf8', timeout: 15000, windowsHide: true });
    const match = String(output).match(/RET=(\d+)\s+PID=(\d+)/);
    if (!match || match[1] !== '0') throw new Error('浏览器启动失败：' + String(output).trim());
    pid = Number(match[2]);
    launcher = 'wmi:Win32_Process.Create';
  } else {
    const child = spawn(exe, args, { detached: true, stdio: 'ignore' });
    await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
    child.unref();
    pid = child.pid;
  }
  return { browser_pid: pid, launcher, detached: true, persistent: true };
}
