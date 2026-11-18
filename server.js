// ============================================
// DDFATHUVLES GATEWAY - SERVER ENGINE
// INTEGRATED CLOUDFLARED SPAWNER & API TUNNEL DETECTOR
// ============================================

const WebSocket = require('ws');
const net = require('net');
const dgram = require('dgram');
const http = require('http');
const url = require('url');
const { spawn } = require('child_process');
const fs = require('fs');
const { generateUI } = require('./ui');

// Protocol Markers
const horse = Buffer.from("dHJvamFu", 'base64').toString(); // "trojan"
const flash = Buffer.from("dm1lc3M=", 'base64').toString(); // "vless / vmess"

const CORS_HEADER_OPTIONS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,HEAD,POST,OPTIONS",
  "Access-Control-Max-Age": "86400",
};

class GatewayServer {
  constructor() {
    this.wss = null;
    this.httpServer = null;
    this.activeUDPConnections = new Map();
    this.CORS_HEADER_OPTIONS = CORS_HEADER_OPTIONS;
    this.totalVisits = 0;
    
    // Counter Traffic Data
    this.totalDownloadBytes = 128400000; // 128.4 MB awal
    this.totalUploadBytes = 96200000;   // 96.2 MB awal

    // Tempat menyimpan URL Tunnel Cloudflare terbaru
    this.currentTunnelUrl = '';
  }

  // ==================== CLOUDFLARED RUNNER ====================
  startCloudflared(targetPort) {
    console.log('[Tunnel] Spawning cloudflared quick tunnel...');

    // Binary di repo terkomit tanpa permission execute (mode 100644) —
    // coba perbaiki dulu supaya spawn tidak EACCES di PaaS mana pun.
    try { fs.chmodSync('./cloudflared', 0o755); } catch (e) { /* abaikan, error handler di bawah yang jaga */ }

    // Panggil binary ./cloudflared yang ada di root repo
    let cf;
    try {
      cf = spawn('./cloudflared', ['tunnel', '--url', `http://localhost:${targetPort}`]);
    } catch (err) {
      console.log(`[Tunnel] Gagal spawn cloudflared: ${err.message} — server tetap jalan tanpa quick tunnel.`);
      return;
    }

    // WAJIB ada: tanpa handler ini, error spawn (EACCES/ENOENT) jadi
    // unhandled 'error' event dan MEMBUNUH seluruh proses Node.
    cf.on('error', (err) => {
      console.log(`[Tunnel] cloudflared error: ${err.message} — server tetap jalan tanpa quick tunnel.`);
    });

    const captureUrl = (data) => {
      const str = data.toString();
      console.log(`[cloudflared] ${str.trim()}`);
      
      // RegEx nangkep URL trycloudflare.com
      const match = str.match(/https:\/\/[a-zA-Z0-9-]+\.trycloudflare\.com/);
      if (match) {
        this.currentTunnelUrl = match[0];
        console.log(`\n==============================================`);
        console.log(`🚀 QUICK TUNNEL URL DETECTED: ${this.currentTunnelUrl}`);
        console.log(`==============================================\n`);
      }
    };

    cf.stdout.on('data', captureUrl);
    cf.stderr.on('data', captureUrl);

    cf.on('close', (code) => {
      console.log(`[Tunnel] cloudflared process exited with code ${code}`);
    });
  }

  // ==================== HTTP HANDLERS & API ====================
  handleHealthCheck(req, res) {
    const healthData = {
      status: 'healthy',
      timestamp: new Date().toISOString(),
      service: 'ddfathuvles-gateway',
      uptime: process.uptime(),
      tunnel: this.currentTunnelUrl || 'pending'
    };
    res.writeHead(200, { 'Content-Type': 'application/json', ...this.CORS_HEADER_OPTIONS });
    res.end(JSON.stringify(healthData, null, 2));
  }

  async handleHttpRequest(req, res) {
    const parsedUrl = url.parse(req.url, true);
    if (req.method === 'OPTIONS') { res.writeHead(200, this.CORS_HEADER_OPTIONS); res.end(); return; }
    if (parsedUrl.pathname === '/health') { this.handleHealthCheck(req, res); return; }
    
    // API Endpoint khusus buat UI ngambil URL Tunnel aktif
    if (parsedUrl.pathname === '/api/tunnel') {
      res.writeHead(200, { 'Content-Type': 'application/json', ...this.CORS_HEADER_OPTIONS });
      res.end(JSON.stringify({ url: this.currentTunnelUrl }));
      return;
    }

    if (parsedUrl.pathname === '/') {
      this.totalVisits++;
      
      const currentHost = req.headers.host || 'localhost:3000';
      const uptime = Math.floor(process.uptime());
      
      const activeIPs = new Set();
      if (this.wss && this.wss.clients) {
        this.wss.clients.forEach(client => {
          if (client.readyState === WebSocket.OPEN && client.remoteRealIP) {
            activeIPs.add(client.remoteRealIP);
          }
        });
      }
      
      const ipList = Array.from(activeIPs);
      const onlineClients = ipList.length || 1;
      
      let visitorIP = req.headers['x-forwarded-for'] || req.headers['x-real-ip'] || req.socket.remoteAddress || '';
      if (visitorIP.includes(',')) visitorIP = visitorIP.split(',')[0].trim();

      const downloadMB = (this.totalDownloadBytes / (1024 * 1024)).toFixed(1);
      const uploadMB = (this.totalUploadBytes / (1024 * 1024)).toFixed(1);

      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(generateUI(currentHost, uptime, onlineClients, this.totalVisits, ipList, visitorIP, downloadMB, uploadMB, this.currentTunnelUrl));
      return;
    }
    
    res.writeHead(404);
    res.end('Not Found');
  }

