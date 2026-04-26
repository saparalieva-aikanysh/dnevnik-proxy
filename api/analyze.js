// Vercel serverless function — proxy for Anthropic API
// Path: /api/analyze
// Forwards requests from frontend to Anthropic with API key from env vars.
// Locked to specific origins to prevent abuse.

const ALLOWED_ORIGINS = [
  // Add your domains here. Use "*" only for testing.
  "https://saparalieva-aikanysh.github.io",
  "http://localhost:3000",
  "http://localhost:8000",
];

export default async function handler(req, res) {
  // CORS
  const origin = req.headers.origin || "";
  const allowedOrigin = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  res.setHeader("Access-Control-Allow-Origin", allowedOrigin);
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  // Verify origin is allowed (extra check beyond CORS)
  if (origin && !ALLOWED_ORIGINS.includes(origin)) {
    return res.status(403).json({ error: "Origin not allowed" });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: "Server not configured" });
  }

  try {
    const { mode, payload } = req.body || {};

    if (!mode || !payload) {
      return res.status(400).json({ error: "Missing mode or payload" });
    }

    let messages;

    if (mode === "text") {
      // payload: { description: string }
      const description = String(payload.description || "").slice(0, 500);
      if (!description) return res.status(400).json({ error: "Empty description" });

      messages = [{
        role: "user",
        content: `Проанализируй описание еды и оцени калорийность и БЖУ для указанной порции.

Описание: "${description}"

Если порция не указана — предположи стандартную (одна штука / средняя порция). Учитывай типичные способы приготовления (масло при жарке и т.д.).

Верни ТОЛЬКО валидный JSON без markdown, без backticks, без преамбулы. Формат:
{"name":"краткое название блюда на русском","calories":число,"protein":число,"carbs":число,"fat":число,"confidence":"low"|"medium"|"high","notes":"1-2 предложения: что учтено в расчёте, что предположено, что мог упустить"}

confidence: high — простые продукты с указанным количеством (2 яйца, 100г творога); medium — блюдо с типичным размером порции; low — описание расплывчатое.`,
      }];
    } else if (mode === "image") {
      // payload: { base64: string, mediaType: string }
      const base64 = payload.base64;
      const mediaType = payload.mediaType || "image/jpeg";
      if (!base64) return res.status(400).json({ error: "No image data" });

      // Approx size check (base64 = ~1.33x bytes). Reject > 1.5MB.
      if (base64.length > 2_000_000) return res.status(413).json({ error: "Image too large" });

      messages = [{
        role: "user",
        content: [
          { type: "image", source: { type: "base64", media_type: mediaType, data: base64 } },
          { type: "text", text: `Проанализируй еду на фото. Оцени калорийность и БЖУ для всей видимой порции.

Верни ТОЛЬКО валидный JSON без markdown, без backticks, без преамбулы. Формат:
{"name":"краткое название блюда на русском","calories":число,"protein":число,"carbs":число,"fat":число,"confidence":"low"|"medium"|"high","notes":"1-2 предложения: что видно, оценка размера порции, риски недооценки (масло, соусы)"}

confidence: high — простое блюдо, всё видно; medium — типичное блюдо но порция оценена; low — суп, микс, скрытые ингредиенты.` },
        ],
      }];
    } else {
      return res.status(400).json({ error: "Unknown mode" });
    }

    const anthropicResp = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 600,
        messages,
      }),
    });

    if (!anthropicResp.ok) {
      const errorText = await anthropicResp.text();
      console.error("Anthropic API error:", anthropicResp.status, errorText);
      return res.status(502).json({ error: "Upstream API error" });
    }

    const data = await anthropicResp.json();
    const text = (data.content || []).filter(c => c.type === "text").map(c => c.text).join("");
    const cleaned = text.replace(/```json|```/g, "").trim();

    let parsed;
    try {
      parsed = JSON.parse(cleaned);
    } catch (e) {
      console.error("Failed to parse model output:", cleaned);
      return res.status(502).json({ error: "Could not parse response" });
    }

    return res.status(200).json(parsed);
  } catch (err) {
    console.error("Handler error:", err);
    return res.status(500).json({ error: "Internal error" });
  }
}
