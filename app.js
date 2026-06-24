/**
 * MemoryLane — Main Slack App Entry Point
 * Wires together Slack Bolt, Notion MCP, RTS API, and OpenRouter AI.
 */

require('dotenv').config();
const { App } = require('@slack/bolt');
const slackifyMarkdown = require('slackify-markdown');
const notion = require('./notion');
const rts = require('./rts');
const cache = require('./cache'); 
const ai = require('./ai');

// ─────────────────────────────────────────────────────────────────────────────
// ENTERPRISE USER RESOLVER
// Translates tags, usernames, display names, or IDs into a clean User object
// ─────────────────────────────────────────────────────────────────────────────
async function resolveSlackUser(client, query) {
  const cleanQuery = query.replace('@', '').trim().toLowerCase();
  
  // 1. If it's a Slack tag <@U12345>
  const match = query.match(/<@([A-Z0-9]+)/);
  if (match) {
    try {
      const info = await client.users.info({ user: match[1] });
      return info.user;
    } catch (e) {
      console.error("Failed to fetch user by ID:", e);
    }
  }
  
  // 2. Fallback: Search the workspace user list for any match
  try {
    const list = await client.users.list();
    const user = list.members.find(u => 
      u.id.toLowerCase() === cleanQuery ||
      (u.name && u.name.toLowerCase() === cleanQuery) ||
      (u.real_name && u.real_name.toLowerCase() === cleanQuery) ||
      (u.profile?.display_name && u.profile.display_name.toLowerCase() === cleanQuery)
    );
    return user || null;
  } catch (e) {
    console.error("Failed to list users:", e);
    return null;
  }
}

// Initialize the Slack App in Socket Mode
const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  appToken: process.env.SLACK_APP_TOKEN,
  socketMode: true,
  port: process.env.PORT || 3000,
});

