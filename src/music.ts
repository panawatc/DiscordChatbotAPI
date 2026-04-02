import {
  AudioPlayer,
  AudioPlayerStatus,
  VoiceConnection,
  VoiceConnectionStatus,
  createAudioPlayer,
  createAudioResource,
  entersState,
  joinVoiceChannel,
} from "@discordjs/voice";
import play from "play-dl";
import { Message, TextChannel } from "discord.js";

interface QueueItem {
  url: string;
  title: string;
  requester: string;
}

interface GuildQueue {
  connection: VoiceConnection;
  player: AudioPlayer;
  queue: QueueItem[];
  current: QueueItem | null;
  textChannel: TextChannel;
}

export class MusicPlayer {
  private queues = new Map<string, GuildQueue>();

  async play(message: Message, query: string): Promise<void> {
    const member = message.member;
    const voiceChannel = member?.voice?.channel;

    if (!voiceChannel) {
      await message.reply("เข้า VC ก่อนนะ! 🎵");
      return;
    }

    const guildId = message.guildId!;

    // Resolve URL and title
    let url: string;
    let title: string;

    try {
      if (query.startsWith("http")) {
        const info = await play.video_info(query);
        url = query;
        title = info.video_details.title ?? "Unknown";
      } else {
        const results = await play.search(query, { limit: 1 });
        if (!results.length) {
          await message.reply("ไม่เจอเพลงนี้เลย 😅");
          return;
        }
        url = results[0].url;
        title = results[0].title ?? "Unknown";
      }
    } catch {
      await message.reply("หาเพลงไม่เจอ หรือ URL ผิด 🤔");
      return;
    }

    const item: QueueItem = { url, title, requester: message.author.username };

    let guildQueue = this.queues.get(guildId);

    if (!guildQueue) {
      const connection = joinVoiceChannel({
        channelId: voiceChannel.id,
        guildId,
        adapterCreator: voiceChannel.guild.voiceAdapterCreator,
      });

      const player = createAudioPlayer();
      connection.subscribe(player);

      guildQueue = {
        connection,
        player,
        queue: [],
        current: null,
        textChannel: message.channel as TextChannel,
      };

      this.queues.set(guildId, guildQueue);

      player.on(AudioPlayerStatus.Idle, () => {
        this.playNext(guildId);
      });

      player.on("error", (err) => {
        console.error("Player error:", err.message);
        this.playNext(guildId);
      });

      // Auto-reconnect on disconnect
      connection.on(VoiceConnectionStatus.Disconnected, async () => {
        try {
          await Promise.race([
            entersState(connection, VoiceConnectionStatus.Signalling, 5_000),
            entersState(connection, VoiceConnectionStatus.Connecting, 5_000),
          ]);
        } catch {
          this.queues.delete(guildId);
          connection.destroy();
        }
      });
    }

    guildQueue.queue.push(item);

    if (guildQueue.current === null) {
      await this.playNext(guildId);
      await message.reply(`🎵 กำลังเล่น: **${title}**`);
    } else {
      await message.reply(
        `➕ เพิ่มในคิว: **${title}** (ตำแหน่ง ${guildQueue.queue.length})`
      );
    }
  }

  private async playNext(guildId: string): Promise<void> {
    const guildQueue = this.queues.get(guildId);
    if (!guildQueue) return;

    if (!guildQueue.queue.length) {
      guildQueue.current = null;
      guildQueue.textChannel
        .send("🎵 Queue ว่างแล้ว! เพิ่มเพลงด้วย `!play <ชื่อเพลง>`")
        .catch(() => {});
      return;
    }

    const item = guildQueue.queue.shift()!;
    guildQueue.current = item;

    try {
      const stream = await play.stream(item.url);
      const resource = createAudioResource(stream.stream, {
        inputType: stream.type,
      });
      guildQueue.player.play(resource);
      guildQueue.textChannel
        .send(`🎵 กำลังเล่น: **${item.title}** (requested by ${item.requester})`)
        .catch(() => {});
    } catch (err) {
      console.error("Stream error:", err);
      guildQueue.textChannel
        .send(`❌ เล่นไม่ได้: **${item.title}** — ข้ามไปเพลงถัดไป`)
        .catch(() => {});
      this.playNext(guildId);
    }
  }

  stop(guildId: string): boolean {
    const guildQueue = this.queues.get(guildId);
    if (!guildQueue) return false;
    guildQueue.queue = [];
    guildQueue.current = null;
    guildQueue.player.stop(true);
    guildQueue.connection.destroy();
    this.queues.delete(guildId);
    return true;
  }

  skip(guildId: string): boolean {
    const guildQueue = this.queues.get(guildId);
    if (!guildQueue?.current) return false;
    guildQueue.player.stop(); // triggers Idle → playNext
    return true;
  }

  pause(guildId: string): boolean {
    return this.queues.get(guildId)?.player.pause() ?? false;
  }

  resume(guildId: string): boolean {
    return this.queues.get(guildId)?.player.unpause() ?? false;
  }

  leave(guildId: string): boolean {
    return this.stop(guildId);
  }

  getQueue(guildId: string): { current: QueueItem | null; queue: QueueItem[] } {
    const guildQueue = this.queues.get(guildId);
    if (!guildQueue) return { current: null, queue: [] };
    return { current: guildQueue.current, queue: [...guildQueue.queue] };
  }
}
