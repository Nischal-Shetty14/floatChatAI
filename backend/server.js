import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import mongoose from "mongoose";
import path from "path";
import { fileURLToPath } from "url";
import fs from "fs";
import routes from "./routes.js";
import { validateStartupConfig } from "./config.js";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 5001;

// Middleware
app.use(cors());
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true, limit: "10mb" }));

// Ensure upload directory exists
const uploadDir = path.join(__dirname, "uploads");
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

// Global DB Connection Status
let isMongoConnected = false;

// Attempt to connect to MongoDB if URI is provided
const mongoURI = process.env.MONGODB_URI;
if (mongoURI) {
  console.log("Attempting connection to MongoDB...");
  mongoose
    .connect(mongoURI)
    .then(() => {
      console.log("🚀 Connected successfully to MongoDB.");
      isMongoConnected = true;
    })
    .catch((err) => {
      console.error(
        "⚠️ MongoDB connection failed. Falling back to local JSON database.",
        err.message,
      );
      isMongoConnected = false;
    });
} else {
  console.log(
    "ℹ️ No MONGODB_URI provided in .env. Running on local JSON file database fallback.",
  );
}

// Share Mongo status with routes
app.use((req, res, next) => {
  req.isMongoConnected = isMongoConnected;
  next();
});

// Load routes
app.use("/api", routes);

// Serve static assets from public folders in production if needed
const publicDir = path.join(__dirname, "..", "frontend", "dist");
if (fs.existsSync(publicDir)) {
  app.use(express.static(publicDir));
  app.get("*", (req, res) => {
    res.sendFile(path.join(publicDir, "index.html"));
  });
} else {
  app.get("/", (req, res) => {
    res.send("FloatChat AI Backend Server is running.");
  });
}

// Error Handler
app.use((err, req, res, next) => {
  console.error("Unhandled server error:", err);
  res
    .status(500)
    .json({ error: "Internal server error occurred", details: err.message });
});

app.listen(PORT, () => {
  console.log(`📡 FloatChat AI Server started on port ${PORT}`);
  console.log(`🔗 API Base URL: http://localhost:${PORT}/api`);
  validateStartupConfig();
});