// ─────────────────────────────────────────────────────────────────────────────
// FEATURE 1: SILENT CAPTURE (Triggered by 🧠 emoji reaction)
// ─────────────────────────────────────────────────────────────────────────────
app.event('reaction_added', async ({ event, client, logger }) => {
  console.log(`👀 Someone reacted with: ${event.reaction}`);
  try {
    if (event.reaction !== 'brain') return;
    console.log('🧠 Brain emoji detected! Fetching thread...'); 

    const channelId = event.item.channel;
    const messageTs = event.item.ts;

    // 🌟 ROOT FIX: Fetch the reacted message first to see if it is a thread reply
    const reactedMessageResponse = await client.conversations.replies({
      channel: channelId,
      ts: messageTs,
      limit: 1
    });

    const reactedMessage = reactedMessageResponse.messages[0];
    
    // If it has a thread_ts, use it (this is the parent question!). Otherwise use its own ts.
    const parentTs = reactedMessage.thread_ts || messageTs;

    // 1. Fetch the ENTIRE conversation thread starting from the parent question!
    const thread = await client.conversations.replies({
      channel: channelId,
      ts: parentTs,
    });

    // 2. Extract the knowledge using OpenRouter AI
    const channelInfo = await client.conversations.info({ channel: channelId });
    const extraction = await ai.extractKnowledgeCard(thread.messages, channelInfo.channel.name, messageTs);

    if (!extraction) return;

    // 3. Translate the ugly Slack ID into a real human name
    const finalExpertId = extraction.expertIdentifier || event.user;
    let finalExpertName = "Team Member";

    try {
      const userInfo = await client.users.info({ user: finalExpertId });
      finalExpertName = userInfo.user.profile?.real_name || userInfo.user.real_name || userInfo.user.name;
    } catch (err) {
      console.log("Could not resolve user name, using fallback");
      finalExpertName = finalExpertId;
    }

    // 4. Save to Notion Graph (MCP)
    const permaLink = await client.chat.getPermalink({ channel: channelId, message_ts: messageTs });
    
    const safeTags = Array.isArray(extraction.tags) ? extraction.tags : ["knowledge"];
    const safeQuestion = extraction.question || "Captured Knowledge";
    const safeAnswer = extraction.answer || "No summary provided by AI.";

    const savedPage = await notion.saveKnowledgeCard({
      question: safeQuestion,
      answer: safeAnswer,
      tags: safeTags,
      channel: channelInfo.channel.name,
      channelId: channelId,
      messageLink: permaLink.permalink,
      expertUser: finalExpertName, 
      expertUserId: finalExpertId  
    });

    // 5. Add to blazing fast local cache
    if (savedPage) {
      cache.addCardToCache({
        question: safeQuestion,
        answer: safeAnswer,
        tags: safeTags,
        expert: finalExpertName,
        channel: channelInfo.channel.name,
        notionUrl: savedPage.url,
        capturedAt: new Date().toISOString()
      });
    }

    // 6. Silently confirm to the user who reacted
    await client.chat.postEphemeral({
      channel: channelId,
      user: event.user,
      text: `🧠 *MemoryLane captured this!* Tagged as: \`${safeTags.join(', ')}\``
    });

  } catch (error) {
    logger.error('Error in silent capture:', error);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// FEATURE 1.5: UNDO CAPTURE (Triggered when 🧠 emoji is removed)
// ─────────────────────────────────────────────────────────────────────────────
app.event('reaction_removed', async ({ event, client, logger }) => {
  try {
    if (event.reaction !== 'brain') return;

    const channelId = event.item.channel;
    const messageTs = event.item.ts;
    const permaLink = await client.chat.getPermalink({ channel: channelId, message_ts: messageTs });
    const deleted = await notion.deleteKnowledgeCard(permaLink.permalink);

    if (deleted) {
      cache.removeCardFromCache(permaLink.permalink);
      await client.chat.postEphemeral({
        channel: channelId,
        user: event.user,
        text: `🗑️ *MemoryLane:* You removed the 🧠 emoji, so I deleted that knowledge card from the database to keep things clean!`
      });
    }
  } catch (error) {
    logger.error('Error in undo capture:', error);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// FEATURE 2: PROACTIVE SURFACING & SEARCH (/recall)
// ─────────────────────────────────────────────────────────────────────────────
app.command('/recall', async ({ command, ack, respond }) => {
  await ack();
  const query = command.text;

  if (!query) {
    await respond("Please tell me what you're looking for! E.g., `/recall auth tokens`");
    return;
  }

  await respond(`🔍 *Searching MemoryLane and Slack history for:* "${query}"...`);

  try {
    let notionCards = cache.searchCache(query, 5); 
    
    // Fallback: If cache search fails, grab the 10 most recent cards from Notion
    if (notionCards.length === 0) {
       console.log("Strict search failed, grabbing recent cards for AI to read...");
       notionCards = await notion.getRecentCards(720, 10); 
    }

    const rawAnswer = await ai.answerFromKnowledge(query, notionCards);
    const synthesizedAnswer = slackifyMarkdown(rawAnswer); 

    const blocks = [
      {
        type: "section",
        text: { type: "mrkdwn", text: `💡 *Here is what I found regarding:* "${query}"\n\n${synthesizedAnswer}` }
      },
      { type: "divider" }
    ];

    await respond({ blocks });

  } catch (error) {
    console.error(error);
    await respond("❌ Sorry, I hit a snag while searching your memories.");
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// FEATURE 3: OFFBOARDING SHIELD (/handoff)
// ─────────────────────────────────────────────────────────────────────────────
app.command('/handoff', async ({ command, ack, respond, client }) => {
  await ack();
  const rawText = command.text.trim();
  
  if (!rawText) {
    await respond("Please mention a user. E.g., `/handoff @sarah`");
    return;
  }

  await respond(`🗂️ Generating knowledge handoff document... this takes a moment.`);

  try {
    const user = await resolveSlackUser(client, rawText);
    
    if (!user) {
      await respond(`I couldn't find any Slack user matching "${rawText}".`);
      return;
    }

    // 🌟 ROOT FIX: Prioritize the profile real_name so sandbox accounts resolve correctly!
    const searchName = user.profile?.real_name || user.real_name || user.name;
    const allCacheResults = cache.searchCache(searchName, 50);
    const cards = allCacheResults.filter(card => 
      card.expert && card.expert.toLowerCase().includes(searchName.toLowerCase())
    );
    
    if (cards.length === 0) {
      await respond(`I don't have any knowledge cards captured for **${searchName}**.`);
      return;
    }

    const rawDoc = await ai.generateHandoffDocument(searchName, cards);
    const doc = slackifyMarkdown(rawDoc);

    await respond({
      blocks: [
        { type: "header", text: { type: "plain_text", text: "📄 Knowledge Handoff Document" } },
        { type: "section", text: { type: "mrkdwn", text: doc } },
        {
          type: "actions",
          elements: [{ 
            type: "button", 
            text: { type: "plain_text", text: "Export to Notion" }, 
            action_id: "export_handoff",
            value: searchName // 🌟 Passed so the action handler knows WHO to export!
          }]
        }
      ]
    });

  } catch (error) {
    console.error(error);
    await respond("❌ Failed to generate handoff document.");
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// HANDLE BUTTON CLICKS (Export to Notion)
// ─────────────────────────────────────────────────────────────────────────────
app.action('export_handoff', async ({ ack, body, respond, logger }) => {
  await ack(); // Instantly removes the warning triangle!
  
  try {
    const searchName = body.actions[0].value; 
    
    const allCacheResults = cache.searchCache(searchName, 50);
    const cards = allCacheResults.filter(card => 
      card.expert && card.expert.toLowerCase().includes(searchName.toLowerCase())
    );

    if (cards.length > 0) {
      const rawDoc = await ai.generateHandoffDocument(searchName, cards);
      const savedPage = await notion.saveHandoffDocument(searchName, rawDoc); // 🌟 Saves directly to Notion!
      
      if (savedPage) {
        await respond({
          text: `✅ *Handoff Document successfully saved!* <${savedPage.url}|Click here to view it in Notion>`,
          replace_original: false // Posts cleanly below the document
        });
        return;
      }
    }
    
    await respond({ text: "⚠️ Could not export handoff to Notion.", replace_original: false });

  } catch (error) {
    logger.error('Error handling button click:', error);
    await respond({ text: "❌ An error occurred during export.", replace_original: false });
  }
});
// ─────────────────────────────────────────────────────────────────────────────
// FEATURE 5: THE DAILY BRIEF (/dailybrief)
// ─────────────────────────────────────────────────────────────────────────────
app.command('/dailybrief', async ({ ack, respond }) => {
  await ack();
  await respond(`☕ *Brewing your Daily Knowledge Brief...*`);

  try {
    // 1. Fetch cards from the last 24 hours (we use Notion directly to ensure accurate timestamps)
    const recentCards = await notion.getRecentCards(24, 10);
    
    if (recentCards.length === 0) {
      await respond("☕ *Your Daily Brief:* No new knowledge was captured in the last 24 hours. You're all caught up!");
      return;
    }

    // 2. Generate the summary using AI
    const rawBrief = await ai.generateDailyBrief(recentCards);
    const formattedBrief = slackifyMarkdown(rawBrief);

    // 3. Send it nicely formatted
    await respond({
      blocks: [
        { type: "header", text: { type: "plain_text", text: "🗞️ Your Daily MemoryLane Brief" } },
        { type: "section", text: { type: "mrkdwn", text: formattedBrief } },
        { type: "context", elements: [{ type: "mrkdwn", text: `_Summarizing ${recentCards.length} new insights captured across your workspace._` }] }
      ]
    });
  } catch (error) {
    console.error(error);
    await respond("❌ Failed to generate your daily brief.");
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// FEATURE 1.2: MANUAL REMEMBER (/remember)
// ─────────────────────────────────────────────────────────────────────────────
app.command('/remember', async ({ command, ack, respond, client }) => {
  await ack();
  const textToSave = command.text.trim();

  if (!textToSave) {
    await respond("Please tell me what to remember! E.g., \`/remember The office printer code is 9999\`");
    return;
  }

  await respond(`🧠 *Analyzing and saving to MemoryLane...*`);

  try {
    // Resolve the sender's real name
    const userInfo = await client.users.info({ user: command.user_id });
    const expertName = userInfo.user.profile?.real_name || userInfo.user.real_name || userInfo.user.name;

    // Use AI to extract clean Question, Answer, and Tags from their manual text
    const extraction = await ai.extractKnowledgeCard([{ text: textToSave, user: command.user_id }], "manual-save");

    if (!extraction) {
      await respond("❌ Sorry, I couldn't parse that into a clean knowledge card.");
      return;
    }

    const safeTags = Array.isArray(extraction.tags) ? extraction.tags : ["manual"];
    const safeQuestion = extraction.question || "Manual Entry";
    const safeAnswer = extraction.answer || textToSave;

    // Save to Notion
    const savedPage = await notion.saveKnowledgeCard({
      question: safeQuestion,
      answer: safeAnswer,
      tags: safeTags,
      channel: "manual",
      channelId: command.channel_id,
      messageLink: `https://slack.com/archives/${command.channel_id}`,
      expertUser: expertName,
      expertUserId: command.user_id
    });

    // Save to Local Cache
    if (savedPage) {
      cache.addCardToCache({
        question: safeQuestion,
        answer: safeAnswer,
        tags: safeTags,
        expert: expertName,
        channel: "manual",
        notionUrl: savedPage.url,
        capturedAt: new Date().toISOString()
      });

      await respond({
        text: `✅ *MemoryLane:* Manually saved! \n*Q:* ${safeQuestion}\n*A:* ${safeAnswer}\n*Tags:* \`${safeTags.join(', ')}\``,
      });
    }
  } catch (error) {
    console.error(error);
    await respond("❌ Failed to manually save that memory.");
  }
});
// ─────────────────────────────────────────────────────────────────────────────
// START THE APP
// ─────────────────────────────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────────────────────
// START THE APP & KEEP-ALIVE SERVER
// ─────────────────────────────────────────────────────────────────────────────
(async () => {
  await cache.initializeCache(); 
  await app.start();
  console.log('⚡️ MemoryLane Agent is running in Socket Mode!');

  // 🌟 NEW: Tiny native HTTP server to satisfy Render's port scanning!
  const http = require('http');
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('MemoryLane is Awake and Running 24/7!\n');
  });
  
  const port = process.env.PORT || 3000;
  server.listen(port, () => {
    console.log(`📡 Keep-alive HTTP server listening on port ${port}`);
  });
})();
