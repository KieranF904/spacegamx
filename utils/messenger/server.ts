/**
 * Messenger Server - Bidirectional communication between Copilot and mobile
 * 
 * Features:
 * - Web interface accessible from phone
 * - Real-time WebSocket updates
 * - Message history
 * - Pushover notifications for new messages
 */

import express from 'express';
import { WebSocketServer, WebSocket } from 'ws';
import { createServer } from 'http';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { sendNotification } from '../pushover.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const PORT = 3001;
const MESSAGES_FILE = join(__dirname, 'messages.json');

interface Message {
  id: string;
  from: 'copilot' | 'user';
  text: string;
  timestamp: number;
  read: boolean;
}

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

let messages = loadMessages();
const clients = new Set<WebSocket>();

// Express app
const app = express();
app.use(express.json());

// Serve static files
app.get('/', (_req, res) => {
  res.sendFile(join(__dirname, 'index.html'));
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

  // If message is from user, we received input
  if (from === 'user') {
    console.log(`\n📱 User message: ${text}\n`);
  }

  res.json(message);
});

app.post('/api/messages/read', (req, res) => {
  messages = messages.map((m) => ({ ...m, read: true }));
  saveMessages(messages);
  res.json({ success: true });
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

  // Send current messages
  ws.send(JSON.stringify({ type: 'init', messages }));

  ws.on('close', () => {
    clients.delete(ws);
    console.log('📱 Client disconnected');
  });

  ws.on('message', (data) => {
    try {
      const parsed = JSON.parse(data.toString());
      if (parsed.type === 'user_message') {
        // Handle incoming user message
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

        // Broadcast to all clients
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

// Function to send a message from Copilot (used programmatically)
export async function sendMessageToUser(text: string, notifyPush = true): Promise<Message> {
  const message: Message = {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2),
    from: 'copilot',
    text,
    timestamp: Date.now(),
    read: false,
  };

  messages.push(message);
  saveMessages(messages);

  // Broadcast to WebSocket clients
  const broadcast = JSON.stringify({ type: 'new_message', message });
  clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(broadcast);
    }
  });

  // Send push notification
  if (notifyPush) {
    await sendNotification({
      message: text,
      title: '🤖 Copilot',
      url: `http://YOUR_LOCAL_IP:${PORT}`,
      urlTitle: 'Open Messenger',
    });
  }

  return message;
}

// Function to wait for user input
export function waitForUserInput(timeoutMs = 300000): Promise<string | null> {
  return new Promise((resolve) => {
    const startMessages = messages.length;
    
    const checkInterval = setInterval(() => {
      const newMessages = messages.slice(startMessages).filter((m) => m.from === 'user');
      if (newMessages.length > 0) {
        clearInterval(checkInterval);
        clearTimeout(timeout);
        resolve(newMessages[newMessages.length - 1].text);
      }
    }, 500);

    const timeout = setTimeout(() => {
      clearInterval(checkInterval);
      resolve(null);
    }, timeoutMs);
  });
}

// Get local IP for mobile access
import { networkInterfaces } from 'os';

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

// Start server
server.listen(PORT, () => {
  const localIP = getLocalIP();

  console.log(`
╔══════════════════════════════════════════════════════════════╗
║             🤖 Copilot Messenger Server                      ║
╠══════════════════════════════════════════════════════════════╣
║                                                              ║
║  Local:   http://localhost:${PORT}                            ║
║  Mobile:  http://${localIP}:${PORT}                       ║
║                                                              ║
║  Open the Mobile URL on your phone to chat!                  ║
║                                                              ║
╚══════════════════════════════════════════════════════════════╝
`);
});

export { messages, PORT };
