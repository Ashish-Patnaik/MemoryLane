<p align="center">
  <img width="120" height="120" alt="logo" src="https://github.com/user-attachments/assets/2f6d6d8b-6bc7-47b8-afd2-9499eaf9340e" />
</p>


<h1 align="center">MemoryLane</h1>

<p align="center">
  <b>Your team's institutional memory — automatically built, always accessible, never lost.</b>
</p>

<p align="center">
  <a href="https://nodejs.org/"><img src="https://img.shields.io/badge/Node.js-v18+-339933?logo=node.js&logoColor=white" alt="Node.js Version"></a>
  <a href="https://api.slack.com/"><img src="https://img.shields.io/badge/Slack-Agent-4A154B?logo=slack&logoColor=white" alt="Slack Platform"></a>
  <a href="https://notion.so/"><img src="https://img.shields.io/badge/Notion-MCP_Database-000000?logo=notion&logoColor=white" alt="Notion Integration"></a>
  <a href="https://openrouter.ai/"><img src="https://img.shields.io/badge/OpenRouter-AI_Engine-7C3AED" alt="OpenRouter"></a>
</p>

---

## 💡 Overview

**MemoryLane** is an intelligent, privacy-first Slack Agent that selectively captures "Knowledge Moments" from your daily conversations and automatically structures them into a permanent external Wiki in Notion using the Model Context Protocol (MCP).

Chat streams are temporary, noisy, and difficult to search. MemoryLane bridges the gap between fast-moving real-time communications and long-term organizational knowledge by capturing verified snapshots and providing lightning-fast, fuzzy-search retrieval inside Slack.

---

## 🚀 Key Features

*   **Silent Context Capture (🧠 Reaction Emoji):** Hover over any thread reply and react with the brain emoji. MemoryLane automatically traces the reply back to the parent question, extracts a clean, structured Q&A card using AI, and writes it to your Notion workspace.
*   **Self-Cleaning Undo System:** If a user accidentally reacts to an outdated message or a joke, simply removing the `🧠` emoji triggers a deletion event that automatically archives the record in Notion and purges it from local memory.
*   **Fuzzy Search & Recall (`/recall`):** Query your global workspace memory using natural, conversational language. MemoryLane searches both our fast local cache and Slack's native **Real-Time Search (RTS) API** to instantly retrieve answers, tolerating typos and citing the expert and original channel.
*   **Offboarding Shield (`/handoff`):** Instantly compile every single verified contribution a departing team member has ever made into a clean, structured markdown document, with a single-click export back to Notion.
*   **The Daily Brief (`/dailybrief`):** Generates an AI-synthesized summary card of every verified decision made across your workspace in the last 24 hours to help teammates catch up without scrolling.
*   **Manual Override (`/remember`):** Allows users to manually save standalone facts directly to the memory base without needing an active thread.

---

## 🛠️ Hybrid Caching Architecture

MemoryLane is engineered for sub-millisecond retrieval speeds. Instead of making slow, rate-limited API queries to Notion on every search, it utilizes a **hybrid-caching architecture**:

```text
┌────────────────────────────────────────────────────────────────────────┐
│                        SLACK CLIENT (UX SURFACE)                       │
│                                                                        │
│   🧠 Emoji Reaction (Events)   Commands (/recall,/handoff,/remember...)│
└───────────────────┬──────────────────────────────┬─────────────────────┘
                    │                              │
                    ▼ Socket Mode / Websocket      ▼
┌────────────────────────────────────────────────────────────────────────┐
│                        MEMORYLANE ENGINE (NODE.JS)                     │
│                                                                        │
│   ┌────────────────────────┐            ┌──────────────────────────┐   │
│   │   Event Controllers    ├───────────►│    Fuzzy Memory Cache    │   │
│   │   (Bolt JS Router)     │            │    (Local Fuse.js)       │   │
│   └───────────┬────────────┘            └────────────▲─────────────┘   │
│               │                                      │                 │
│               ├─[Query RTS]──► [Slack RTS API]       │ Read Context    │
│               │                (Workspace Search)    │                 │
│               │ AI Summarization                     │                 │
│               ▼                                      │                 │
│   ┌────────────────────────┐                         │                 │
│   │     OpenRouter AI      ├─────────────────────────┘                 │
│   │   (Gemini 2.5 Flash)   │                                           │
│   └───────────┬────────────┘                                           │
│               │                                                        │
└───────────────┼────────────────────────────────────────────────────────┘
                    │ Model Context Protocol (MCP)
                    ▼
┌────────────────────────────────────────────────────────────────────────┐
│                      ENTERPRISE SYSTEM OF RECORD                       │
│                                                                        │
│                      Notion Workspace (Database)                       │
└────────────────────────────────────────────────────────────────────────┘
```

1.  **On Startup:** The Node.js engine queries Notion and downloads all historical cards, warming up an in-memory `Fuse.js` database.
2.  **During Retrieval:** `/recall` queries are resolved locally in memory instantly via `Fuse.js`, supplemented by Slack's native **Real-Time Search (RTS) API** to query unstructured workspace-wide history for wider context.
3.  **During Ingestion:** New captures are written to Notion (the permanent System of Record) and simultaneously pushed to the local cache, keeping the memory in sync without rebooting.

---

## ⚙️ Environment Variables

Create a `.env` file in the root of your project:

```env
SLACK_BOT_TOKEN=xoxb-your-bot-token
SLACK_APP_TOKEN=xapp-your-app-level-token
OPENROUTER_API_KEY=sk-or-v1-your-openrouter-key
NOTION_TOKEN=secret_your_notion_token
NOTION_DATABASE_ID=your_notion_database_id
PORT=3000
```

---

## 📦 Installation & Setup

### Prerequisites
*   Node.js v18 or higher (Node 20 LTS recommended)
*   A Slack Workspace where you have permission to install apps
*   A Notion Workspace

### 1. Project Setup
```bash
git clone https://github.com/username/memorylane-slack-agent.git
cd memorylane-slack-agent
npm install
```

### 2. Generate Notion Schema
Create an empty page in Notion, share your integration connection with it, and run the following command to automatically generate the required database schema:
```bash
node -r dotenv/config -e "require('./notion.js').setupDatabase('YOUR_NOTION_PAGE_ID_HERE')"
```
Copy the printed Database ID and add it to your `.env` file.

### 3. Run the App
```bash
npm start
```
