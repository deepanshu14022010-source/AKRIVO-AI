require("dotenv").config();

const fs = require("fs");
const path = require("path");
const express = require("express");
const cors = require("cors");
const Groq = require("groq-sdk");

const app = express();
const port = process.env.PORT || 3000;
const frontendDir = resolveFrontendDir();
const defaultModel = process.env.GROQ_MODEL || "llama-3.3-70b-versatile";
const maxHistoryMessages = 16;
const configuredMaxSearchResults = Number(process.env.MAX_SEARCH_RESULTS || 7);
const maxSearchResults = Number.isFinite(configuredMaxSearchResults)
  ? Math.min(Math.max(configuredMaxSearchResults, 3), 10)
  : 7;

if (!process.env.GROQ_API_KEY) {
  console.warn("Missing GROQ_API_KEY in .env. /chat will return an AI configuration error.");
}

const groq = new Groq({
  apiKey: process.env.GROQ_API_KEY
});

const conversations = new Map();

app.use(cors());
app.use(express.json({ limit: "1mb" }));
app.use(express.static(frontendDir, {
  setHeaders(res, filePath) {
    if (filePath.endsWith(".webmanifest")) {
      res.setHeader("Content-Type", "application/manifest+json; charset=utf-8");
    }
  }
}));

function cleanText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function resolveFrontendDir() {
  if (process.env.FRONTEND_DIR) {
    return path.resolve(process.env.FRONTEND_DIR);
  }

  const candidates = [
    path.resolve(__dirname, "../akrivoai"),
    path.resolve(__dirname, "public")
  ];

  return candidates.find((candidate) => fs.existsSync(path.join(candidate, "index.html"))) || candidates[0];
}

function clampHistory(messages) {
  return messages.slice(Math.max(0, messages.length - maxHistoryMessages));
}

function getSession(sessionId) {
  const safeSessionId = cleanText(sessionId).slice(0, 80) || "default";
  if (!conversations.has(safeSessionId)) {
    conversations.set(safeSessionId, []);
  }
  return {
    id: safeSessionId,
    messages: conversations.get(safeSessionId)
  };
}

function shouldSearchWeb(message, mode) {
  if (mode === "on") return true;
  if (mode === "off") return false;

  const text = message.toLowerCase();
  const currentYear = new Date().getFullYear();
  const timeSensitivePatterns = [
    /\b(today|tonight|yesterday|tomorrow|this week|this month|now|right now|as of|current|currently|latest|newest|recent|recently|live)\b/,
    /\b(news|headline|headlines|breaking|update|updates|released|launch|launched|announced|version|price|stock|crypto|weather)\b/,
    /\b(score|fixture|schedule|election|winner|won|result|results|ranking|rankings|happened|happening|status)\b/,
    /\b(search|google|web|internet|online)\b/,
    new RegExp(`\\b(${currentYear}|${currentYear - 1})\\b`)
  ];

  return timeSensitivePatterns.some((pattern) => pattern.test(text));
}

function looksNewsQuery(message) {
  return /\b(today|tonight|yesterday|this week|this month|latest|newest|recent|news|headline|headlines|update|updates|breaking|released|launched|announced|happened|happening|live|as of)\b/i.test(message);
}

function buildSearchQuery(message) {
  let query = cleanText(message);
  query = query.replace(/^(please\s+)?(search|google|look up|lookup|find|browse)(\s+(the\s+)?(web|internet|online|google))?(\s+for)?\s+/i, "");
  query = query.replace(/\s+\b(and\s+)?(answer|reply|respond|summarize|explain|tell me|give me|show me)\b[\s\S]*$/i, "");
  query = query.replace(/\s+\b(in|with)\s+(one|1|two|2|a)\s+(short\s+)?(sentence|paragraph|line|summary)[\s\S]*$/i, "");
  query = query.replace(/[?.!]+$/g, "");

  return cleanText(query).slice(0, 180) || cleanText(message).slice(0, 180);
}

