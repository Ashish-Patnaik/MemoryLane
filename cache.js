/**
 * MemoryLane — Local Fuse.js Cache
 * Downloads Notion data on startup for lightning-fast, fuzzy retrieval.
 */

const Fuse = require('fuse.js');
const notion = require('./notion');

let fuse;
let knowledgeBase = [];

// 1. Initialize on startup
async function initializeCache() {
  console.log('⏳ Downloading Memory Base from Notion into local memory...');
  knowledgeBase = await notion.getAllCards();

  const options = {
    keys: ['question', 'answer', 'tags', 'expert'], // Tell Fuse which fields to search
    threshold: 0.4, // 0.0 is exact match, 1.0 is match anything. 0.4 is a great fuzzy balance.
    ignoreLocation: true,
  };

  fuse = new Fuse(knowledgeBase, options);
  console.log(`✅ Loaded ${knowledgeBase.length} cards into Fuse.js memory cache!`);
}

// 2. Add new cards to cache without needing to reboot the app
function addCardToCache(card) {
  knowledgeBase.push(card);
  if (fuse) fuse.add(card);
  console.log(`💾 Added new card to local cache: "${card.question}"`);
}

// 3. Search instantly
function searchCache(query, limit = 5) {
  if (!fuse) return [];
  const results = fuse.search(query);
  
  // Fuse wraps results in an 'item' object. We map it back to just the cards.
  return results.slice(0, limit).map(r => r.item);
}
// 4. Remove card from cache
function removeCardFromCache(messageLink) {
  // Filter out the deleted card
  knowledgeBase = knowledgeBase.filter(c => c.sourceLink !== messageLink);
  
  // Rebuild the Fuse index
  const options = {
    keys: ['question', 'answer', 'tags', 'expert', 'channel'],
    threshold: 0.4,
    ignoreLocation: true,
  };
  fuse = new Fuse(knowledgeBase, options);
  console.log(`🗑️ Removed card from local cache.`);
}

module.exports = { initializeCache, addCardToCache, searchCache, removeCardFromCache };