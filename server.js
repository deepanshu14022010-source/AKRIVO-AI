// AKRIVO AI Backend - Fully Working Version

require("dotenv").config();

const express = require("express");
const cors = require("cors");
const Groq = require("groq-sdk");

const app = express();
app.use(cors());
app.use(express.json());

const client = new Groq({
  apiKey: process.env.GROQ_API_KEY
});

app.get("/", (req, res) => {
  res.send("AKRIVO backend is working 🚀");
});

app.post("/chat", async (req, res) => {
  console.log("CHAT ROUTE HIT");

  const message = req.body.message;

  try {
    const response = await client.chat.completions.create({
      model: "llama-3.3-70b-versatile",
      messages: [
        {
          role: "system",
          content: "You are AKRIVO AI, a smart and powerful assistant."
        },
        {
          role: "user",
          content: message
        }
      ]
    });

    const reply = response.choices[0].message.content;
    res.json({ content: reply });

  } catch (error) {
    console.log("AI ERROR:", error);
    res.json({ content: "AI connection failed." });
  }
});

app.listen(3000, () => {
  console.log("AKRIVO Backend is Running 🚀");
});