function decodeHtml(value) {
  return cleanText(value)
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

function stripTags(value) {
  return decodeHtml(decodeHtml(value).replace(/<[^>]*>/g, " "));
}

function extractXmlTag(block, tagName) {
  const pattern = new RegExp(`<${tagName}[^>]*>([\\s\\S]*?)<\\/${tagName}>`, "i");
  const match = block.match(pattern);
  return match ? match[1].replace(/^<!\[CDATA\[/, "").replace(/\]\]>$/, "") : "";
}

function decodeDuckDuckGoUrl(rawUrl) {
  const decoded = decodeHtml(rawUrl);
  if (!decoded.includes("duckduckgo.com/l/")) return decoded;

  try {
    const url = new URL(decoded.startsWith("//") ? `https:${decoded}` : decoded);
    const target = url.searchParams.get("uddg");
    return target ? decodeURIComponent(target) : decoded;
  } catch {
    return decoded;
  }
}

async function fetchJson(url, timeoutMs = 9000) {
  const response = await fetch(url, {
    headers: {
      "Accept": "application/json",
      "User-Agent": "AkrivoAI/1.0"
    },
    signal: AbortSignal.timeout(timeoutMs)
  });

  if (!response.ok) {
    throw new Error(`Search request failed with ${response.status}`);
  }

  return response.json();
}

async function fetchText(url, timeoutMs = 9000) {
  const response = await fetch(url, {
    headers: {
      "Accept": "text/html",
      "User-Agent": "AkrivoAI/1.0"
    },
    signal: AbortSignal.timeout(timeoutMs)
  });

  if (!response.ok) {
    throw new Error(`Search request failed with ${response.status}`);
  }

  return response.text();
}

function normalizeResults(results, provider) {
  const seen = new Set();
  return results
    .map((result) => ({
      title: stripTags(result.title).slice(0, 140),
      link: cleanText(result.link),
      snippet: stripTags(result.snippet).slice(0, 260),
      provider
    }))
    .filter((result) => result.title && result.link)
    .filter((result) => {
      if (seen.has(result.link)) return false;
      seen.add(result.link);
      return true;
    })
    .slice(0, maxSearchResults);
}

async function searchWithGoogle(query) {
  const apiKey = process.env.GOOGLE_SEARCH_API_KEY;
  const searchEngineId = process.env.GOOGLE_SEARCH_ENGINE_ID;
  if (!apiKey || !searchEngineId) return [];

  const url = new URL("https://www.googleapis.com/customsearch/v1");
  url.searchParams.set("key", apiKey);
  url.searchParams.set("cx", searchEngineId);
  url.searchParams.set("q", query);
  url.searchParams.set("num", String(maxSearchResults));

  const data = await fetchJson(url);
  return normalizeResults(
    (data.items || []).map((item) => ({
      title: item.title,
      link: item.link,
      snippet: item.snippet
    })),
    "Google"
  );
}

async function searchWithGoogleNews(query) {
  const url = new URL("https://news.google.com/rss/search");
  url.searchParams.set("q", query);
  url.searchParams.set("hl", "en-US");
  url.searchParams.set("gl", "US");
  url.searchParams.set("ceid", "US:en");

  const xml = await fetchText(url);
  const items = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/gi)].map((match) => match[1]);
  return normalizeResults(
    items.map((item) => ({
      title: extractXmlTag(item, "title"),
      link: extractXmlTag(item, "link"),
      snippet: extractXmlTag(item, "description")
    })),
    "Google News"
  );
}

async function searchWithGdelt(query) {
  const url = new URL("https://api.gdeltproject.org/api/v2/doc/doc");
  url.searchParams.set("query", query);
  url.searchParams.set("mode", "ArtList");
  url.searchParams.set("format", "json");
  url.searchParams.set("maxrecords", String(maxSearchResults));
  url.searchParams.set("sort", "HybridRel");

  const data = await fetchJson(url);
  return normalizeResults(
    (data.articles || []).map((article) => ({
      title: article.title,
      link: article.url,
      snippet: [
        article.sourceCommonName,
        article.seendate ? `Seen ${article.seendate}` : ""
      ].filter(Boolean).join(" - ")
    })),
    "GDELT News"
  );
}

