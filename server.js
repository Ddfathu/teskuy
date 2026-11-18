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
const { EventEmitter } = require('events');
const { generateUI } = require('./ui');

// Protocol Markers
const horse = Buffer.from("dHJvamFu", 'base64').toString(); // "trojan"
const flash = Buffer.from("dm1lc3M=", 'base64').toString(); // "vless / vmess"

const CORS_HEADER_OPTIONS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,HEAD,POST,OPTIONS",
  "Access-Control-Max-Age": "86400",
};

// ==================== HTTPUPGRADE RAW STREAM ADAPTER ====================
// HTTPUpgrade (h2up) bukan WebSocket beneran: handshake 101 tanpa
// Sec-WebSocket-Key, habis itu data jalan sebagai raw TCP stream tanpa
// frame WS. Adapter ini membungkus socket mentah itu supaya terlihat
// seperti koneksi `ws` di mata handler gateway yang sudah ada
// (on('message'|'close'|'error'), send(), close(), readyState).
class RawStreamAdapter extends EventEmitter {
  constructor(socket) {
    super();
    this.socket = socket;
    this.readyState = 1; // WebSocket.OPEN
    this.isRawStream = true;
    this.remoteRealIP = '';
    this._firstChunks = [];
    this._firstBytes = 0;
    this._firstFlushed = false;
    this._flushTimer = null;

    socket.on('data', (chunk) => {
      if (!this._firstFlushed) {
        // Chunk pertama ditahan sebentar: header protokol di stream mentah
        // bisa kepotong beberapa segmen TCP. Kumpulkan sampai >=128 byte
        // atau 30ms sejak byte pertama, baru lempar sebagai 'message'.
        this._firstChunks.push(chunk);
        this._firstBytes += chunk.length;
        if (!this._flushTimer) this._flushTimer = setTimeout(() => this._flushFirst(), 30);
        if (this._firstBytes >= 128) this._flushFirst();
        return;
      }
      this.emit('message', chunk);
    });
    socket.on('close', () => { this.readyState = 3; this.emit('close'); });
    socket.on('error', (err) => { this.readyState = 3; this.emit('error', err); });
  }

  _flushFirst() {
    if (this._firstFlushed) return;
    this._firstFlushed = true;
    if (this._flushTimer) { clearTimeout(this._flushTimer); this._flushTimer = null; }
    if (this._firstChunks.length) {
      const buf = Buffer.concat(this._firstChunks);
      this._firstChunks = [];
      this.emit('message', buf);
    }
  }

  send(data) {
    if (this.readyState === 1 && !this.socket.destroyed) {
      try { this.socket.write(data); } catch (_) {}
    }
  }

  close() {
    this.readyState = 3;
    try { this.socket.end(); } catch (_) {}
    try { this.socket.destroy(); } catch (_) {}
  }
}

