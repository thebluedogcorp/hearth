# Remote access guide

Hearth is reachable on your home network out of the box. Anything beyond that is opt-in and explained here, weakest-assumption first.

## 1. Home network (default)

During setup, choose visibility **Home network and remote** (bind `0.0.0.0`). The dashboard's **Network** page lists your machine's LAN addresses, e.g. `http://192.168.1.20:7341`. Open that from any phone, tablet, laptop or TV browser on the same network and sign in.

Keep the default port (7341) or change it in the wizard/panel — if you change it, the server restarts automatically and the panel follows.

## 2. Tailscale (recommended for away-from-home)

If the [Tailscale](https://tailscale.com) client is installed and signed in on the server machine, Hearth detects it and shows your tailnet address (`http://100.x.y.z:7341`). Install Tailscale on your remote devices, sign into the same tailnet, and the server works as if you were home — encrypted by WireGuard, no ports opened on your router.

This is the best security/effort trade-off and the recommended way to watch your library on the go.

## 3. Cloudflare Tunnel (public HTTPS URL)

Hearth bundles `cloudflared`. In the panel's **Network** page (or the setup wizard's remote section), enable **Cloudflare quick tunnel**:

- A quick tunnel gives you a random `https://<something>.trycloudflare.com` URL — zero configuration, no Cloudflare account needed. Treat the URL as a bearer token: anyone who has it can reach your sign-in page.
- For a stable URL you need a Cloudflare account and a domain; run cloudflared with your own config and set Hearth's **reverse-proxy mode** (below) with that public URL.

How it works internally: Hearth launches the bundled `cloudflared.exe` with `--url http://127.0.0.1:<port>`, reads the generated URL from its output, and displays/health-checks it. Sessions over the tunnel use the same hardened cookies (`Secure` is automatic on HTTPS).

## 4. Reverse proxy / your own domain

For self-hosters with existing infrastructure: terminate TLS at your proxy (nginx, Caddy, Cloudflare) and forward to `127.0.0.1:7341`. In Hearth set remote mode **proxy** and enter the public HTTPS URL — the server uses it for absolute links and health checks.

Example Caddyfile:

```caddy
media.example.com {
    reverse_proxy 127.0.0.1:7341
}
```

## What to expose, what not to

- **Never** port-forward 7341 directly on your router without HTTPS; browser sessions would travel unencrypted.
- If you only stream at home, leave remote mode **off** — nothing is exposed.
- Downloads and folder ZIP respect per-user permissions; guest-level access doesn't exist. Create restricted accounts (allowed libraries + download permission toggles) in **Users**.

## Troubleshooting

| Symptom | Likely cause / fix |
|---|---|
| Other devices get connection refused | Server bound to `127.0.0.1` — switch visibility to home network in the panel, restart server |
| Tunnel URL dead after reboot | Quick tunnels are ephemeral; re-enable it, or use your own named tunnel |
| Works at home, not away | Confirm Tailscale is connected on both devices, or re-open the quick tunnel |
| Health check shows unreachable | The tunnel/proxy URL must be `https://` with no path or credentials |