async function searchWithWikipedia(query) {
  const url = new URL("https://en.wikipedia.org/w/api.php");
  url.searchParams.set("action", "query");
  url.searchParams.set("list", "search");
  url.searchParams.set("srsearch", query);
  url.searchParams.set("format", "json");
  url.searchParams.set("srlimit", String(Math.min(maxSearchResults, 5)));

  const data = await fetchJson(url);
  return normalizeResults(
    (data.query?.search || []).map((item) => ({
      title: item.title,
      link: `https://en.wikipedia.org/wiki/${encodeURIComponent(item.title.replace(/\s+/g, "_"))}`,
      snippet: item.snippet
    })),
    "Wikipedia"
  );
}

async function searchWithDuckDuckGo(query) {
  const instantUrl = new URL("https://api.duckduckgo.com/");
  instantUrl.searchParams.set("q", query);
  instantUrl.searchParams.set("format", "json");
  instantUrl.searchParams.set("no_html", "1");
  instantUrl.searchParams.set("no_redirect", "1");

  const instant = await fetchJson(instantUrl);
  const instantResults = [];

  if (instant.AbstractURL && instant.AbstractText) {
    instantResults.push({
      title: instant.Heading || query,
      link: instant.AbstractURL,
      snippet: instant.AbstractText
    });
  }

  function collectRelated(topics) {
    for (const topic of topics || []) {
      if (instantResults.length >= maxSearchResults) return;
      if (topic.FirstURL && topic.Text) {
        instantResults.push({
          title: topic.Text.split(" - ")[0],
          link: topic.FirstURL,
          snippet: topic.Text
        });
      }
      if (topic.Topics) collectRelated(topic.Topics);
    }
  }

  collectRelated(instant.RelatedTopics);

  if (instantResults.length >= 3) {
    return normalizeResults(instantResults, "DuckDuckGo");
  }

  const htmlUrl = new URL("https://html.duckduckgo.com/html/");
  htmlUrl.searchParams.set("q", query);
  const html = await fetchText(htmlUrl);
  const blocks = html.match(/<div class="result results_links[\s\S]*?<\/div>\s*<\/div>/g) || [];
  const htmlResults = blocks.map((block) => {
    const linkMatch = block.match(/class="result__a" href="([^"]+)"[\s\S]*?>([\s\S]*?)<\/a>/);
    const snippetMatch = block.match(/class="result__snippet"[\s\S]*?>([\s\S]*?)<\/a>|class="result__snippet"[\s\S]*?>([\s\S]*?)<\/div>/);
    return {
      title: linkMatch ? linkMatch[2] : "",
      link: linkMatch ? decodeDuckDuckGoUrl(linkMatch[1]) : "",
      snippet: snippetMatch ? snippetMatch[1] || snippetMatch[2] : ""
    };
  });

  return normalizeResults([...instantResults, ...htmlResults], "DuckDuckGo");
}

async function runSearchProvider(name, searchFn, query) {
  try {
    return await searchFn(query);
  } catch (error) {
    console.warn(`${name} search failed:`, error.message);
    return [];
  }
}

