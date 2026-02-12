/**
 * Copilot Communication Hub
 * 
 * Starts the messenger server and sends an initial status message + push notification.
 * 
 * Usage: npx tsx notify.ts "Status message describing work completed or input needed"
 */

import { sendNotification } from './pushover.js';
import { networkInterfaces } from 'os';
import express from 'express';
import { WebSocketServer, WebSocket } from 'ws';
import { createServer } from 'http';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { readFileSync, writeFileSync, existsSync, watch } from 'fs';

const __dirname = dirname(fileURLToPath(import.meta.url));

const PORT = 3001;
const MESSAGES_FILE = join(__dirname, 'messenger', 'messages.json');

interface Message {
  id: string;
  from: 'copilot' | 'user';
  text: string;
  timestamp: number;
  read: boolean;
}

// Get status message from command line
const statusMessage = process.argv[2] || 'Copilot is ready and waiting for instructions.';

// Load or initialize messages
function loadMessages(): Message[] {
  if (existsSync(MESSAGES_FILE)) {
    try {
      return JSON.parse(readFileSync(MESSAGES_FILE, 'utf-8'));
    } catch {
      return [];
    }
  }
  return [];
}

function saveMessages(messages: Message[]) {
  writeFileSync(MESSAGES_FILE, JSON.stringify(messages, null, 2));
}

function getLocalIP(): string {
  const nets = networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name] || []) {
      if (net.family === 'IPv4' && !net.internal) {
        return net.address;
      }
    }
  }
  return 'localhost';
}

let messages = loadMessages();
const clients = new Set<WebSocket>();

// Express app
const app = express();
app.use(express.json());

// Serve static files for PWA
app.get('/', (_req, res) => {
  res.sendFile(join(__dirname, 'messenger', 'index.html'));
});

app.get('/manifest.json', (_req, res) => {
  res.sendFile(join(__dirname, 'messenger', 'manifest.json'));
});

app.get('/sw.js', (_req, res) => {
  res.setHeader('Content-Type', 'application/javascript');
  res.sendFile(join(__dirname, 'messenger', 'sw.js'));
});

// Generate simple icon on the fly (colored square with robot emoji)
app.get('/icon-192.png', (_req, res) => {
  // Redirect to a simple generated icon or placeholder
  res.redirect('https://api.dicebear.com/7.x/bottts/png?seed=copilot&size=192&backgroundColor=6366f1');
});

app.get('/icon-512.png', (_req, res) => {
  res.redirect('https://api.dicebear.com/7.x/bottts/png?seed=copilot&size=512&backgroundColor=6366f1');
});

// API endpoints
app.get('/api/messages', (_req, res) => {
  res.json(messages);
});

app.post('/api/messages', async (req, res) => {
  const { text, from = 'user' } = req.body;
  
  if (!text) {
    return res.status(400).json({ error: 'Message text required' });
  }

  const message: Message = {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2),
    from,
    text,
    timestamp: Date.now(),
    read: false,
  };

  messages.push(message);
  saveMessages(messages);

  // Broadcast to all WebSocket clients
  const broadcast = JSON.stringify({ type: 'new_message', message });
  clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(broadcast);
    }
  });

  if (from === 'user') {
    console.log(`\n📱 User message: ${text}\n`);
  }

  res.json(message);
});

app.delete('/api/messages', (_req, res) => {
  messages = [];
  saveMessages(messages);
  res.json({ success: true });
});

// Create HTTP server
const server = createServer(app);

// WebSocket server
const wss = new WebSocketServer({ server });

wss.on('connection', (ws) => {
  clients.add(ws);
  console.log('📱 Client connected');

  ws.send(JSON.stringify({ type: 'init', messages }));

  ws.on('close', () => {
    clients.delete(ws);
    console.log('📱 Client disconnected');
  });

  ws.on('message', (data) => {
    try {
      const parsed = JSON.parse(data.toString());
      if (parsed.type === 'user_message') {
        const message: Message = {
          id: Date.now().toString(36) + Math.random().toString(36).slice(2),
          from: 'user',
          text: parsed.text,
          timestamp: Date.now(),
          read: false,
        };
        messages.push(message);
        saveMessages(messages);

        console.log(`\n📱 User message: ${parsed.text}\n`);

        const broadcast = JSON.stringify({ type: 'new_message', message });
        clients.forEach((client) => {
          if (client.readyState === WebSocket.OPEN) {
            client.send(broadcast);
          }
        });
      }
    } catch (e) {
      // Ignore parse errors
    }
  });
});

// Start server
server.listen(PORT, async () => {
  const localIP = getLocalIP();
  const mobileUrl = `http://${localIP}:${PORT}`;

  console.log(`
╔══════════════════════════════════════════════════════════════╗
║             🤖 Copilot Messenger Server (PWA)                ║
╠══════════════════════════════════════════════════════════════╣
║                                                              ║
║  Local:   http://localhost:${PORT}                            ║
║  Mobile:  ${mobileUrl.padEnd(45)}║
║                                                              ║
║  📱 Install as app on your phone for best experience!        ║
║                                                              ║
╚══════════════════════════════════════════════════════════════╝
`);

  // Clear old messages and add the new status message
  messages = [];
  
  const statusMsg: Message = {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2),
    from: 'copilot',
    text: statusMessage,
    timestamp: Date.now(),
    read: false,
  };
  
  messages.push(statusMsg);
  saveMessages(messages);

  // Watch for file changes (when Copilot edits messages.json directly)
  let lastModified = Date.now();
  watch(MESSAGES_FILE, (eventType) => {
    if (eventType === 'change') {
      // Debounce
      const now = Date.now();
      if (now - lastModified < 500) return;
      lastModified = now;
      
      try {
        const newMessages = JSON.parse(readFileSync(MESSAGES_FILE, 'utf-8'));
        if (JSON.stringify(newMessages) !== JSON.stringify(messages)) {
          messages = newMessages;
          console.log('📁 Messages file updated, broadcasting to clients...');
          const broadcast = JSON.stringify({ type: 'messages_updated', messages });
          clients.forEach((client) => {
            if (client.readyState === WebSocket.OPEN) {
              client.send(broadcast);
            }
          });
        }
      } catch (e) {
        // Ignore parse errors during file write
      }
    }
  });

  console.log(`📝 Status: ${statusMessage}\n`);
  console.log('⏳ Waiting for your response...\n');
  console.log('📁 Watching messages.json for changes...\n');

  // Send push notification
  await sendNotification({
    message: statusMessage,
    title: '🤖 Copilot',
    url: mobileUrl,
    urlTitle: 'Open Messenger',
  });
});
