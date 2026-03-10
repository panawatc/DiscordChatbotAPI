import { Client, Events, GatewayIntentBits, Message } from "discord.js";
import OpenAI from "openai";
import "dotenv/config";

const discord = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

const ai = new OpenAI({
  apiKey: process.env.YOUR_API_KEY,
  baseURL: "https://gen.ai.kku.ac.th/api/v1",
});

const MODEL = process.env.AI_MODEL || "claude-sonnet-4.6";

// Per-channel conversation history
type ChatMessage = { role: "system" | "user" | "assistant"; content: string };
const history = new Map<string, ChatMessage[]>();

discord.once(Events.ClientReady, (c) => {
  console.log(`Logged in as ${c.user.tag}`);
  console.log(`Using model: ${MODEL}`);
});

discord.on(Events.MessageCreate, async (message: Message) => {
  // Ignore bots and messages that don't mention the bot
  if (message.author.bot) return;
  if (!message.mentions.has(discord.user!)) return;

  // Strip the mention from the message
  const userText = message.content.replace(/<@!?\d+>/g, "").trim();
  if (!userText) return;

  const channelId = message.channelId;
  if (!history.has(channelId)) history.set(channelId, []);
  const messages = history.get(channelId)!;

  messages.push({ role: "user", content: userText });

  try {
    if ("sendTyping" in message.channel) {
      await message.channel.sendTyping();
    }

    const response = await ai.chat.completions.create({
      model: MODEL,
      max_tokens: 1024,
      messages: [
        { role: "system", content: "You are a helpful Discord bot assistant. Keep responses concise." },
        ...messages,
      ],
    });

    const reply = response.choices[0]?.message?.content || "No response.";

    messages.push({ role: "assistant", content: reply });

    // Keep history at 20 messages max to avoid token overflow
    if (messages.length > 20) messages.splice(0, messages.length - 20);

    // Discord has a 2000 char limit
    if (reply.length > 2000) {
      for (let i = 0; i < reply.length; i += 2000) {
        await message.reply(reply.slice(i, i + 2000));
      }
    } else {
      await message.reply(reply);
    }
  } catch (err) {
    console.error("API error:", err);
    await message.reply("Sorry, something went wrong.");
  }
});

discord.login(process.env.DISCORD_TOKEN);
