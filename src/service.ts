#!/usr/bin/env node
/**
 * Cross-platform service manager for SecretAgent.
 * Installs/manages the bot as a background service (launchd on macOS, systemd on Linux).
 *
 * Usage: npm run service [install|uninstall|start|stop|restart|status|logs]
 */

import { execSync, spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

const SERVICE_LABEL = 'com.secret-agent.bot';
const SYSTEMD_UNIT = 'secret-agent';
const PROJECT_ROOT = path.resolve(import.meta.dirname, '..');

// ── Helpers ──────────────────────────────────────────────────────────────────

function run(cmd: string, opts?: { silent?: boolean }): string {
  try {
    return execSync(cmd, { encoding: 'utf-8', cwd: PROJECT_ROOT, stdio: opts?.silent ? 'pipe' : undefined }).trim();
  } catch (e: any) {
    if (opts?.silent) return e.stdout?.trim?.() ?? '';
    throw e;
  }
}

function die(msg: string): never {
  console.error(`\n  ✖ ${msg}\n`);
  process.exit(1);
}

function ok(msg: string) {
  console.log(`  ✔ ${msg}`);
}

function info(msg: string) {
  console.log(`  ℹ ${msg}`);
}

function resolveNode(): string {
  try {
    return run('which node', { silent: true });
  } catch {
    die('Could not find node binary. Ensure Node.js is installed and in your PATH.');
  }
}

function loadEnvVars(): Record<string, string> {
  const envPath = path.join(PROJECT_ROOT, '.env');
  if (!fs.existsSync(envPath)) die('.env file not found. Run `npm run setup` first.');
  const vars: Record<string, string> = {};
  for (const line of fs.readFileSync(envPath, 'utf-8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq < 1) continue;
    const key = trimmed.slice(0, eq).trim();
    let val = trimmed.slice(eq + 1).trim();
    // Strip surrounding quotes
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    vars[key] = val;
  }
  return vars;
}

const platform = os.platform();

// ── macOS (launchd) ──────────────────────────────────────────────────────────

const plistPath = path.join(os.homedir(), 'Library', 'LaunchAgents', `${SERVICE_LABEL}.plist`);
const domainTarget = `gui/${run('id -u', { silent: true })}`;
const serviceTarget = `${domainTarget}/${SERVICE_LABEL}`;

function generatePlist(nodePath: string, envVars: Record<string, string>): string {
  const dataDir = path.resolve(PROJECT_ROOT, envVars.DATA_DIR || './data');
  fs.mkdirSync(dataDir, { recursive: true });

  // Build PATH that includes the node binary's directory (critical for nvm/fnm setups)
  const nodeBinDir = path.dirname(nodePath);
  const envPath = [nodeBinDir, '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin'].join(':');

  const envEntries = Object.entries({ ...envVars, PATH: envPath })
    .map(([k, v]) => `      <key>${escapeXml(k)}</key>\n      <string>${escapeXml(v)}</string>`)
    .join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${SERVICE_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${escapeXml(nodePath)}</string>
    <string>${escapeXml(path.join(PROJECT_ROOT, 'dist', 'index.js'))}</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${escapeXml(PROJECT_ROOT)}</string>
  <key>EnvironmentVariables</key>
  <dict>
${envEntries}
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${escapeXml(path.join(dataDir, 'service-out.log'))}</string>
  <key>StandardErrorPath</key>
  <string>${escapeXml(path.join(dataDir, 'service-err.log'))}</string>
</dict>
</plist>`;
}

function escapeXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function launchdIsLoaded(): boolean {
  const result = spawnSync('launchctl', ['print', serviceTarget], { encoding: 'utf-8', stdio: 'pipe' });
  return result.status === 0;
}

function launchdGetPid(): number | null {
  const result = spawnSync('launchctl', ['print', serviceTarget], { encoding: 'utf-8', stdio: 'pipe' });
  if (result.status !== 0) return null;
  const match = result.stdout.match(/pid\s*=\s*(\d+)/);
  return match ? parseInt(match[1], 10) : null;
}

const darwinHandlers = {
  install() {
    if (launchdIsLoaded()) die('Service is already installed. Run `npm run service uninstall` first.');

    const envVars = loadEnvVars();
    const nodePath = resolveNode();

    info('Building project...');
    run('npm run build');

    info('Generating launchd plist...');
    fs.mkdirSync(path.dirname(plistPath), { recursive: true });
    fs.writeFileSync(plistPath, generatePlist(nodePath, envVars));
    ok(`Plist written to ${plistPath}`);

    info('Loading service...');
    run(`launchctl bootstrap ${domainTarget} ${plistPath}`);
    ok('Service installed and started');

    info('Bot is now running in the background.');
    info('It will auto-start on login.');
  },

  uninstall() {
    if (!fs.existsSync(plistPath)) die('Service is not installed.');

    info('Removing service...');
    if (launchdIsLoaded()) {
      spawnSync('launchctl', ['bootout', serviceTarget], { stdio: 'pipe' });
    }
    fs.unlinkSync(plistPath);
    ok('Service uninstalled');
  },

  start() {
    if (!fs.existsSync(plistPath)) die('Service is not installed. Run `npm run service install` first.');
    if (!launchdIsLoaded()) {
      run(`launchctl bootstrap ${domainTarget} ${plistPath}`);
    }
    run(`launchctl enable ${serviceTarget}`);
    spawnSync('launchctl', ['kickstart', serviceTarget], { stdio: 'pipe' });
    ok('Service started');
  },

  stop() {
    if (!launchdIsLoaded()) die('Service is not running.');
    // Disable first to prevent KeepAlive from restarting
    run(`launchctl disable ${serviceTarget}`);
    const pid = launchdGetPid();
    if (pid) {
      try { process.kill(pid, 'SIGTERM'); } catch {}
    }
    ok('Service stopped');
  },

  restart() {
    if (!launchdIsLoaded()) die('Service is not running. Use `npm run service start`.');
    run(`launchctl enable ${serviceTarget}`);
    spawnSync('launchctl', ['kickstart', '-k', serviceTarget], { stdio: 'pipe' });
    ok('Service restarted');
  },

  status() {
    if (!fs.existsSync(plistPath)) {
      console.log('\n  Service: not installed\n');
      return;
    }
    if (!launchdIsLoaded()) {
      console.log('\n  Service: installed but not loaded\n');
      return;
    }
    const pid = launchdGetPid();
    if (pid) {
      // Get process uptime
      let uptime = '';
      try {
        const elapsed = run(`ps -p ${pid} -o etime=`, { silent: true }).trim();
        if (elapsed) uptime = ` (uptime: ${elapsed.trim()})`;
      } catch {}
      console.log(`\n  Service: running`);
      console.log(`  PID:     ${pid}${uptime}\n`);
    } else {
      console.log('\n  Service: loaded but not running (may be restarting)\n');
    }
  },

  logs() {
    const dataDir = path.resolve(PROJECT_ROOT, loadEnvVars().DATA_DIR || './data');
    const outLog = path.join(dataDir, 'service-out.log');
    const errLog = path.join(dataDir, 'service-err.log');
    const files = [outLog, errLog].filter(f => fs.existsSync(f));
    if (files.length === 0) die('No log files found. Is the service installed?');
    info(`Tailing ${files.join(' and ')}  (Ctrl+C to stop)\n`);
    spawnSync('tail', ['-f', ...files], { stdio: 'inherit' });
  },
};

// ── Linux (systemd) ──────────────────────────────────────────────────────────

function isRoot(): boolean {
  return process.getuid?.() === 0;
}

function systemdUnitPath(): string {
  if (isRoot()) return `/etc/systemd/system/${SYSTEMD_UNIT}.service`;
  const configDir = path.join(os.homedir(), '.config', 'systemd', 'user');
  fs.mkdirSync(configDir, { recursive: true });
  return path.join(configDir, `${SYSTEMD_UNIT}.service`);
}

function systemctl(...args: string[]): string {
  const userFlag = isRoot() ? [] : ['--user'];
  const result = spawnSync('systemctl', [...userFlag, ...args], { encoding: 'utf-8', stdio: 'pipe' });
  return result.stdout?.trim() ?? '';
}

function generateSystemdUnit(nodePath: string): string {
  const envPath = path.join(PROJECT_ROOT, '.env');
  const user = isRoot() ? os.userInfo().username : '';

  let unit = `[Unit]
Description=SecretAgent Telegram Bot
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=${nodePath} ${path.join(PROJECT_ROOT, 'dist', 'index.js')}
WorkingDirectory=${PROJECT_ROOT}
EnvironmentFile=${envPath}
Restart=always
RestartSec=5
`;

  if (isRoot() && user) {
    unit += `User=${user}\n`;
  }

  unit += `
[Install]
WantedBy=${isRoot() ? 'multi-user.target' : 'default.target'}
`;

  return unit;
}

const linuxHandlers = {
  install() {
    const unitPath = systemdUnitPath();
    if (fs.existsSync(unitPath)) die('Service is already installed. Run `npm run service uninstall` first.');

    loadEnvVars(); // Validate .env exists
    const nodePath = resolveNode();

    info('Building project...');
    run('npm run build');

    info('Generating systemd unit...');
    fs.writeFileSync(unitPath, generateSystemdUnit(nodePath));
    ok(`Unit written to ${unitPath}`);

    systemctl('daemon-reload');
    systemctl('enable', SYSTEMD_UNIT);
    systemctl('start', SYSTEMD_UNIT);
    ok('Service installed, enabled, and started');

    if (!isRoot()) {
      info('Tip: run `loginctl enable-linger` to keep user services running after logout.');
    }
  },

  uninstall() {
    const unitPath = systemdUnitPath();
    if (!fs.existsSync(unitPath)) die('Service is not installed.');

    systemctl('stop', SYSTEMD_UNIT);
    systemctl('disable', SYSTEMD_UNIT);
    fs.unlinkSync(unitPath);
    systemctl('daemon-reload');
    ok('Service uninstalled');
  },

  start() {
    if (!fs.existsSync(systemdUnitPath())) die('Service is not installed. Run `npm run service install` first.');
    systemctl('start', SYSTEMD_UNIT);
    ok('Service started');
  },

  stop() {
    systemctl('stop', SYSTEMD_UNIT);
    ok('Service stopped');
  },

  restart() {
    systemctl('restart', SYSTEMD_UNIT);
    ok('Service restarted');
  },

  status() {
    if (!fs.existsSync(systemdUnitPath())) {
      console.log('\n  Service: not installed\n');
      return;
    }
    const output = systemctl('status', SYSTEMD_UNIT);
    console.log(`\n${output}\n`);
  },

  logs() {
    if (isRoot()) {
      spawnSync('journalctl', ['-u', SYSTEMD_UNIT, '-f'], { stdio: 'inherit' });
    } else {
      spawnSync('journalctl', ['--user', '-u', SYSTEMD_UNIT, '-f'], { stdio: 'inherit' });
    }
  },
};

// ── Main ─────────────────────────────────────────────────────────────────────

const commands = ['install', 'uninstall', 'start', 'stop', 'restart', 'status', 'logs'] as const;
type Command = typeof commands[number];

const command = process.argv[2] as Command;

if (!command || !commands.includes(command)) {
  console.log(`
  SecretAgent Service Manager

  Usage: npm run service <command>

  Commands:
    install     Install and start as a background service
    uninstall   Stop and remove the service
    start       Start the service
    stop        Stop the service
    restart     Restart the service
    status      Show service status
    logs        Tail service logs (Ctrl+C to stop)

  Platform: ${platform === 'darwin' ? 'macOS (launchd)' : platform === 'linux' ? 'Linux (systemd)' : platform}
`);
  process.exit(command ? 1 : 0);
}

if (platform === 'darwin') {
  darwinHandlers[command]();
} else if (platform === 'linux') {
  linuxHandlers[command]();
} else {
  die(`Unsupported platform: ${platform}. Only macOS (launchd) and Linux (systemd) are supported.`);
}
