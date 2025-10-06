import express from "express";

const app = express();

// Simple homepage route
app.get("/", (req, res) => {
  res.send("✅ Birthday Bot is alive and running!");
});

// Optional healthcheck endpoint for Render
app.get("/health", (req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

// Start server on a Render-compatible port
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🌐 Keep-alive server running on port ${PORT}`);
});
