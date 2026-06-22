/**
 * MemoryLane — Notion Service
 * Handles all reads/writes to the Notion knowledge graph via the official SDK.
 * The Notion MCP server (npx @notionhq/notion-mcp-server) wraps this same API.
 */

const { Client } = require('@notionhq/client');

const notion = new Client({ auth: process.env.NOTION_TOKEN });
const DB_ID = process.env.NOTION_DATABASE_ID;

// ─────────────────────────────────────────────────────────────────────────────
// SAVE a knowledge card captured from a Slack conversation
// ─────────────────────────────────────────────────────────────────────────────
async function saveKnowledgeCard({
  question,
  answer,
  expertUser,      // Slack display name of the person who answered
  expertUserId,    // Slack user ID
  channel,
  channelId,
  messageLink,
  tags = [],
  confidence = 'high',
}) {
  try {
    const page = await notion.pages.create({
      parent: { database_id: DB_ID },
      icon: { type: 'emoji', emoji: '🧠' },
      properties: {
        // Title = the question/topic
        Name: {
          title: [{ text: { content: question.slice(0, 200) } }],
        },
        Answer: {
          rich_text: [{ text: { content: answer.slice(0, 2000) } }],
        },
        Expert: {
          rich_text: [{ text: { content: expertUser } }],
        },
        ExpertSlackId: {
          rich_text: [{ text: { content: expertUserId } }],
        },
        Channel: {
          rich_text: [{ text: { content: channel } }],
        },
        SourceLink: {
          url: messageLink || null,
        },
        Tags: {
          multi_select: tags.map((t) => ({ name: t })),
        },
        Confidence: {
          select: { name: confidence },
        },
        CapturedAt: {
          date: { start: new Date().toISOString() },
        },
        ViewCount: {
          number: 0,
        },
      },
    });

    console.log(`✅ Saved knowledge card: "${question.slice(0, 60)}..."`);
    return page;
  } catch (err) {
    console.error('❌ Notion saveKnowledgeCard error:', err.message);
    return null;
  }
}


