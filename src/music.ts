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
import ytdl from "@distube/ytdl-core";
import YouTube from "youtube-sr";
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
  isAdvancing: boolean;
}

export class MusicPlayer {
  private queues = new Map<string, GuildQueue>();

  private extractVideoId(input: string): string | null {
    try {
      const parsed = new URL(input.trim());
      const host = parsed.hostname.replace(/^www\./, "").toLowerCase();

      if (host === "youtu.be") {
        const id = parsed.pathname.split("/").filter(Boolean)[0];
        return id || null;
      }

      if (host === "youtube.com" || host.endsWith(".youtube.com")) {
        const v = parsed.searchParams.get("v");
        if (v) return v;

        const pathParts = parsed.pathname.split("/").filter(Boolean);
        if (pathParts[0] === "shorts" && pathParts[1]) return pathParts[1];
        if (pathParts[0] === "embed" && pathParts[1]) return pathParts[1];
      }
    } catch {
      return null;
    }

    return null;
  }

  private toWatchUrl(videoId: string): string {
    return `https://www.youtube.com/watch?v=${videoId}`;
  }

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
        const idFromUrl = this.extractVideoId(query);
        if (idFromUrl) {
          url = this.toWatchUrl(idFromUrl);
          const info = await play.video_info(url);
          title = info.video_details.title ?? "Unknown";
        } else {
          const video = await YouTube.getVideo(query);
          const fallbackId = video?.id ?? this.extractVideoId(video?.url ?? "");
          if (!fallbackId) {
            throw new Error("Invalid video URL");
          }
          url = this.toWatchUrl(fallbackId);
          title = video?.title ?? "Unknown";
        }
      } else {
        const results = await YouTube.search(query, { limit: 1, type: "video" });
        if (!results.length) {
          await message.reply("ไม่เจอเพลงนี้เลย 😅");
          return;
        }

        const result = results[0];
        const resultId = result.id ?? this.extractVideoId(result.url ?? "");
        if (!resultId) {
          throw new Error("No video id from search result");
        }
        url = this.toWatchUrl(resultId);
        title = result.title ?? "Unknown";
      }

      if (!url || url.includes("undefined")) {
        throw new Error("Resolved URL is invalid");
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
        selfDeaf: true,
      });

      try {
        await entersState(connection, VoiceConnectionStatus.Ready, 20_000);
      } catch {
        connection.destroy();
        await message.reply("เชื่อมต่อห้องเสียงไม่สำเร็จ ลองใหม่อีกครั้งนะ 🙏");
        return;
      }

      const player = createAudioPlayer();
      connection.subscribe(player);

      guildQueue = {
        connection,
        player,
        queue: [],
        current: null,
        textChannel: message.channel as TextChannel,
        isAdvancing: false,
      };

      this.queues.set(guildId, guildQueue);

      player.on(AudioPlayerStatus.Idle, () => {
        void this.playNext(guildId);
      });

      player.on("error", (err) => {
        console.error("Player error:", err.message);
        void this.playNext(guildId);
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
    } else {
      await message.reply(
        `➕ เพิ่มในคิว: **${title}** (ตำแหน่ง ${guildQueue.queue.length})`
      );
    }
  }

  private async playNext(guildId: string): Promise<void> {
    const guildQueue = this.queues.get(guildId);
    if (!guildQueue) return;
    if (guildQueue.isAdvancing) return;

    guildQueue.isAdvancing = true;
    let item: QueueItem | null = null;

    try {
      if (!guildQueue.queue.length) {
        if (guildQueue.current !== null) {
          guildQueue.current = null;
          guildQueue.textChannel
            .send("🎵 Queue ว่างแล้ว! เพิ่มเพลงด้วย `!play <ชื่อเพลง>`")
            .catch(() => {});
        }
        return;
      }

      item = guildQueue.queue.shift()!;
      guildQueue.current = item;

      if (!item.url || item.url.includes("undefined")) {
        throw new Error("Queue item URL is invalid");
      }

      let resource;
      try {
        const info = await play.video_info(item.url);
        const stream = await play.stream_from_info(info);
        resource = createAudioResource(stream.stream, {
          inputType: stream.type,
        });
      } catch (primaryErr) {
        console.warn("Primary stream backend failed, trying fallback:", primaryErr);
        if (!ytdl.validateURL(item.url)) {
          throw primaryErr;
        }

        const fallbackStream = ytdl(item.url, {
          filter: "audioonly",
          quality: "highestaudio",
          highWaterMark: 1 << 25,
        });
        resource = createAudioResource(fallbackStream);
      }

      guildQueue.player.play(resource);

      await entersState(guildQueue.player, AudioPlayerStatus.Playing, 10_000);
      guildQueue.textChannel
        .send(`🎵 กำลังเล่น: **${item.title}** (requested by ${item.requester})`)
        .catch(() => {});
    } catch (err) {
      console.error("Stream error:", err);
      guildQueue.textChannel
        .send(
          `❌ เล่นไม่ได้: **${item?.title ?? "Unknown"}** — ข้ามไปเพลงถัดไป`
        )
        .catch(() => {});
      guildQueue.current = null;
      setTimeout(() => {
        void this.playNext(guildId);
      }, 0);
    } finally {
      guildQueue.isAdvancing = false;
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
