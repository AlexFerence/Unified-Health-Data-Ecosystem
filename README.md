
## Quickstart

### 1) Install
Requirements: Node.js 18+ and npm.

```bash
npm install
```

### 2) Create your `.env`
Copy `.env.example` to `.env`, then choose **one** LLM setup:

### Option A (recommended): Local model (LM Studio)
Use this if you want local inference.

```env
LOCAL_LLM_MODEL="mistralai/ministral-3-14b-reasoning"
LOCAL_EMBEDDING_MODEL="text-embedding-nomic-embed-text-v1"
LOCAL_LLM_URL="http://localhost:1234/v1"
```
I reccomend using LM Studio for local LLM setup
<img width="884" height="321" alt="Screenshot 2026-06-17 at 3 05 32 PM" src="https://github.com/user-attachments/assets/02ef88f7-70bf-4bec-8698-12ba0cc9bd4b" />

### Option B: Cloud model (Anthropic)
Use this if you prefer hosted inference.

```env
ANTHROPIC_API_KEY="sk-..."
```

### 3) Add optional tool keys
Only add keys for tools you plan to use.

| Tool | Env var(s) | Setup link | Notes |
| --- | --- | --- | --- |
| Perplexity | `PERPLEXITY_API_KEY` | [Perplexity API](https://docs.perplexity.ai/guides/getting-started), [Console](https://console.perplexity.ai) | Used by `perplexity_web_search`. |
| Fitbit | `FITBIT_CLIENT_ID`, `FITBIT_CLIENT_SECRET` | [Fitbit setup](https://dev.fitbit.com/build/reference/web-api/developer-guide/getting-started/), [App dashboard](https://dev.fitbit.com/apps) | Callback: `http://localhost:8765/callback` |
| Withings | `WITHINGS_CLIENT_ID`, `WITHINGS_CLIENT_SECRET` | [Withings developer portal](https://developer.withings.com/) | Callback: `http://localhost:8766/callback` |
| Todoist | `TODOIST_KEY` | [Todoist integrations](https://app.todoist.com/app/settings/integrations) | Personal token is easiest. |

### 4) Run
```bash
npm run server
```

Open: `http://localhost:3000`

### Notes
- If you use PostgreSQL on macOS, [Postgres.app](https://postgresapp.com/) is the easiest install path.
- You can start with only one LLM option and add tool keys later.
- Tools will only work if you provide the necessary API keys in the `.env` file.


