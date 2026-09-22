import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const url = 'http://127.0.0.1:49620/health';
async function health() {
  try { const r = await fetch(url, { signal: AbortSignal.timeout(1200) }); if (!r.ok) throw Error(`Unexpected HTTP ${r.status}`); return await r.json(); }
  catch (error) { if (error.cause?.code === 'ECONNREFUSED' || error.code === 'ECONNREFUSED') return null; throw error; }
}
const current = await health();
if (current) {
  if (current.service !== 'easyeda-bridge' || current.bridgeVersion !== '2.0.0') throw Error('Port 49620 belongs to another service/version; explicit migration is required');
  console.log(JSON.stringify({ started: false, alreadyRunning: true, bridgeVersion: current.bridgeVersion, edaConnected: current.edaConnected }));
} else {
  const entry = fileURLToPath(new URL('./bridge-server.mjs', import.meta.url));
  let child;
  if (process.platform === 'win32') {
    // Create the localhost service with Windows process management so a short-lived
    // command worker cannot reap it on exit. No scheduled task, service install or elevation.
    const literal = value => "'" + value.replaceAll("'", "''") + "'";
    const commandLine = `"${process.execPath}" "${entry}"`;
    const directory = fileURLToPath(new URL('.', import.meta.url));
    const script = `$ErrorActionPreference='Stop'; $startup=New-CimInstance -ClassName Win32_ProcessStartup -ClientOnly -Property @{ShowWindow=[uint16]0}; Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{CommandLine=${literal(commandLine)};CurrentDirectory=${literal(directory)};ProcessStartupInformation=$startup} | ConvertTo-Json -Compress`;
    const response = JSON.parse(execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', timeout: 15000, windowsHide: true }));
    if (response.ReturnValue !== 0 || !response.ProcessId) throw Error('Windows did not create the Bridge process');
    child = { pid: response.ProcessId };
  } else {
    child = spawn(process.execPath, [entry], { cwd: fileURLToPath(new URL('.', import.meta.url)), detached: true, stdio: 'ignore', env: { ...process.env, EASYEDA_BRIDGE_PORT: '49620' } });
    child.unref();
  }
  let verified = null;
  for (let i = 0; i < 30; i++) { await new Promise(resolve => setTimeout(resolve, 150)); verified = await health(); if (verified?.bridgeVersion === '2.0.0' && verified.service === 'easyeda-bridge') break; }
  if (!verified || verified.service !== 'easyeda-bridge' || verified.bridgeVersion !== '2.0.0') throw Error('Bridge startup was not confirmed');
  console.log(JSON.stringify({ started: true, pid: child.pid, bridgeVersion: verified.bridgeVersion }));
}
