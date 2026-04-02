import { Client, Events, GatewayIntentBits, Message } from "discord.js";
import OpenAI from "openai";
import "dotenv/config";
import { MemoryManager } from "./memory";
import { MusicPlayer } from "./music";
import { detectAndFetchRealtimeData } from "./realtime";

const discord = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildVoiceStates,
  ],
});

const ai = new OpenAI({
  apiKey: process.env.YOUR_API_KEY,
  baseURL: "https://gen.ai.kku.ac.th/api/v1",
});

const MODEL = process.env.AI_MODEL || "claude-sonnet-4.6";
const memory = new MemoryManager(ai, MODEL);
const music = new MusicPlayer();

const SYSTEM_PROMPT = `You are JJin's Bot v2, a general-purpose Discord assistant created by JJin.

## Personality
- You are funny, playful, and cool — like a chill friend who happens to know everything
- You use casual, relaxed language. Never stiff or overly formal
- You can joke around, use light sarcasm, and be witty — but never rude
- You use Discord-style expressions naturally (lol, ngl, fr, tbh, etc.)
- You can use emojis occasionally but don't overdo it

## Language
- Respond in both English and Thai depending on what the user writes
- If the user writes in Thai → reply in Thai
- If the user writes in English → reply in English
- If mixed → match the dominant language
- Always keep the same chill, funny tone in both languages

## Behavior
- Answer anything the user asks — no topic is off limits as long as it's not harmful
- Keep responses concise and easy to read in Discord (avoid giant walls of text)
- If you don't know something, admit it casually — don't fake it
- You are version 2, meaning you are smarter and cooler than before
- When you receive [Real-time data], use it to answer accurately — don't guess
- When you see an image, describe and analyze it naturally

## Commands users can use
- Music: \`!play\`, \`!stop\`, \`!skip\`, \`!queue\`, \`!pause\`, \`!resume\`, \`!leave\`, \`!np\`
- Real-time data: just ask naturally (e.g. "ดูดวงราศีเมษ", "ราคาหุ้น AAPL", "ข่าว AI")

## Identity
- Your name is JJin's Bot v2
- You were made by JJin
- If someone asks what AI powers you, just say you're JJin's Bot — you don't reveal the underlying model`;

discord.once(Events.ClientReady, (c) => {
  console.log(`✅ Logged in as ${c.user.tag}`);
  console.log(`🤖 Using model: ${MODEL}`);
});

discord.on(Events.MessageCreate, async (message: Message) => {
  if (message.author.bot) return;

  // Music commands (!play, !stop, etc.)
  if (message.content.startsWith("!")) {
    await handleMusicCommand(message);
    return;
  }

  // AI chat — requires @mention
  if (!message.mentions.has(discord.user!)) return;

  const userText = message.content.replace(/<@!?\d+>/g, "").trim();

  // Collect image attachments
  const imageUrls = message.attachments
    .filter((a) => a.contentType?.startsWith("image/"))
    .map((a) => a.url);

  if (!userText && imageUrls.length === 0) return;

  const channelId = message.channelId;
  const messages = memory.getMessages(channelId);

  // Build content — vision if images attached, otherwise text (+ real-time data)
  type TextPart = { type: "text"; text: string };
  type ImagePart = { type: "image_url"; image_url: { url: string } };

  let userContent: string | Array<TextPart | ImagePart>;

  if (imageUrls.length > 0) {
    userContent = [
      { type: "text", text: userText || "อธิบายรูปนี้ให้ฟังหน่อยนะ" },
      ...imageUrls.map((url): ImagePart => ({
        type: "image_url",
        image_url: { url },
      })),
    ];
  } else {
    const realtimeContext = await detectAndFetchRealtimeData(userText);
    userContent = realtimeContext
      ? `${userText}\n\n[Real-time data]:\n${realtimeContext}`
      : userText;
  }

  messages.push({ role: "user", content: userContent });

  try {
    if ("sendTyping" in message.channel) {
      await message.channel.sendTyping();
    }

    // Build system prompt, injecting memory summary if available
    const summary = memory.getSummary(channelId);
    const systemContent = summary
      ? `${SYSTEM_PROMPT}\n\n---\n**ความทรงจำจากบทสนทนาก่อนหน้า:**\n${summary}`
      : SYSTEM_PROMPT;

    const response = await ai.chat.completions.create({
      model: MODEL,
      max_tokens: 1024,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      messages: [{ role: "system", content: systemContent }, ...(messages as any)],
    });

    const reply = response.choices[0]?.message?.content || "No response.";
    messages.push({ role: "assistant", content: reply });

    // Compress old messages into a summary if history is long
    await memory.maybeCompress(channelId);

    // Discord 2000 char limit
    if (reply.length > 2000) {
      for (let i = 0; i < reply.length; i += 2000) {
        await message.reply(reply.slice(i, i + 2000));
      }
    } else {
      await message.reply(reply);
    }
  } catch (err) {
    console.error("API error:", err);
    await message.reply("Sorry, something went wrong. 😅");
  }
});

async function handleMusicCommand(message: Message): Promise<void> {
  const args = message.content.slice(1).trim().split(/\s+/);
  const command = args.shift()?.toLowerCase();

  switch (command) {
    case "play": {
      const query = args.join(" ");
      if (!query) {
        await message.reply(
          "บอกชื่อเพลงหรือ URL ด้วยนะ! เช่น `!play never gonna give you up`"
        );
        return;
      }
      await music.play(message, query);
      break;
    }
    case "stop": {
      const stopped = music.stop(message.guildId!);
      await message.reply(stopped ? "⏹️ หยุดแล้ว ออกจาก VC แล้ว" : "ไม่ได้เล่นอยู่นะ 🤔");
      break;
    }
    case "skip": {
      const skipped = music.skip(message.guildId!);
      await message.reply(skipped ? "⏭️ ข้ามแล้ว!" : "ไม่มีเพลงที่กำลังเล่นอยู่");
      break;
    }
    case "queue":
    case "q": {
      const { current, queue } = music.getQueue(message.guildId!);
      if (!current && !queue.length) {
        await message.reply("Queue ว่างเปล่าเลย 🎵");
        return;
      }
      let text = current ? `🎵 **กำลังเล่น:** ${current.title}\n\n` : "";
      if (queue.length) {
        text += "**คิวถัดไป:**\n";
        text += queue
          .slice(0, 10)
          .map((item, i) => `${i + 1}. ${item.title}`)
          .join("\n");
        if (queue.length > 10) text += `\n... และอีก ${queue.length - 10} เพลง`;
      }
      await message.reply(text);
      break;
    }
    case "pause": {
      const paused = music.pause(message.guildId!);
      await message.reply(paused ? "⏸️ หยุดชั่วคราวแล้ว" : "ไม่ได้เล่นอยู่นะ");
      break;
    }
    case "resume": {
      const resumed = music.resume(message.guildId!);
      await message.reply(resumed ? "▶️ เล่นต่อแล้ว!" : "ไม่ได้หยุดอยู่นะ");
      break;
    }
    case "leave": {
      const left = music.leave(message.guildId!);
      await message.reply(left ? "👋 บายแล้ว~" : "ไม่ได้อยู่ใน VC นะ");
      break;
    }
    case "np":
    case "nowplaying": {
      const { current } = music.getQueue(message.guildId!);
      await message.reply(
        current
          ? `🎵 กำลังเล่น: **${current.title}**`
          : "ไม่มีเพลงที่กำลังเล่นอยู่"
      );
      break;
    }
  }
}

discord.login(process.env.DISCORD_TOKEN);