class GatewayServer {
  constructor() {
    this.wss = null;
    this.rawClients = new Set();
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
      if (this.rawClients) {
        this.rawClients.forEach(client => {
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

    // State khusus stream mentah (HTTPUpgrade): sesi UDP berjalan di atas
    // stream, paketnya dibingkai prefix panjang 2 byte (khusus VLESS).
    let rawUdpSession = null;
    let rawUdpBuf = Buffer.alloc(0);
    const drainRawUdpFrames = () => {
      while (rawUdpBuf.length >= 2) {
        const len = rawUdpBuf.readUInt16BE(0);
        if (rawUdpBuf.length < 2 + len) break;
        const packet = rawUdpBuf.slice(2, 2 + len);
        rawUdpBuf = rawUdpBuf.slice(2 + len);
        rawUdpSession.send(packet);
      }
    };

    const processChunk = async (message) => {
      try {
        const chunk = Buffer.from(message);
        this.totalUploadBytes += chunk.length;

        // Stream mentah yang sesinya UDP: semua byte lanjutan milik sesi UDP.
        if (rawUdpSession) {
          if (rawUdpSession.framed) {
            rawUdpBuf = Buffer.concat([rawUdpBuf, chunk]);
            drainRawUdpFrames();
          } else {
            rawUdpSession.send(chunk);
          }
          return;
        }

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
          if (ws.isRawStream) {
            rawUdpSession = await this.handleRawUDPOutbound(ws, protocolHeader, log, protocol === flash);
            const rest = protocolHeader.rawClientData;
            if (rest && rest.length) {
              if (rawUdpSession.framed) {
                rawUdpBuf = Buffer.concat([rawUdpBuf, Buffer.from(rest)]);
                drainRawUdpFrames();
              } else {
                rawUdpSession.send(Buffer.from(rest));
              }
            }
            return;
          }
          return await this.handleUDPOutbound(protocolHeader.addressRemote, protocolHeader.portRemote, chunk.slice(protocolHeader.rawDataIndex), ws, protocolHeader.version, log);
        }

        this.handleTCPOutBound(remoteSocketWrapper, protocolHeader.addressRemote, protocolHeader.portRemote, protocolHeader.rawClientData, ws, protocolHeader.version, log);
      } catch (err) {
        ws.close(1011);
      }
    };

    if (ws.isRawStream) {
      // Stream mentah wajib serial: chunk tidak boleh diproses paralel,
      // urutan byte menentukan posisi header dan frame UDP.
      let chain = Promise.resolve();
      ws.on('message', (message) => { chain = chain.then(() => processChunk(message)).catch(() => {}); });
    } else {
      ws.on('message', processChunk);
    }

    ws.on('close', () => { if (remoteSocketWrapper.value) remoteSocketWrapper.value.end(); this.cleanupUDPConnections(ws); });
    ws.on('error', () => this.cleanupUDPConnections(ws));
  }

  // UDP di atas stream mentah (HTTPUpgrade): satu socket UDP per sesi ke
  // target dari header pertama. VLESS dibingkai prefix 2 byte dua arah;
  // protokol lain diteruskan mentah seperti jalur WS.
  async handleRawUDPOutbound(webSocket, protocolHeader, log, framed) {
    const targetAddress = protocolHeader.addressRemote;
    const targetPort = protocolHeader.portRemote;
    const sock = dgram.createSocket('udp4');
    const key = `raw:${targetAddress}:${targetPort}:${Date.now()}`;
    this.activeUDPConnections.set(key, { socket: sock, webSocket });

    let header = protocolHeader.version;
    const session = {
      framed: !!framed,
      send: (packet) => {
        try { sock.send(packet, targetPort, targetAddress, () => {}); } catch (_) {}
      }
    };

    let idleTimer = null;
    const armIdleTimer = () => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => { try { sock.close(); } catch (_) {} }, 30000);
    };
    armIdleTimer();

    sock.on('message', (msg) => {
      armIdleTimer();
      if (webSocket.readyState !== WebSocket.OPEN) return;
      this.totalDownloadBytes += msg.length;
      let out = msg;
      if (session.framed) {
        const lenBuf = Buffer.alloc(2);
        lenBuf.writeUInt16BE(msg.length, 0);
        out = Buffer.concat([lenBuf, msg]);
      }
      if (header) { webSocket.send(Buffer.concat([Buffer.from(header), out])); header = null; }
      else webSocket.send(out);
    });
    sock.on('error', () => { try { sock.close(); } catch (_) {} this.activeUDPConnections.delete(key); });
    sock.on('close', () => { if (idleTimer) clearTimeout(idleTimer); this.activeUDPConnections.delete(key); });

    log(`raw UDP session to ${targetAddress}:${targetPort} (framed=${session.framed})`);
    return session;
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
    this.wss = new WebSocket.Server({ noServer: true, perMessageDeflate: false });

    this.wss.on('connection', (ws, req) => {
      let clientIP = req.headers['x-forwarded-for'] || req.headers['x-real-ip'] || req.socket.remoteAddress || '';
      if (clientIP.includes(',')) {
        clientIP = clientIP.split(',')[0].trim();
      }
      ws.remoteRealIP = clientIP;
      this.handleWebSocketConnection(ws, req);
    });

    // Routing upgrade manual: request DENGAN Sec-WebSocket-Key = WebSocket
    // beneran (diteruskan ke library ws); TANPA key = HTTPUpgrade (h2up),
    // handshake 101 dibalas sendiri lalu socket jalan sebagai raw stream.
    server.on('upgrade', (req, socket, head) => {
      const upgradeHeader = (req.headers.upgrade || '').toLowerCase();
      if (upgradeHeader !== 'websocket') { try { socket.destroy(); } catch (_) {} return; }

      if (req.headers['sec-websocket-key']) {
        this.wss.handleUpgrade(req, socket, head, (ws) => this.wss.emit('connection', ws, req));
        return;
      }

      try {
        socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n');
      } catch (_) { try { socket.destroy(); } catch (__) {} return; }

      const adapter = new RawStreamAdapter(socket);
      let clientIP = req.headers['x-forwarded-for'] || req.headers['x-real-ip'] || req.socket.remoteAddress || '';
      if (clientIP.includes(',')) {
        clientIP = clientIP.split(',')[0].trim();
      }
      adapter.remoteRealIP = clientIP;
      this.rawClients.add(adapter);
      adapter.on('close', () => this.rawClients.delete(adapter));
      if (head && head.length) { try { socket.unshift(head); } catch (_) {} }
      this.handleWebSocketConnection(adapter, req);
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