// ─────────────────────────────────────────────────────────────────────────────
// SEARCH knowledge cards by keyword or semantic query
// ─────────────────────────────────────────────────────────────────────────────
async function searchKnowledge(query, limit = 5) {
  try {
    // Make the search smarter: grab the most important word (e.g. "password")
    const searchWord = query.split(' ').find(w => w.length > 4) || query.slice(0, 15);

    const response = await notion.databases.query({
      database_id: DB_ID,
      filter: {
        or: [
          {
            property: 'Name',
            title: { contains: searchWord }, // Fixed to 'title'
          },
          {
            property: 'Answer',
            rich_text: { contains: searchWord },
          }
        ],
      },
      sorts: [{ property: 'CapturedAt', direction: 'descending' }],
      page_size: limit,
    });

    return response.results.map(extractCard);
  } catch (err) {
    console.error('❌ Notion searchKnowledge error:', err.message);
    return [];
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// GET all cards where a specific Slack user is the expert
// Used for handoff doc generation
// ─────────────────────────────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────────────────────
// GET all cards where a specific Slack user is the expert
// ─────────────────────────────────────────────────────────────────────────────
async function getCardsByExpert(expertQuery) {
  try {
    const response = await notion.databases.query({
      database_id: DB_ID,
      filter: {
        or: [
          {
            property: 'ExpertSlackId',
            rich_text: { contains: expertQuery },
          },
          {
            property: 'Expert',
            rich_text: { contains: expertQuery },
          }
        ]
      },
      sorts: [{ property: 'CapturedAt', direction: 'descending' }],
      page_size: 50,
    });

    return response.results.map(extractCard);
  } catch (err) {
    console.error('❌ Notion getCardsByExpert error:', err.message);
    return [];
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// GET recent cards (for daily brief)
// ─────────────────────────────────────────────────────────────────────────────
async function getRecentCards(hoursBack = 24, limit = 10) {
  try {
    const since = new Date(Date.now() - hoursBack * 60 * 60 * 1000).toISOString();
    const response = await notion.databases.query({
      database_id: DB_ID,
      filter: {
        property: 'CapturedAt',
        date: { after: since },
      },
      sorts: [{ property: 'CapturedAt', direction: 'descending' }],
      page_size: limit,
    });

    return response.results.map(extractCard);
  } catch (err) {
    console.error('❌ Notion getRecentCards error:', err.message);
    return [];
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// INCREMENT view count when a card is surfaced to a user
// ─────────────────────────────────────────────────────────────────────────────
async function incrementViewCount(pageId, currentCount) {
  try {
    await notion.pages.update({
      page_id: pageId,
      properties: {
        ViewCount: { number: (currentCount || 0) + 1 },
      },
    });
  } catch (err) {
    // Non-critical — don't crash for this
    console.warn('⚠️ Could not update view count:', err.message);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// SETUP: Create the Notion database with the right schema
// Run once: node -e "require('./services/notion').setupDatabase()"
// ─────────────────────────────────────────────────────────────────────────────
async function setupDatabase(parentPageId) {
  try {
    const db = await notion.databases.create({
      parent: { type: 'page_id', page_id: parentPageId },
      icon: { type: 'emoji', emoji: '🧠' },
      title: [{ type: 'text', text: { content: 'MemoryLane Knowledge Base' } }],
      properties: {
        Name:          { title: {} },
        Answer:        { rich_text: {} },
        Expert:        { rich_text: {} },
        ExpertSlackId: { rich_text: {} },
        Channel:       { rich_text: {} },
        SourceLink:    { url: {} },
        Tags:          { multi_select: { options: [] } },
        Confidence:    {
          select: {
            options: [
              { name: 'high',   color: 'green'  },
              { name: 'medium', color: 'yellow' },
              { name: 'low',    color: 'red'    },
            ],
          },
        },
        CapturedAt:    { date: {} },
        ViewCount:     { number: { format: 'number' } },
      },
    });

    console.log(`✅ Database created! ID: ${db.id}`);
    console.log(`👉 Add this to your .env: NOTION_DATABASE_ID=${db.id}`);
    return db.id;
  } catch (err) {
    console.error('❌ Database setup error:', err.message);
    throw err;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// HELPER: Extract clean card object from Notion API response
// ─────────────────────────────────────────────────────────────────────────────
function extractCard(page) {
  const p = page.properties;
  return {
    id: page.id,
    question:     p.Name?.title?.[0]?.text?.content || '',
    answer:       p.Answer?.rich_text?.[0]?.text?.content || '',
    expert:       p.Expert?.rich_text?.[0]?.text?.content || 'Unknown',
    expertUserId: p.ExpertSlackId?.rich_text?.[0]?.text?.content || '',
    channel:      p.Channel?.rich_text?.[0]?.text?.content || '',
    sourceLink:   p.SourceLink?.url || null,
    tags:         p.Tags?.multi_select?.map((t) => t.name) || [],
    confidence:   p.Confidence?.select?.name || 'medium',
    capturedAt:   p.CapturedAt?.date?.start || null,
    viewCount:    p.ViewCount?.number || 0,
    notionUrl:    page.url,
  };
}
// ─────────────────────────────────────────────────────────────────────────────
// FETCH ALL CARDS (Used for caching on startup)
// ─────────────────────────────────────────────────────────────────────────────
async function getAllCards() {
  let results = [];
  let cursor = undefined;
  
  try {
    do {
      const response = await notion.databases.query({
        database_id: DB_ID,
        start_cursor: cursor,
        page_size: 100, // Notion limits to 100 per request
      });
      results.push(...response.results.map(extractCard));
      cursor = response.next_cursor;
    } while (cursor);
    
    return results;
  } catch (err) {
    console.error('❌ Notion getAllCards error:', err.message);
    return [];
  }
}
// ─────────────────────────────────────────────────────────────────────────────
// DELETE knowledge card (Triggered when someone removes the emoji)
// ─────────────────────────────────────────────────────────────────────────────
async function deleteKnowledgeCard(messageLink) {
  try {
    // 1. Find the page in Notion that matches this Slack link
    const response = await notion.databases.query({
      database_id: DB_ID,
      filter: {
        property: 'SourceLink',
        url: { equals: messageLink },
      },
    });

    if (response.results.length > 0) {
      const pageId = response.results[0].id;
      // 2. Archive (delete) the page in Notion
      await notion.pages.update({ page_id: pageId, archived: true });
      console.log(`🗑️ Deleted card from Notion: ${messageLink}`);
      return true;
    }
    return false;
  } catch (err) {
    console.error('❌ Notion delete error:', err.message);
    return false;
  }
}
// ─────────────────────────────────────────────────────────────────────────────
// SAVE HANDOFF DOCUMENT TO NOTION
// ─────────────────────────────────────────────────────────────────────────────
async function saveHandoffDocument(userName, documentText) {
  try {
    const page = await notion.pages.create({
      parent: { database_id: DB_ID },
      icon: { type: 'emoji', emoji: '📄' },
      properties: {
        Name: {
          title: [{ text: { content: `Knowledge Handoff: ${userName}` } }],
        },
        Answer: {
          rich_text: [{ text: { content: documentText.slice(0, 1900) } }], // Notion limit is 2000
        },
        Expert: {
          rich_text: [{ text: { content: userName } }],
        },
        Confidence: {
          select: { name: 'high' },
        },
        CapturedAt: {
          date: { start: new Date().toISOString() },
        },
      },
    });
    return page;
  } catch (err) {
    console.error('❌ Notion saveHandoffDocument error:', err.message);
    return null;
  }
}

module.exports = {
  saveKnowledgeCard,
  saveHandoffDocument,
  searchKnowledge,
  getCardsByExpert,
  deleteKnowledgeCard,
  getRecentCards,
  incrementViewCount,
  setupDatabase,
  getAllCards,
};