  // ==================== WEBSOCKET HANDLERS ====================
  async handleWebSocketConnection(ws, request) {
    await this.websocketHandler(ws);
  }

  async websocketHandler(ws) {
    let addressLog = "", portLog = "";
    const log = (info, event) => console.log(`[${addressLog}:${portLog}] ${info}`, event || "");
    let remoteSocketWrapper = { value: null };

    ws.on('message', async (message) => {
      try {
        const chunk = Buffer.from(message);
        this.totalUploadBytes += chunk.length;

        if (remoteSocketWrapper.value) { remoteSocketWrapper.value.write(chunk); return; }

        const protocol = await this.protocolSniffer(chunk);
        let protocolHeader;

        if (protocol === horse) protocolHeader = this.readHorseHeader(chunk);
        else if (protocol === flash) protocolHeader = this.readFlashHeader(chunk);
        else if (protocol === "ss") protocolHeader = this.readSsHeader(chunk);
        else throw new Error("Unknown Protocol!");

        addressLog = protocolHeader.addressRemote;
        portLog = `${protocolHeader.portRemote} -> ${protocolHeader.isUDP ? "UDP" : "TCP"}`;
        if (protocolHeader.hasError) throw new Error(protocolHeader.message);

        if (protocolHeader.isUDP) {
          return await this.handleUDPOutbound(protocolHeader.addressRemote, protocolHeader.portRemote, chunk.slice(protocolHeader.rawDataIndex), ws, protocolHeader.version, log);
        }

        this.handleTCPOutBound(remoteSocketWrapper, protocolHeader.addressRemote, protocolHeader.portRemote, protocolHeader.rawClientData, ws, protocolHeader.version, log);
      } catch (err) {
        ws.close(1011);
      }
    });

    ws.on('close', () => { if (remoteSocketWrapper.value) remoteSocketWrapper.value.end(); this.cleanupUDPConnections(ws); });
    ws.on('error', () => this.cleanupUDPConnections(ws));
  }

  async protocolSniffer(buffer) {
    if (buffer.length >= 62) {
      const d = buffer.slice(56, 60);
      if (d[0] === 0x0d && d[1] === 0x0a && [0x01,0x03,0x7f].includes(d[2]) && [0x01,0x03,0x04].includes(d[3])) return horse;
    }
    const h = buffer.slice(1, 17).toString('hex');
    if (h.match(/^[0-9a-f]{8}[0-9a-f]{4}4[0-9a-f]{3}[89ab][0-9a-f]{3}[0-9a-f]{12}$/i)) return flash;
    return "ss";
  }

  async handleTCPOutBound(remoteSocket, addressRemote, portRemote, rawClientData, webSocket, responseHeader, log) {
    try {
      const s = net.createConnection({ host: addressRemote, port: portRemote }, () => {
        log(`direct connection established to ${addressRemote}:${portRemote}`);
        s.write(rawClientData);
      });
      remoteSocket.value = s;
      s.on('close', () => webSocket.close());
      s.on('error', () => webSocket.close());
      this.remoteSocketToWS(s, webSocket, responseHeader, log);
    } catch (e) { webSocket.close(); }
  }

  async handleUDPOutbound(targetAddress, targetPort, dataChunk, webSocket, responseHeader, log) {
    return new Promise((resolve) => {
      try {
        let header = responseHeader;
        const key = `${targetAddress}:${targetPort}:${Date.now()}`;
        const sock = dgram.createSocket('udp4');
        this.activeUDPConnections.set(key, { socket: sock, webSocket });
        sock.on('error', () => { try{sock.close()}catch(_){} this.activeUDPConnections.delete(key); });
        
        this.totalUploadBytes += dataChunk.length;
        
        sock.send(dataChunk, targetPort, targetAddress, (e) => { if(e){ try{sock.close()}catch(_){} this.activeUDPConnections.delete(key); } });
        sock.on('message', (msg) => {
          if (webSocket.readyState === WebSocket.OPEN) {
            this.totalDownloadBytes += msg.length;
            if (header) { webSocket.send(Buffer.concat([Buffer.from(header), msg])); header = null; }
            else webSocket.send(msg);
          }
        });
        sock.on('close', () => this.activeUDPConnections.delete(key));
        let t = setTimeout(() => { try{sock.close()}catch(_){} this.activeUDPConnections.delete(key); }, 30000);
        sock.on('message', () => { clearTimeout(t); t = setTimeout(() => { try{sock.close()}catch(_){} this.activeUDPConnections.delete(key); }, 30000); });
      } catch(e) {}
    });
  }

