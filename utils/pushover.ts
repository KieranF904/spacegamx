/**
 * Pushover Notification CLI
 * Usage: npx tsx pushover.ts "Your message" ["Optional title"]
 * Or import and use sendNotification() directly
 */

const PUSHOVER_API = 'https://api.pushover.net/1/messages.json';
const API_TOKEN = 'avv6t8wub1yiw7xmtexvoaqa35q7qa';
const USER_KEY = 'u9neodyiqh5d7enuwz4i6a8or82e5s';

export interface PushoverOptions {
  message: string;
  title?: string;
  priority?: -2 | -1 | 0 | 1 | 2; // -2 lowest, 2 emergency
  sound?: string;
  url?: string;
  urlTitle?: string;
}

export async function sendNotification(options: PushoverOptions): Promise<boolean> {
  const { message, title, priority = 0, sound, url, urlTitle } = options;

  const body = new URLSearchParams({
    token: API_TOKEN,
    user: USER_KEY,
    message,
    ...(title && { title }),
    ...(priority !== undefined && { priority: priority.toString() }),
    ...(sound && { sound }),
    ...(url && { url }),
    ...(urlTitle && { url_title: urlTitle }),
  });

  try {
    const response = await fetch(PUSHOVER_API, {
      method: 'POST',
      body,
    });

    const result = await response.json();
    
    if (result.status === 1) {
      console.log('✅ Notification sent successfully');
      return true;
    } else {
      console.error('❌ Failed to send notification:', result.errors);
      return false;
    }
  } catch (error) {
    console.error('❌ Error sending notification:', error);
    return false;
  }
}

// Convenience functions for common notifications
export const notify = {
  taskComplete: (task: string) => sendNotification({
    message: `Task completed: ${task}`,
    title: '✅ Copilot - Task Done',
    priority: 0,
  }),

  needsInput: (question: string) => sendNotification({
    message: question,
    title: '❓ Copilot - Input Needed',
    priority: 1,
  }),

  error: (error: string) => sendNotification({
    message: error,
    title: '❌ Copilot - Error',
    priority: 1,
  }),

  info: (info: string) => sendNotification({
    message: info,
    title: 'ℹ️ Copilot - Info',
    priority: -1,
  }),

  custom: (message: string, title?: string) => sendNotification({
    message,
    title: title || '🤖 Copilot',
  }),
};

// CLI mode
if (process.argv[1]?.includes('pushover')) {
  const args = process.argv.slice(2);
  
  if (args.length === 0) {
    console.log(`
Pushover Notification CLI
Usage: npx tsx pushover.ts <message> [title]

Examples:
  npx tsx pushover.ts "Task complete!"
  npx tsx pushover.ts "Build failed" "Error"
`);
    process.exit(0);
  }

  const message = args[0];
  const title = args[1] || '🤖 Copilot';

  sendNotification({ message, title }).then((success) => {
    // Give time for cleanup to avoid Windows assertion error
    setTimeout(() => process.exit(success ? 0 : 1), 100);
  });
}