function mergeSearchResults(resultGroups) {
  const seen = new Set();
  return resultGroups
    .flat()
    .filter((result) => {
      const key = result.link.replace(/\/$/, "");
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, maxSearchResults);
}

function describeSearchProviders(results) {
  const providers = [...new Set(results.map((result) => result.provider).filter(Boolean))];
  return providers.length ? providers.join(", ") : "none";
}

async function searchWeb(query) {
  const safeQuery = cleanText(query).slice(0, 240);
  if (!safeQuery) return { results: [], provider: "none" };

  const providers = [];

  if (process.env.GOOGLE_SEARCH_API_KEY && process.env.GOOGLE_SEARCH_ENGINE_ID) {
    providers.push(["Google", searchWithGoogle]);
  }

  if (looksNewsQuery(safeQuery)) {
    providers.push(["Google News", searchWithGoogleNews], ["GDELT News", searchWithGdelt]);
  }

  providers.push(["DuckDuckGo", searchWithDuckDuckGo], ["Wikipedia", searchWithWikipedia]);

  const resultGroups = await Promise.all(
    providers.map(([name, searchFn]) => runSearchProvider(name, searchFn, safeQuery))
  );
  const results = mergeSearchResults(resultGroups);

  return {
    results,
    provider: describeSearchProviders(results)
  };
}

function buildSearchContext(results) {
  return results
    .map((result, index) => {
      return `[${index + 1}] ${result.title} (${result.provider})\nURL: ${result.link}\nSnippet: ${result.snippet}`;
    })
    .join("\n\n");
}

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    groqConfigured: Boolean(process.env.GROQ_API_KEY),
    googleSearchConfigured: Boolean(process.env.GOOGLE_SEARCH_API_KEY && process.env.GOOGLE_SEARCH_ENGINE_ID),
    freeSearchProviders: ["DuckDuckGo", "Google News RSS", "GDELT News", "Wikipedia"],
    defaultModel
  });
});

app.post("/chat", async (req, res) => {
  const message = cleanText(req.body.message);
  const model = cleanText(req.body.model) || defaultModel;
  const searchMode = cleanText(req.body.searchMode || "auto").toLowerCase();

  if (!message) {
    return res.status(400).json({ reply: "Please type a message first." });
  }

  if (!process.env.GROQ_API_KEY) {
    return res.status(500).json({ reply: "Groq API key is missing on the backend." });
  }

  const session = getSession(req.body.sessionId);
  let sources = [];
  let searchProvider = null;
  let searchNote = null;

  try {
    if (shouldSearchWeb(message, searchMode)) {
      try {
        const search = await searchWeb(buildSearchQuery(message));
        sources = search.results;
        searchProvider = search.provider;
        if (!sources.length) {
          searchNote = "I tried live search, but no useful web results came back.";
        }
      } catch (searchError) {
        searchNote = "Live search was unavailable, so I answered from the AI model only.";
        console.warn("WEB SEARCH ERROR:", searchError.message);
      }
    }

    const messages = [
      {
        role: "system",
        content: [
          "You are AKRIVO AI, an advanced assistant created by Deepanshu.",
          `Current date: ${new Date().toISOString().slice(0, 10)}.`,
          "Answer directly and plainly. Do not sugarcoat, overpraise, add filler, or dodge the hard part of the answer.",
          "If web search results are provided, use them for fresh/current facts and cite them with [1], [2], etc.",
          "If the user asks about current events and no search results are provided, say your information may be outdated.",
          "If the web results are weak or unrelated, say that briefly instead of pretending.",
          "Do not claim you browsed or checked live sources unless live web results are actually provided.",
          "For coding, explain practical steps and give working examples when useful."
        ].join(" ")
      },
      ...clampHistory(session.messages)
    ];

    if (sources.length) {
      messages.push({
        role: "system",
        content: `Live web results for the user's latest message:\n\n${buildSearchContext(sources)}`
      });
    }

    messages.push({ role: "user", content: message });

    const completion = await groq.chat.completions.create({
      messages,
      model,
      temperature: 0.55,
      max_tokens: 1200
    });

    const reply = completion.choices?.[0]?.message?.content || "I could not generate a reply.";

    session.messages.push({ role: "user", content: message });
    session.messages.push({ role: "assistant", content: reply });
    conversations.set(session.id, clampHistory(session.messages));

    res.json({
      reply,
      usedSearch: sources.length > 0,
      searchProvider,
      searchNote,
      sources
    });
  } catch (error) {
    console.error("AI ERROR:", error);
    res.status(500).json({
      reply: "AI connection failed. Please check the backend console and API settings."
    });
  }
});

app.listen(port, () => {
  console.log(`AKRIVO backend running on http://localhost:${port}`);
  console.log(`Serving frontend from ${frontendDir}`);
});
