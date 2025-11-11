import { TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions/index.js";
import { NewMessage } from "telegram/events/index.js";
import readline from "readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { MongoClient } from "mongodb";
import fs from "fs";
import path from "path";
import { unlinkSync, existsSync } from "fs";
import { subDays } from "date-fns";
import dotenv from "dotenv";

dotenv.config();

// === Конфігурація ===
const apiId = Number(process.env.API_ID);
const apiHash = process.env.API_HASH;
const mongoUri = process.env.MONGO_URI;
const RETENTION_DAYS = Number(process.env.RETENTION_DAYS) || 7;

// === Папка для збереження медіа ===
const mediaDir = "./media";
if (!fs.existsSync(mediaDir)) fs.mkdirSync(mediaDir);

// === Підключення до MongoDB ===
const mongo = new MongoClient(mongoUri);
await mongo.connect();
const db = mongo.db("telegram_archive");
const messages = db.collection("messages");

console.log("✅ Підключено до MongoDB");

// === Telegram-клієнт ===
const stringSession = new StringSession(process.env.SESSION); // порожня сесія при першому запуску
const client = new TelegramClient(stringSession, apiId, apiHash, {
  connectionRetries: 5,
});

const rl = readline.createInterface({ input, output });

console.log("🔑 Авторизація...");

// === Авторизація ===
await client.start({
  phoneNumber: async () => await rl.question("📱 Введи номер телефону: "),
  password: async () => await rl.question("🔒 Пароль (якщо є 2FA): "),
  phoneCode: async () => await rl.question("💬 Код із Telegram: "),
  onError: (err) => console.error("❌ Помилка:", err),
});

rl.close();

console.log("✅ Авторизація успішна!");
console.log("⏳ Очікування нових повідомлень...\n");

// === Допоміжна функція для визначення розширення ===
function getExtensionFromMime(mimeType) {
  if (!mimeType) return "";
  const map = {
    "image/jpeg": ".jpg",
    "image/png": ".png",
    "image/webp": ".webp",
    "image/gif": ".gif",
    "video/mp4": ".mp4",
    "video/x-matroska": ".mkv",
    "audio/mpeg": ".mp3",
    "audio/ogg": ".ogg",
    "audio/wav": ".wav",
    "application/pdf": ".pdf",
    "application/zip": ".zip",
    "application/x-rar-compressed": ".rar",
    "text/plain": ".txt",
  };
  return map[mimeType] || "";
}

// === Функція очищення старих повідомлень і файлів ===
async function cleanupOldMessages() {
  const cutoffDate = subDays(new Date(), RETENTION_DAYS);
  //const cutoffDate = new Date(Date.now() - 2 * 60 * 1000);
    console.log(cutoffDate);
  const oldMessages = await messages.find({ saved_at: { $lt: cutoffDate } }).toArray();

  for (const msg of oldMessages) {
    if (msg.media_path && existsSync(msg.media_path)) {
      try {
        unlinkSync(msg.media_path);
        //console.log(`🗑 Видалено файл: ${msg.media_path}`);
      } catch (err) {
        //console.error(`⚠️ Не вдалося видалити файл ${msg.media_path}:`, err.message);
      }
    }
  }

  const result = await messages.deleteMany({ saved_at: { $lt: cutoffDate } });
  //console.log(`🗑 Видалено ${result.deletedCount} старих повідомлень з бази`);
}

// === Запуск очищення один раз при старті ===
cleanupOldMessages();

// === Викликати очистку періодично кожні 24 години ===
setInterval(() => {
  console.log("⏳ Запуск очистки старих повідомлень...");
  cleanupOldMessages();
}, 24 * 60 * 60 * 1000); // 24 години
//}, 60 * 1000);

// === Обробник нових повідомлень ===
client.addEventHandler(async (event) => {
  const message = event.message;
  if (!message || (!message.message && !message.media)) return;

  const sender = await message.getSender();
  const chat = await message.getChat();

  let mediaPath = null;

  // === Збереження медіа ===
  if (message.media) {
    try {
      const file = await client.downloadMedia(message.media, { workers: 1 });
      let ext = "";

      // Витягуємо MIME-тип
      if (message.media.document?.mimeType) {
        ext = getExtensionFromMime(message.media.document.mimeType);
      } else if (message.media.photo) {
        ext = ".jpg";
      }

      // Якщо MIME не відомий, беремо з attributes.fileName
      if (!ext && message.media.document?.attributes?.length) {
        const attr = message.media.document.attributes.find(a => a.fileName);
        if (attr?.fileName) ext = path.extname(attr.fileName);
      }

      const filename = `${Date.now()}_${message.id}${ext || ""}`;
      const filePath = path.join(mediaDir, filename);
      fs.writeFileSync(filePath, file);
      mediaPath = filePath;

      //console.log(`📦 Збережено файл: ${filename}`);
    } catch (err) {
      console.error("⚠️ Помилка при збереженні медіа:", err.message);
    }
  }

  // === Зберігаємо повідомлення в MongoDB ===
  const msgData = {
    message_id: message.id,
    date: message.date,
    text: message.message || null,
    sender_id: sender?.id || null,
    sender_username: sender?.username || null,
    chat_id: chat?.id || null,
    chat_name: chat?.title || null,
    media_path: mediaPath,
    type: message.media ? "media" : "text",
    saved_at: new Date(),
  };

  await messages.insertOne(msgData);
  //console.log(`💾 Збережено повідомлення від ${sender?.username || sender?.id}`);
}, new NewMessage({}));

console.log("✅ Telegram клієнт активний — архівування запущено!");
