/**
 * ntfy.sh push notifications
 */

const NTFY_BASE = 'https://ntfy.sh';

export interface NotifyOptions {
  topic: string;
  title: string;
  message: string;
  tags?: string[];
  priority?: 'min' | 'low' | 'default' | 'high' | 'urgent';
  click?: string; // URL to open when notification is clicked
}

export async function sendNotification(options: NotifyOptions): Promise<void> {
  const { topic, title, message, tags, priority, click } = options;

  console.log(`[notify] Sending to topic: ${topic}`);

  const headers: Record<string, string> = {
    Title: title,
  };

  if (tags?.length) {
    headers.Tags = tags.join(',');
  }

  if (priority) {
    headers.Priority = priority;
  }

  if (click) {
    headers.Click = click;
  }

  const response = await fetch(`${NTFY_BASE}/${topic}`, {
    method: 'POST',
    headers,
    body: message,
  });

  if (!response.ok) {
    throw new Error(`ntfy.sh error: ${response.status} ${await response.text()}`);
  }

  console.log('[notify] Notification sent');
}

export async function notifySuccess(
  topic: string,
  recipeName: string,
  sourceUrl: string
): Promise<void> {
  await sendNotification({
    topic,
    title: 'Recipe Added',
    message: `"${recipeName}" has been added to AnyList`,
    tags: ['white_check_mark', 'cook'],
    click: sourceUrl,
  });
}

export async function notifyError(
  topic: string,
  errorMessage: string,
  sourceUrl?: string
): Promise<void> {
  const message = sourceUrl
    ? `${errorMessage}\n\n${sourceUrl}`
    : errorMessage;
  await sendNotification({
    topic,
    title: 'Recipe Error',
    message,
    tags: ['x', 'warning'],
    priority: 'high',
    click: sourceUrl,
  });
}

export async function notifyNotRecipe(
  topic: string,
  reason: string,
  sourceUrl: string
): Promise<void> {
  await sendNotification({
    topic,
    title: 'Not a Recipe',
    message: reason,
    tags: ['shrug'],
    click: sourceUrl,
  });
}
