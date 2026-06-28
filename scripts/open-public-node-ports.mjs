// scripts/open-public-node-ports.mjs
// Bitcoin-style best-effort public TCP setup: discover UPnP IGD directly over SSDP/SOAP, try
// NAT-PMP against the default gateway, then verify whether public TCP actually accepts.
// This cannot bypass CGNAT, ISP blocks, disabled router mapping, or missing administrator firewall approval.
import dgram from "node:dgram";
import net from "node:net";
import os from "node:os";
import { mkdirSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { URL } from "node:url";

const args = process.argv.slice(2);
const has = (flag) => args.includes(flag);
const value = (name, fallback = "") => {
  const hit = args.find((arg) => arg.startsWith(`${name}=`));
  return hit ? hit.slice(name.length + 1) : fallback;
};

let ports = parsePorts(value("--ports", "9645,9646"));
if (has("--mainnet-mesh")) ports = [...ports, 9745, 9746, 9845, 9846, 9945, 9946];
ports = [...new Set(ports)].sort((a, b) => a - b);
const checkOnly = has("--check-only");
const publicHostArg = value("--public-host", "");
const outputPath = value("--output", process.env.ZIRA_PUBLIC_MAPPING_PATH || "local-private/public-port-mapping.json");

function parsePorts(raw) {
  return raw.split(",").map((p) => Number(p.trim())).filter((p) => Number.isInteger(p) && p > 0 && p < 65536);
}

function localIPv4() {
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family === "IPv4" && !entry.internal && !entry.address.startsWith("169.254.")) return entry.address;
    }
  }
  return "";
}

function defaultGateway() {
  try {
    if (process.platform === "win32") {
      const out = execFileSync("powershell", [
        "-NoProfile",
        "-Command",
        "(Get-NetIPConfiguration | Where-Object { $_.IPv4DefaultGateway } | Select-Object -First 1).IPv4DefaultGateway.NextHop",
      ], { encoding: "utf8", timeout: 5000 }).trim();
      if (/^\d{1,3}(\.\d{1,3}){3}$/.test(out)) return out;
    }
  } catch {}
  try {
    const out = execFileSync(process.platform === "win32" ? "route.exe" : "sh", process.platform === "win32" ? ["PRINT", "-4", "0.0.0.0"] : ["-c", "ip route show default"], { encoding: "utf8", timeout: 5000 });
    const match = out.match(/(?:default via|0\.0\.0\.0\s+0\.0\.0\.0)\s+(\d{1,3}(?:\.\d{1,3}){3})/);
    if (match) return match[1];
  } catch {}
  return "";
}

async function publicIPv4(fallback) {
  if (fallback) return fallback.trim();
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    const res = await fetch("https://api.ipify.org", { signal: controller.signal });
    clearTimeout(timeout);
    const ip = (await res.text()).trim();
    return /^\d{1,3}(\.\d{1,3}){3}$/.test(ip) ? ip : "";
  } catch {
    return "";
  }
}

function tcpReachable(host, port, timeoutMs = 2500) {
  return new Promise((resolve) => {
    if (!host) return resolve(false);
    const socket = net.connect({ host, port });
    const done = (ok) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
  });
}

function ssdpSearch(st, timeoutMs = 3200) {
  return new Promise((resolve) => {
    const socket = dgram.createSocket("udp4");
    const locations = new Set();
    const msg = Buffer.from([
      "M-SEARCH * HTTP/1.1",
      "HOST: 239.255.255.250:1900",
      'MAN: "ssdp:discover"',
      "MX: 2",
      `ST: ${st}`,
      "",
      "",
    ].join("\r\n"));
    const finish = () => {
      try { socket.close(); } catch {}
      resolve([...locations]);
    };
    socket.on("message", (buf) => {
      const text = buf.toString("utf8");
      const match = text.match(/^location:\s*(.+)$/im);
      if (match) locations.add(match[1].trim());
    });
    socket.bind(() => {
      try { socket.setBroadcast(true); } catch {}
      socket.send(msg, 1900, "239.255.255.250");
      setTimeout(finish, timeoutMs).unref?.();
    });
    socket.on("error", finish);
  });
}

function absoluteUrl(base, maybeRelative) {
  try { return new URL(maybeRelative, base).toString(); } catch { return ""; }
}

function extractService(xml) {
  const serviceRe = /<service>([\s\S]*?)<\/service>/gi;
  for (const match of xml.matchAll(serviceRe)) {
    const block = match[1];
    const serviceType = block.match(/<serviceType>\s*([^<]+)\s*<\/serviceType>/i)?.[1]?.trim() ?? "";
    if (!/WAN(IP|PPP)Connection:\d+/i.test(serviceType)) continue;
    const controlURL = block.match(/<controlURL>\s*([^<]+)\s*<\/controlURL>/i)?.[1]?.trim() ?? "";
    if (controlURL) return { serviceType, controlURL };
  }
  return null;
}

