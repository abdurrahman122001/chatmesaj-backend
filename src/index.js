import dotenv from "dotenv";
import express from "express";
import cors from "cors";
import http from "http";
import path from "path";
import { fileURLToPath } from "url";
import { Server as SocketServer } from "socket.io";
import jwt from "jsonwebtoken";

import authRoutes from "./routes/auth.js";
import conversationsRoutes from "./routes/conversations.js";
import contactsRoutes from "./routes/contacts.js";
import widgetRoutes from "./routes/widget.js";
import sitesRoutes from "./routes/sites.js";
import uploadsRoutes from "./routes/uploads.js";
import knowledgeRoutes from "./routes/knowledge.js";
import productsRoutes from "./routes/products.js";
import suggestionsRoutes from "./routes/suggestions.js";
import playgroundRoutes from "./routes/playground.js";
import macrosRoutes from "./routes/macros.js";
import analyticsRoutes from "./routes/analytics.js";
import teamRoutes from "./routes/team.js";
import ticketsRoutes from "./routes/tickets.js";
import subscribersRoutes from "./routes/subscribers.js";
import emailRoutes from "./routes/email.js";
import telegramRoutes from "./routes/telegram.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config();
dotenv.config({ path: path.resolve(__dirname, "../.env") });

const app = express();
// Nginx və ya digər reverse proxy arxasında olduğu üçün real IP-ni tanısın
app.set("trust proxy", true);
const server = http.createServer(app);

const frontendOrigin = process.env.FRONTEND_ORIGIN || "http://localhost:5173";
const widgetOrigins = (process.env.WIDGET_ORIGINS || "*")
  .split(",")
  .map((s) => s.trim());

app.use(
  cors({
    origin: (origin, cb) => {
      if (!origin) return cb(null, true);
      if (widgetOrigins.includes("*")) return cb(null, true);
      if (origin === frontendOrigin || widgetOrigins.includes(origin)) return cb(null, true);
      cb(new Error("CORS blocked"));
    },
    credentials: true,
  })
);
app.use(express.json({ limit: "4mb" }));

// Static uploads
const uploadDir = process.env.UPLOAD_DIR || path.join(__dirname, "..", "uploads");
app.use("/uploads", express.static(uploadDir));

// Health check
app.get("/api/health", (_req, res) => res.json({ ok: true, time: new Date().toISOString() }));

// Routes
app.use("/api/auth", authRoutes);
app.use("/api/conversations", conversationsRoutes);
app.use("/api/contacts", contactsRoutes);
app.use("/api/sites", sitesRoutes);
app.use("/api/uploads", uploadsRoutes);
app.use("/api/knowledge", knowledgeRoutes);
app.use("/api/products", productsRoutes);
app.use("/api/suggestions", suggestionsRoutes);
app.use("/api/playground", playgroundRoutes);
app.use("/api/macros", macrosRoutes);
app.use("/api/analytics", analyticsRoutes);
app.use("/api/team", teamRoutes);
app.use("/api/widget", widgetRoutes);
app.use("/api/tickets", ticketsRoutes);
app.use("/api/subscribers", subscribersRoutes);
app.use("/api/email", emailRoutes);
app.use("/api/telegram", telegramRoutes);

// Global error handler
app.use((err, _req, res, _next) => {
  console.error(err);
  if (err.message === "CORS blocked") return res.status(403).json({ error: "Origin not allowed" });
  res.status(500).json({ error: err.message || "Internal error" });
});

// Socket.IO
const io = new SocketServer(server, {
  cors: { origin: true, credentials: true },
});
app.set("io", io);

io.on("connection", (socket) => {
  const { token, apiKey, siteId, conversationId } = socket.handshake.auth || {};

  function normalizeName(input, fallback) {
    const n = String(input || "").trim();
    return n || fallback;
  }

  function relayTyping({ conversationId, siteId, typing, from, authorName }) {
    if (!conversationId) return;
    const payload = {
      conversationId,
      typing: Boolean(typing),
      from,
      authorName: normalizeName(authorName, from === "agent" ? "Agent" : "Visitor"),
    };
    socket.to(`conversation:${conversationId}`).emit("typing", payload);
    if (siteId) {
      socket.to(`site:${siteId}`).emit("typing", payload);
    }
  }

  // Admin (agent) socket: JWT ilə giriş
  if (token) {
    try {
      const payload = jwt.verify(token, process.env.JWT_SECRET);
      socket.data.userId = payload.sub;
      socket.data.role = payload.role;
      // Agent öz site-larına join olur
      socket.on("join-site", (sid) => socket.join(`site:${sid}`));
      socket.on("join-conversation", (cid) => socket.join(`conversation:${cid}`));
      socket.on("typing", ({ conversationId, siteId, typing, authorName }) => {
        relayTyping({ conversationId, siteId, typing, from: "agent", authorName });
      });
    } catch (e) {
      socket.disconnect(true);
      return;
    }
  } else if (apiKey) {
    // Widget (visitor) socket
    socket.data.apiKey = apiKey;
    if (siteId) socket.join(`site:${siteId}`);
    if (conversationId) socket.join(`conversation:${conversationId}`);
    console.log(`[socket] widget connected site=${siteId || "?"} convo=${conversationId || "?"}`);
    socket.on("join-conversation", (cid) => {
      socket.join(`conversation:${cid}`);
      console.log(`[socket] widget joined conversation:${cid}`);
    });
    socket.on("typing", ({ conversationId, siteId, typing, authorName }) => {
      relayTyping({ conversationId, siteId, typing, from: "visitor", authorName });
    });
  }
});

const PORT = Number(process.env.PORT || 8081);
server.listen(PORT, () => {
  console.log(`✓ API server listening on http://localhost:${PORT}`);
});
