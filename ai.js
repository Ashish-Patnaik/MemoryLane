/**
 * MemoryLane — OpenRouter AI Service
 * Connects to OpenRouter's OpenAI-compatible API.
 */

const OpenAI = require('openai');

const openai = new OpenAI({
  baseURL: "https://openrouter.ai/api/v1",
  apiKey: process.env.OPENROUTER_API_KEY,
  defaultHeaders: {
    "HTTP-Referer": "https://memorylane-hackathon.dev", // Optional
    "X-OpenRouter-Title": "MemoryLane Slack Agent",     // Optional
  },
});

const MODEL = "google/gemini-2.5-flash-lite-preview-09-2025"; // You can change this to any OpenRouter model

// ─────────────────────────────────────────────────────────────────────────────
// EXTRACT structured knowledge card from a conversation thread
// ─────────────────────────────────────────────────────────────────────────────
async function extractKnowledgeCard(messages, channelName, reactedTs) {
  if (!messages || messages.length === 0) return null;

  // 🌟 The first message in the thread is ALWAYS the original question
  const originalQuestion = messages[0].text;

  // Highlight the message that got the emoji to help the AI map the expert
  const conversation = messages.map((m) => {
    const isVerified = m.ts === reactedTs ? " <<< [THIS MESSAGE GOT THE 🧠 EMOJI]" : "";
    return `[User ID: ${m.user || 'Unknown'}] says: ${m.text}${isVerified}`;
  }).join('\n');

  try {
    const response = await openai.chat.completions.create({
      model: MODEL,
      response_format: { type: "json_object" }, 
      messages: [
        {
          role: 'system',
          content: `You extract structured knowledge cards from Slack threads.
Note: The 🧠 emoji might be placed on the original question or on one of the replies. 
Your job is to identify:
1. "question": The main question asked (This is ALWAYS based on the Original Question provided).
2. "answer": The definitive correct answer extracted from the replies.
3. "tags": Relevant keywords.
4. "expertIdentifier": The Slack User ID of the person who provided the correct answer.

Respond ONLY with valid JSON. Do not include markdown formatting.
Format:
{
  "question": "The clean version of the Original Question asked",
  "answer": "The combined, definitive answer extracted from the replies (2-5 sentences)",
  "tags": ["tag1", "tag2"],
  "expertIdentifier": "User ID of the person who wrote the correct answer",
  "confidence": "high"
}`
        },
        {
          role: 'user',
          content: `Channel: #${channelName}\nOriginal Question: ${originalQuestion}\n\nFull Conversation:\n${conversation}`
        }
      ]
    });

    let jsonText = response.choices[0].message.content.trim();
    jsonText = jsonText.replace(/```json/g, '').replace(/```/g, '').trim();
    return JSON.parse(jsonText);

  } catch (err) {
    console.error('❌ AI extract error:', err.message);
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// ANSWER a user's question using retrieved knowledge cards (RAG)
// ─────────────────────────────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────────────────────
// ANSWER a user's question using retrieved knowledge cards (RAG)
// ─────────────────────────────────────────────────────────────────────────────
async function answerFromKnowledge(userQuestion, knowledgeCards) {
  if (!knowledgeCards || knowledgeCards.length === 0) {
    return "I couldn't find any past answers about this in the Memory Base.";
  }

  // 🌟 FIX: We are now passing the Channel name to the AI!
  const cardsText = knowledgeCards
    .map((c, i) => `[Card ${i + 1}] Topic: ${c.question}\nAnswer: ${c.answer}\nExpert: ${c.expert}\nChannel: #${c.channel || 'general'}`)
    .join('\n\n');

  try {
    const response = await openai.chat.completions.create({
      model: MODEL,
      messages: [
        {
          role: 'system',
          // 🌟 FIX: Instruct the AI to mention the channel!
          content: `You are MemoryLane, a helpful Slack assistant. Answer the user's question using ONLY the provided knowledge cards. Be concise, use Slack markdown (*bold*, _italic_), and ALWAYS cite the expert who answered it AND the #channel it was captured in.`
        },
        {
          role: 'user',
          content: `Knowledge Cards:\n${cardsText}\n\nQuestion: ${userQuestion}`
        }
      ]
    });

    return response.choices[0].message.content;

  } catch (err) {
    console.error('❌ OpenRouter answer error:', err.message);
    return "Sorry, I hit a snag while trying to synthesize the answer.";
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// GENERATE a knowledge handoff document
// ─────────────────────────────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────────────────────
// GENERATE a knowledge handoff document (Slack Friendly)
// ─────────────────────────────────────────────────────────────────────────────
async function generateHandoffDocument(userName, cards) {
  const cardsText = cards
    .map((c) => `• *Topic:* ${c.question}\n  *Verified Answer:* ${c.answer}\n  *Channel:* #${c.channel || 'general'}`)
    .join('\n\n');

  try {
    const response = await openai.chat.completions.create({
      model: MODEL,
      messages: [
        {
          role: 'system',
          content: `You create professional knowledge handoff documents for departing team members.
Format the output as clean Slack markdown (mrkdwn). 

CRITICAL FORMATTING RULES:
1. NEVER use standard Markdown tables (no vertical pipes | or dashed lines ---). They render terribly in Slack.
2. Use clean, bold headers (e.g. *1. Subject Name*) and organize information using clean bullet points (•) and paragraphs.
3. Keep it neat, professional, readable, and highly organized.`
        },
        {
          role: 'user',
          content: `Create a knowledge handoff document for the team member <@${userName}>. Here is all the verified knowledge they have contributed:\n\n${cardsText}`
        }
      ]
    });

    return response.choices[0].message.content;

  } catch (err) {
    console.error('❌ OpenRouter handoff error:', err.message);
    return "Failed to generate handoff document.";
  }
}
// ─────────────────────────────────────────────────────────────────────────────
// GENERATE DAILY BRIEF
// ─────────────────────────────────────────────────────────────────────────────
async function generateDailyBrief(cards) {
  if (!cards || cards.length === 0) return "No new knowledge was captured yesterday. You're all caught up!";

  const cardsText = cards.map(c => `• *${c.question}* (Answered by ${c.expert} in #${c.channel})`).join('\n');

  try {
    const response = await openai.chat.completions.create({
      model: MODEL,
      messages: [
        {
          role: 'system',
          content: `You write friendly, scannable daily knowledge briefs for team members.
Keep it under 150 words. Start with a warm, one-line greeting (e.g. "Good morning! Here is the team knowledge you missed:").
Format using standard Markdown (** for bold, etc).`
        },
        {
          role: 'user',
          content: `Write a brief summarizing these recent knowledge captures:\n\n${cardsText}`
        }
      ]
    });
    return response.choices[0].message.content;
  } catch (err) {
    console.error('❌ Daily brief error:', err.message);
    return "Could not generate daily brief.";
  }
}

module.exports = {
  extractKnowledgeCard,
  answerFromKnowledge,
  generateDailyBrief,
  generateHandoffDocument,
};