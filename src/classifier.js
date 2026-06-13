import { logSystem } from './database.js';

export function classifyMessage(ctx) {
  const message = ctx.message;
  if (!message) return 'IGNORE';

  const botUsername = ctx.me?.username || '';
  const text = message.text || message.caption || '';
  const isPrivate = ctx.chat.type === 'private';
  
  // Check if bot is mentioned or replied to
  const isMentioned = text.includes(`@${botUsername}`);
  const isRepliedToBot = message.reply_to_message?.from?.id === ctx.me.id;
  const isDirectlyAddressed = isPrivate || isMentioned || isRepliedToBot;

  // 1. Check for Vision (Photos, Documents, Media)
  const hasPhoto = !!(message.photo || message.document && message.document.mime_type?.startsWith('image/'));
  if (hasPhoto) {
    if (isDirectlyAddressed) {
      logSystem('CLASSIFIER', 'Classified: VISION (Direct)');
      return 'VISION';
    }
    // If it's not directly addressed but contains an image, we still tag it as vision-capable but check if we ignore
    logSystem('CLASSIFIER', 'Classified: IGNORE (Image without address)');
    return 'IGNORE';
  }

  // 2. Check for Telegram Commands (Moderation / Admin Tools)
  const isCommand = text.startsWith('/');
  if (isCommand && isDirectlyAddressed) {
    const command = text.split(' ')[0].toLowerCase();
    const moderationCommands = ['/ban', '/mute', '/unmute', '/kick', '/pin', '/unpin', '/warn', '/delete'];
    if (moderationCommands.some(cmd => command.startsWith(cmd))) {
      logSystem('CLASSIFIER', 'Classified: TOOL (Telegram Command)');
      return 'TOOL';
    }
  }

  // 3. If the bot is not directly addressed, we ignore it for immediate replies.
  // (Note: The observation system still logs it to DB, but the bot won't process a response loop).
  if (!isDirectlyAddressed) {
    return 'IGNORE';
  }

  // 4. Check for Search keywords
  const searchKeywords = [
    'search', 'web search', 'google', 'find on web', 'latest news', 'news about',
    'search the web', 'look up', 'جستجو', 'گوگل', 'خبر جدید'
  ];
  const lowerText = text.toLowerCase();
  if (searchKeywords.some(keyword => lowerText.includes(keyword))) {
    logSystem('CLASSIFIER', 'Classified: SEARCH');
    return 'SEARCH';
  }

  // 5. Check for Memory keywords
  const memoryKeywords = [
    'remember', 'forget', 'my name is', 'i like', 'i work', 'save to profile',
    'یادت بمونه', 'فراموش کن', 'اسم من', 'علاقه دارم'
  ];
  if (memoryKeywords.some(keyword => lowerText.includes(keyword))) {
    logSystem('CLASSIFIER', 'Classified: MEMORY');
    return 'MEMORY';
  }

  // 6. Default direct address is CHAT
  logSystem('CLASSIFIER', 'Classified: CHAT');
  return 'CHAT';
}
