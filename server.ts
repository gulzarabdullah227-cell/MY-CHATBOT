import "dotenv/config";
import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { GoogleGenAI, ThinkingLevel } from "@google/genai";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const SYSTEM_INSTRUCTION =
  "Tum AskAbdullah ho — Abdullah ke personal chatbot. Abdullah 21 saal ka hai aur SZABIST mein parhta hai. User English, Urdu (اردو) ya Roman Urdu mein likhe to usi zubaan aur usi script mein jawab do. Agar zubaan clear na ho to Roman Urdu use karo. Andaaz dosti wala aur respectful ho. Simple sawal ka jawab 1-3 lines mein do, lekin agar user kisi topic (jaise history, study, general knowledge) ke baare mein detail maange to poora aur sahi jawab do. Agar pata na ho to bol do 'mujhe nahi pata', andaza mat lagao. Faltu disclaimers mat likho.";

interface IncomingPart {
  text?: unknown;
}

interface IncomingContent {
  role?: unknown;
  parts?: unknown;
}

function sanitizeHistory(rawHistory: unknown) {
  if (!Array.isArray(rawHistory) || rawHistory.length === 0) {
    return null;
  }

  const sanitized: Array<{ role: "user" | "model"; parts: Array<{ text: string }> }> = [];

  for (const item of rawHistory) {
    if (!item || typeof item !== "object") {
      return null;
    }
    const entry = item as IncomingContent;
    if (entry.role !== "user" && entry.role !== "model") {
      return null;
    }
    if (!Array.isArray(entry.parts) || entry.parts.length === 0) {
      return null;
    }
    const firstPart = entry.parts[0] as IncomingPart;
    if (!firstPart || typeof firstPart.text !== "string") {
      return null;
    }
    const text = firstPart.text.trim();
    if (!text) {
      return null;
    }
    sanitized.push({
      role: entry.role,
      parts: [{ text }],
    });
  }

  if (sanitized.length === 0 || sanitized[sanitized.length - 1].role !== "user") {
    return null;
  }

  return sanitized;
}

function getRomanUrduErrorMessage(err: unknown): { status: number; message: string } {
  const errMsg = err instanceof Error ? err.message : String(err);
  const lower = errMsg.toLowerCase();

  if (lower.includes("429") || lower.includes("resource_exhausted") || lower.includes("quota")) {
    return {
      status: 429,
      message: "Abhi bohot zyada requests aa rahi hain, thori der baad dobara koshish karo.",
    };
  }

  if (
    lower.includes("api_key") ||
    lower.includes("permission_denied") ||
    lower.includes("403") ||
    lower.includes("401")
  ) {
    return {
      status: 500,
      message: "API key ka masla aa raha hai. Settings > Secrets mein GEMINI_API_KEY check karo.",
    };
  }

  if (lower.includes("404") || lower.includes("not_found")) {
    return {
      status: 502,
      message: "Model dastiyab nahi hai (404). Model config check karo.",
    };
  }

  if (lower.includes("400") || lower.includes("invalid_argument")) {
    return {
      status: 400,
      message: "Request sahi nahi ban saki. Dobara likh kar bhejo.",
    };
  }

  return {
    status: 502,
    message: "Abhi jawab laane mein masla aa gaya. Thori der baad dobara bhejo.",
  };
}

async function startServer() {
  const app = express();
  const PORT = Number(process.env.PORT) || 3000;

  app.use(express.json({ limit: "1mb" }));

  app.post("/api/chat", async (req, res) => {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      res.status(500).json({
        error: "GEMINI_API_KEY set nahi hai. Settings > Secrets mein key add karo.",
      });
      return;
    }

    const contents = sanitizeHistory(req.body?.history);
    if (!contents) {
      res.status(400).json({
        error: "Message sahi format mein nahi hai. Dobara likh kar bhejo.",
      });
      return;
    }

    try {
      const ai = new GoogleGenAI({
        apiKey,
        httpOptions: {
          headers: {
            "User-Agent": "aistudio-build",
          },
        },
      });

      let response;
      let lastError: unknown;
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          response = await ai.models.generateContent({
            model: "gemini-4-hydrogen",
            contents,
            config: {
              systemInstruction: SYSTEM_INSTRUCTION,
              thinkingConfig: {
                thinkingLevel: ThinkingLevel.LOW,
              },
            },
          });
          break;
        } catch (err) {
          lastError = err;
          const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
          const isTransient =
            msg.includes("503") ||
            msg.includes("500") ||
            msg.includes("unavailable") ||
            msg.includes("internal") ||
            msg.includes("fetch failed");
          if (!isTransient || attempt === 1) {
            throw err;
          }
          await new Promise((resolve) => setTimeout(resolve, 400 * (attempt + 1)));
        }
      }

      if (!response) {
        throw lastError;
      }

      const reply = response.text?.trim();
      if (!reply) {
        res.status(502).json({
          error: "Jawab khali aaya hai. Dobara koshish karo.",
        });
        return;
      }

      res.json({ reply });
    } catch (error) {
      console.error("Gemini API error:", error);
      const mapped = getRomanUrduErrorMessage(error);
      res.status(mapped.status).json({ error: mapped.message });
    }
  });

  if (process.env.NODE_ENV !== "production") {
    const { createServer: createViteServer } = await import("vite");
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distDir = path.resolve(__dirname, "dist");
    app.use(express.static(distDir));
    app.get("*", (_req, res) => {
      res.sendFile(path.join(distDir, "index.html"));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
