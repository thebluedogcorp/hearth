'use strict';

const os = require('node:os');

class RemoteAccess {
  constructor({ store, logger, cloudflared, portProvider, instanceId }) {
    this.store = store;
    this.logger = logger;
    this.cloudflared = cloudflared;
    this.portProvider = portProvider;
    this.instanceId = instanceId;
    this.process = null;
    this.publicUrl = '';
    this.state = 'off';
    this.error = '';
    this.lastChecked = null;
  }

  vpnAddress() {
    for (const addresses of Object.values(os.networkInterfaces())) {
      for (const address of addresses || []) {
        if (address.family !== 'IPv4' || address.internal) continue;
        if (address.address.startsWith('100.') && /^100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(address.address)) return address.address;
      }
    }
    return null;
  }

  localAddresses() {
    const result = [];
    for (const [name, addresses] of Object.entries(os.networkInterfaces())) {
      for (const address of addresses || []) {
        if (address.family === 'IPv4' && !address.internal) result.push({ name, address: address.address, mac: address.mac });
      }
    }
    return result;
  }

  async startTunnel() {
    await this.stopTunnel();
    if (!this.cloudflared) throw new Error('Cloudflared is not installed');
    this.state = 'connecting';
    this.error = '';
    this.publicUrl = '';
    const { spawn } = require('node:child_process');
    const child = spawn(this.cloudflared, ['tunnel', '--no-autoupdate', '--url', `http://127.0.0.1:${this.portProvider()}`], {
      windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']
    });
    this.process = child;
    let buffer = '';
    const parse = chunk => {
      buffer += chunk.toString();
      const match = buffer.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/i);
      if (match && !this.publicUrl) {
        this.publicUrl = match[0];
        this.state = 'online';
        this.store.activity('info', 'Temporary HTTPS remote tunnel is online', { url: this.publicUrl });
      }
    };
    child.stdout.on('data', parse);
    child.stderr.on('data', parse);
    child.once('error', error => {
      if (this.process === child) {
        this.state = 'error';
        this.error = error.message;
      }
    });
    child.once('exit', code => {
      if (this.process === child) {
        this.state = code === 0 ? 'off' : 'error';
        this.error = code === 0 ? '' : `Tunnel exited with code ${code}`;
        this.publicUrl = '';
      }
    });
  }

  async stopTunnel() {
    if (!this.process) return;
    const child = this.process;
    this.process = null;
    await new Promise(resolve => {
      const timer = setTimeout(() => { child.kill(); resolve(); }, 3000);
      child.once('exit', () => { clearTimeout(timer); resolve(); });
      child.kill();
    });
    this.state = 'off';
    this.publicUrl = '';
  }

  async status() {
    const settings = this.store.settings();
    let url = '';
    let state = 'off';
    let detail = 'Remote access is off';
    if (settings.remoteMode === 'vpn') {
      const vpn = this.vpnAddress();
      url = vpn ? `http://${vpn}:${this.portProvider()}` : '';
      state = vpn ? 'online' : 'waiting';
      detail = vpn ? 'Reachable through your encrypted VPN interface' : 'Waiting for a Tailscale or CGNAT VPN address';
    } else if (settings.remoteMode === 'tunnel') {
      url = this.publicUrl;
      state = this.state;
      detail = this.error || (url ? 'Temporary HTTPS tunnel — address changes after restart' : 'Connecting an authenticated HTTPS tunnel');
    } else if (settings.remoteMode === 'proxy') {
      url = settings.remotePublicUrl;
      state = settings.remotePublicUrl ? 'configured' : 'off';
      detail = settings.remotePublicUrl ? 'HTTPS is terminated by your reverse proxy' : 'Configure a public HTTPS URL';
    }
    return { mode: settings.remoteMode, enabled: Boolean(settings.remoteEnabled), url, state, detail, error: this.error, lastChecked: this.lastChecked, vpnDetected: Boolean(this.vpnAddress()) };
  }

  async test() {
    const status = await this.status();
    if (!status.url) throw new Error('No remote URL is available to test');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20000);
    try {
      const response = await fetch(`${status.url.replace(/\/$/, '')}/api/health`, { signal: controller.signal, redirect: 'error', headers: { 'Cache-Control': 'no-cache' } });
      const data = await response.json();
      if (!response.ok || data.instanceId !== this.instanceId) throw new Error('The URL did not reach this Hearth server');
      this.lastChecked = new Date().toISOString();
      this.store.activity('info', 'Remote access health check passed', { mode: status.mode });
      return { ok: true, checkedAt: this.lastChecked, url: status.url };
    } catch (error) {
      this.lastChecked = new Date().toISOString();
      this.store.activity('warning', 'Remote access health check failed', { message: error.message });
      return { ok: false, checkedAt: this.lastChecked, message: error.message };
    } finally {
      clearTimeout(timer);
    }
  }

  async initialize() {
    const settings = this.store.settings();
    if (settings.remoteEnabled && settings.remoteMode === 'tunnel') {
      try { await this.startTunnel(); }
      catch (error) { this.state = 'error'; this.error = error.message; }
    }
  }
}

module.exports = { RemoteAccess };