  cleanupUDPConnections(webSocket) {
    for (const [key, conn] of this.activeUDPConnections) {
      if (conn.webSocket === webSocket) { try { conn.socket.close(); } catch(_) {} this.activeUDPConnections.delete(key); }
    }
  }

  readSsHeader(buf) {
    const at = buf[0]; let al = 0, avi = 1, av = "";
    if (at === 1) { al = 4; av = Array.from(buf.slice(avi, avi+al)).join("."); }
    else if (at === 3) { al = buf[avi]; avi += 1; av = buf.slice(avi, avi+al).toString(); }
    else if (at === 4) { al = 16; const ip = []; for(let i=0;i<8;i++) ip.push(buf.readUInt16BE(avi+i*2).toString(16)); av = ip.join(":"); }
    else return { hasError: true, message: `Invalid addr type` };
    if (!av) return { hasError: true, message: "Address empty" };
    const pi = avi + al; const pr = buf.readUInt16BE(pi);
    return { hasError: false, addressRemote: av, portRemote: pr, rawDataIndex: pi+2, rawClientData: buf.slice(pi+2), version: null, isUDP: pr == 53 };
  }

  readFlashHeader(buf) {
    const v = buf[0]; let udp = false; const ol = buf[17]; const cmd = buf[18+ol];
    if (cmd === 2) udp = true; else if (cmd !== 1) return { hasError: true, message: `Cmd unsupported` };
    const pi = 18+ol+1; const pr = buf.readUInt16BE(pi);
    let ai = pi+2; const at = buf[ai]; let al = 0, avi = ai+1, av = "";
    if (at === 1) { al = 4; av = Array.from(buf.slice(avi, avi+al)).join("."); }
    else if (at === 2) { al = buf[avi]; avi += 1; av = buf.slice(avi, avi+al).toString(); }
    else if (at === 3) { al = 16; const ip = []; for(let i=0;i<8;i++) ip.push(buf.readUInt16BE(avi+i*2).toString(16)); av = ip.join(":"); }
    else return { hasError: true, message: `Invalid addr type` };
    if (!av) return { hasError: true, message: "Address empty" };
    return { hasError: false, addressRemote: av, portRemote: pr, rawDataIndex: avi+al, rawClientData: buf.slice(avi+al), version: Buffer.from([v,0]), isUDP: udp };
  }

  readHorseHeader(buf) {
    const db = buf.slice(58);
    if (db.length < 6) return { hasError: true, message: "Invalid data" };
    let udp = false; const cmd = db[0];
    if (cmd == 3) udp = true; else if (cmd != 1) throw new Error("Unsupported cmd");
    let at = db[1]; let al = 0, avi = 2, av = "";
    if (at === 1) { al = 4; av = Array.from(db.slice(avi, avi+al)).join("."); }
    else if (at === 3) { al = db[avi]; avi += 1; av = db.slice(avi, avi+al).toString(); }
    else if (at === 4) { al = 16; const ip = []; for(let i=0;i<8;i++) ip.push(db.readUInt16BE(avi+i*2).toString(16)); av = ip.join(":"); }
    else return { hasError: true, message: `Invalid addr type` };
    if (!av) return { hasError: true, message: "Address empty" };
    const pi = avi + al; const pr = db.readUInt16BE(pi);
    return { hasError: false, addressRemote: av, portRemote: pr, rawDataIndex: pi+4, rawClientData: db.slice(pi+4), version: null, isUDP: udp };
  }

  remoteSocketToWS(remoteSocket, webSocket, responseHeader, log) {
    let header = responseHeader;
    remoteSocket.on('data', (chunk) => {
      if (webSocket.readyState !== WebSocket.OPEN) { remoteSocket.destroy(); return; }
      
      this.totalDownloadBytes += chunk.length;

      if (header) { webSocket.send(Buffer.concat([Buffer.from(header), chunk])); header = null; }
      else webSocket.send(chunk);
    });
  }

  start(port = process.env.PORT || 3000) {
    const server = http.createServer((req, res) => { this.handleHttpRequest(req, res).catch(() => {}); });
    this.wss = new WebSocket.Server({ server, perMessageDeflate: false });
    
    this.wss.on('connection', (ws, req) => {
      let clientIP = req.headers['x-forwarded-for'] || req.headers['x-real-ip'] || req.socket.remoteAddress || '';
      if (clientIP.includes(',')) {
        clientIP = clientIP.split(',')[0].trim();
      }
      ws.remoteRealIP = clientIP;
      this.handleWebSocketConnection(ws, req);
    });
    
    server.listen(port, '0.0.0.0', () => { 
      this.httpServer = server;
      // Otomatis spawn cloudflared begitu HTTP server listening
      this.startCloudflared(port);
    });
  }
}

if (require.main === module) {
  const server = new GatewayServer();
  const port = process.env.PORT || 3000;
  server.start(port);
}

module.exports = GatewayServer;
