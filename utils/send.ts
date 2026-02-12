/**
 * Send a message to the messenger app from CLI
 * Usage: npx tsx send.ts "Your message here"
 * 
 * This sends a message via HTTP POST to the running messenger server,
 * which then broadcasts to connected WebSocket clients immediately.
 */

const PORT = 3001;
const message = process.argv[2];

if (!message) {
  console.log('Usage: npx tsx send.ts "Your message"');
  process.exit(1);
}

async function sendMessage(text: string): Promise<boolean> {
  try {
    const response = await fetch(`http://localhost:${PORT}/api/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, from: 'copilot' }),
    });

    if (response.ok) {
      console.log(`✅ Message sent: "${text}"`);
      return true;
    } else {
      console.error('❌ Failed to send message:', await response.text());
      return false;
    }
  } catch (error) {
    console.error('❌ Error: Is the messenger server running? (npx tsx notify.ts)');
    return false;
  }
}

sendMessage(message).then((success) => {
  setTimeout(() => process.exit(success ? 0 : 1), 100);
});