async function discoverUpnpGateway() {
  const searchTargets = [
    "urn:schemas-upnp-org:device:InternetGatewayDevice:1",
    "urn:schemas-upnp-org:service:WANIPConnection:1",
    "urn:schemas-upnp-org:service:WANPPPConnection:1",
  ];
  const locations = [...new Set((await Promise.all(searchTargets.map((st) => ssdpSearch(st)))).flat())];
  for (const location of locations) {
    try {
      const res = await fetch(location, { signal: AbortSignal.timeout(5000) });
      if (!res.ok) continue;
      const xml = await res.text();
      const svc = extractService(xml);
      if (!svc) continue;
      return { location, serviceType: svc.serviceType, controlURL: absoluteUrl(location, svc.controlURL) };
    } catch {}
  }
  return null;
}

async function addUpnpMapping(gateway, port, localIp) {
  if (!gateway?.controlURL || !localIp) return { ok: false, error: "UPnP IGD service not found" };
  const body = `<?xml version="1.0"?>
<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">
  <s:Body>
    <u:AddPortMapping xmlns:u="${gateway.serviceType}">
      <NewRemoteHost></NewRemoteHost>
      <NewExternalPort>${port}</NewExternalPort>
      <NewProtocol>TCP</NewProtocol>
      <NewInternalPort>${port}</NewInternalPort>
      <NewInternalClient>${localIp}</NewInternalClient>
      <NewEnabled>1</NewEnabled>
      <NewPortMappingDescription>ZIRA Core TCP ${port}</NewPortMappingDescription>
      <NewLeaseDuration>0</NewLeaseDuration>
    </u:AddPortMapping>
  </s:Body>
</s:Envelope>`;
  try {
    const res = await fetch(gateway.controlURL, {
      method: "POST",
      headers: {
        "content-type": "text/xml; charset=utf-8",
        soapaction: `"${gateway.serviceType}#AddPortMapping"`,
      },
      body,
      signal: AbortSignal.timeout(7000),
    });
    if (res.ok) return { ok: true };
    const text = await res.text().catch(() => "");
    return { ok: false, error: `UPnP SOAP HTTP ${res.status} ${text.slice(0, 120)}` };
  } catch (e) {
    return { ok: false, error: e.message || "UPnP SOAP failed" };
  }
}

function natPmpMap(gateway, port, lifetime = 7200) {
  return new Promise((resolve) => {
    if (!gateway) return resolve({ ok: false, error: "default gateway not found" });
    const socket = dgram.createSocket("udp4");
    const req = Buffer.alloc(12);
    req[0] = 0; // version
    req[1] = 2; // map TCP
    req.writeUInt16BE(port, 4); // internal port
    req.writeUInt16BE(port, 6); // requested external port
    req.writeUInt32BE(lifetime, 8);
    const finish = (result) => {
      try { socket.close(); } catch {}
      resolve(result);
    };
    socket.on("message", (buf) => {
      if (buf.length < 16 || buf[1] !== 130) return finish({ ok: false, error: "unexpected NAT-PMP response" });
      const code = buf.readUInt16BE(2);
      if (code !== 0) return finish({ ok: false, error: `NAT-PMP result code ${code}` });
      const externalPort = buf.readUInt16BE(10);
      finish({ ok: externalPort === port, externalPort });
    });
    socket.on("error", (e) => finish({ ok: false, error: e.message }));
    socket.send(req, 5351, gateway, (err) => {
      if (err) finish({ ok: false, error: err.message });
      else setTimeout(() => finish({ ok: false, error: "NAT-PMP timed out" }), 2500).unref?.();
    });
  });
}

const localIp = localIPv4();
const gatewayIp = defaultGateway();
const publicHost = await publicIPv4(publicHostArg);
const upnpGateway = checkOnly ? null : await discoverUpnpGateway();
const results = [];

for (const port of ports) {
  let mapped = false;
  let changed = false;
  const attempts = [];
  if (!checkOnly) {
    const upnp = await addUpnpMapping(upnpGateway, port, localIp);
    attempts.push({ method: "upnp-igd", ...upnp });
    if (upnp.ok) { mapped = true; changed = true; }
    if (!mapped) {
      const natpmp = await natPmpMap(gatewayIp, port);
      attempts.push({ method: "nat-pmp", ...natpmp });
      if (natpmp.ok) { mapped = true; changed = true; }
    }
  }
  const reachable = await tcpReachable(publicHost, port);
  results.push({
    port,
    localIp,
    gateway: gatewayIp,
    publicHost,
    upnpAvailable: Boolean(upnpGateway),
    mapped,
    changed,
    reachableFromHere: reachable,
    attempts,
  });
}

const ready = results.some((r) => r.reachableFromHere);
const mapped = results.some((r) => r.mapped);
const report = {
  ok: ready,
  mapped,
  publicHost,
  localIp,
  gateway: gatewayIp,
  ports,
  upnpAvailable: Boolean(upnpGateway),
  upnpGateway,
  results,
  note: ready
    ? "At least one public TCP port accepted a connection."
    : mapped
      ? "Router accepted public port mappings. This network may block hairpin checks; verify from outside before relying on the seed."
      : "Public TCP still did not accept. If UPnP/NAT-PMP failed, router forwarding, CGNAT removal, or a public VPS seed is required.",
};
if (!checkOnly && outputPath) {
  try {
    const out = resolve(outputPath);
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, JSON.stringify({ ...report, writtenAt: Date.now() }, null, 2) + "\n");
  } catch {}
}
console.log(JSON.stringify(report, null, 2));
