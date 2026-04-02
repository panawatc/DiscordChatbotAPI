// Real-time data fetchers: stocks, horoscope, news

export async function fetchStockPrice(symbol: string): Promise<string> {
  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol.toUpperCase()}?interval=1d&range=1d`;
    const res = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0" },
    });
    const data = (await res.json()) as {
      chart?: { result?: Array<{ meta?: Record<string, unknown> }> };
    };

    const meta = data?.chart?.result?.[0]?.meta as
      | Record<string, unknown>
      | undefined;
    if (!meta) return `ไม่เจอข้อมูลหุ้น ${symbol}`;

    const price = meta.regularMarketPrice as number;
    const changePct = (meta.regularMarketChangePercent as number)?.toFixed(2);
    const currency = meta.currency as string;
    const name = (meta.shortName as string) || symbol.toUpperCase();
    const sign = Number(changePct) >= 0 ? "+" : "";

    return `📈 **${name}** (${symbol.toUpperCase()})\nราคา: ${price} ${currency} (${sign}${changePct}%)`;
  } catch {
    return `❌ ดึงราคาหุ้น ${symbol} ไม่ได้`;
  }
}

const SIGN_MAP: Record<string, string> = {
  เมษ: "Aries",
  พฤษภ: "Taurus",
  มิถุน: "Gemini",
  กรกฎ: "Cancer",
  สิงห์: "Leo",
  "กันย์": "Virgo",
  "ตุลย์": "Libra",
  พิจิก: "Scorpio",
  ธนู: "Sagittarius",
  มังกร: "Capricorn",
  "กุมภ์": "Aquarius",
  มีน: "Pisces",
};

const ALL_SIGNS = [
  ...Object.keys(SIGN_MAP),
  "aries",
  "taurus",
  "gemini",
  "cancer",
  "leo",
  "virgo",
  "libra",
  "scorpio",
  "sagittarius",
  "capricorn",
  "aquarius",
  "pisces",
];

export async function fetchHoroscope(sign: string): Promise<string> {
  const englishSign = SIGN_MAP[sign] ?? sign;
  try {
    const res = await fetch(
      `https://horoscope-app-api.vercel.app/api/v1/get-horoscope/daily?sign=${englishSign}&day=today`
    );
    const data = (await res.json()) as { data?: { horoscope_data?: string } };

    if (data?.data?.horoscope_data) {
      return `🔮 **ดวง${sign || englishSign} วันนี้:**\n${data.data.horoscope_data}`;
    }
    return `❌ ดึงดวง ${sign} ไม่ได้`;
  } catch {
    return `❌ ดึงดวง ${sign} ไม่ได้`;
  }
}

export async function fetchNews(query: string): Promise<string> {
  const apiKey = process.env.NEWS_API_KEY;
  if (!apiKey) return "";

  try {
    const url = `https://newsapi.org/v2/everything?q=${encodeURIComponent(query)}&pageSize=3&sortBy=publishedAt&language=th&apiKey=${apiKey}`;
    const res = await fetch(url);
    const data = (await res.json()) as {
      articles?: Array<{ title: string; source: { name: string }; url: string }>;
    };

    if (data.articles?.length) {
      const lines = data.articles
        .slice(0, 3)
        .map((a) => `- ${a.title} (${a.source.name})`)
        .join("\n");
      return `📰 **ข่าวล่าสุดเกี่ยวกับ "${query}":**\n${lines}`;
    }
    return "";
  } catch {
    return "";
  }
}

// Detect what real-time data is needed and fetch it
export async function detectAndFetchRealtimeData(
  text: string
): Promise<string> {
  if (!text) return "";

  const lower = text.toLowerCase();
  const results: string[] = [];

  // Stock price detection — e.g. "ราคาหุ้น AAPL", "stock TSLA", "PTT หุ้น"
  const stockMatch = text.match(
    /(?:หุ้น|ราคาหุ้น|stock(?:\s+price)?(?:\s+of)?)\s*([A-Z]{1,5})/i
  );
  if (stockMatch) {
    results.push(await fetchStockPrice(stockMatch[1]));
  }

  // Horoscope detection — "ดูดวง", "ดวง", "horoscope" + sign name
  if (lower.includes("ดูดวง") || lower.includes("ดวง") || lower.includes("horoscope")) {
    for (const sign of ALL_SIGNS) {
      if (lower.includes(sign.toLowerCase())) {
        results.push(await fetchHoroscope(sign));
        break;
      }
    }
  }

  // News detection — "ข่าว X", "news about X"
  const newsMatch = text.match(/(?:ข่าว|news(?:\s+about)?)\s+(.+?)(?:\s*$|\?)/i);
  if (newsMatch) {
    const newsData = await fetchNews(newsMatch[1].trim());
    if (newsData) results.push(newsData);
  }

  return results.join("\n\n");
}
