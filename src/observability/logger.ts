import pino from "pino";

export const logger = pino({
  level: process.env.AIFROST_LOG_LEVEL ?? "info",
  redact: {
    paths: [
      "req.headers.authorization",
      "cookie",
      "cookies",
      "password",
      "token",
      "prompt",
      "messages",
    ],
    remove: true,
  },
});
