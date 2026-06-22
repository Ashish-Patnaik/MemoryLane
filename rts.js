/**
 * MemoryLane — Real-Time Search (RTS) API Service
 * Uses Slack's assistant.search.context to search workspace content.
 * This is one of the 3 required hackathon technologies.
 *
 * Docs: https://docs.slack.dev/apis/web-api/real-time-search-api/
 */

// ─────────────────────────────────────────────────────────────────────────────
// SEARCH Slack workspace using the Real-Time Search API
// actionToken comes from app_mention or message.im events
// ─────────────────────────────────────────────────────────────────────────────
async function searchWorkspace(client, query, actionToken, options = {}) {
  try {
    const result = await client.assistant.search.context({
      query,
      action_token: actionToken,
      content_types: options.contentTypes || ['messages'],
      ...(options.channelId && { channel_id: options.channelId }),
    });

    return result.context_messages || [];
  } catch (err) {
    // RTS requires Slack AI to be enabled on the workspace
    // In sandbox it's available; in regular workspaces it needs paid plan
    if (err.data?.error === 'team_not_eligible') {
      console.warn('⚠️ RTS API: Slack AI not enabled on this workspace');
      return [];
    }
    console.error('❌ RTS search error:', err.message);
    return [];
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// CHECK if RTS / Slack AI is available on the workspace
// ─────────────────────────────────────────────────────────────────────────────
async function checkRtsAvailable(client) {
  try {
    const info = await client.assistant.search.info({});
    return info.ok && info.search_enabled;
  } catch {
    return false;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// SEARCH for related past discussions given a new question
// Uses semantic search when the query is phrased as a question
// ─────────────────────────────────────────────────────────────────────────────
async function findRelatedDiscussions(client, question, actionToken) {
  // Semantic search is triggered by question-phrased queries (what/how/why/?)
  const semanticQuery = question.endsWith('?') ? question : `${question}?`;

  const messages = await searchWorkspace(client, semanticQuery, actionToken, {
    contentTypes: ['messages'],
  });

  return messages.slice(0, 5); // Top 5 most relevant
}

// ─────────────────────────────────────────────────────────────────────────────
// FIND the expert for a topic by searching who has discussed it most
// ─────────────────────────────────────────────────────────────────────────────
async function findTopicExperts(client, topic, actionToken) {
  const messages = await searchWorkspace(client, topic, actionToken, {
    contentTypes: ['messages', 'users'],
  });

  // Count who appears most in results
  const userCounts = {};
  for (const msg of messages) {
    if (msg.user) {
      userCounts[msg.user] = (userCounts[msg.user] || 0) + 1;
    }
  }

  return Object.entries(userCounts)
    .sort(([, a], [, b]) => b - a)
    .slice(0, 3)
    .map(([userId, count]) => ({ userId, count }));
}

module.exports = {
  searchWorkspace,
  checkRtsAvailable,
  findRelatedDiscussions,
  findTopicExperts,
};