# GapSpark API

> Cloudflare Workers backend for [GapSpark](https://github.com/ai-autosite/gapspark-ios) — analyzes App Store reviews to surface user pain points using a hybrid AI architecture.

[![Cloudflare Workers](https://img.shields.io/badge/Cloudflare-Workers-orange.svg)](https://workers.cloudflare.com/)
[![Hono](https://img.shields.io/badge/Hono-4.x-blue.svg)](https://hono.dev/)
[![License](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)

## What it does

1. **Fetches** App Store reviews via Apple RSS API (50 apps across 10 categories)
2. **Analyzes sentiment** with Workers AI (DistilBERT)
3. **Generates pain points** with Workers AI (Llama 3.2 1B) using rule-based severity scoring
4. **Provides Deep Dive** analysis on demand via Claude Haiku 4.5 API
5. **Authenticates** users with Sign in with Apple (server-side JWT validation)
6. **Serves** REST endpoints to the iOS app

## Architecture

```
┌─────────────────────────────────────┐
│  Cloudflare Worker (Hono router)    │
│                                      │
│  ├─ Workers AI (native binding)      │  Free
│  │   • DistilBERT (sentiment)        │
│  │   • Llama 3.2 1B (summaries)      │
│  │                                   │
│  ├─ Claude API (on-demand)           │  ~$0.01/req
│  │   • Haiku 4.5 (deep analysis)     │
│  │                                   │
│  ├─ JWT validation (Apple tokens)    │
│  ├─ Rate limiting (3 deep dives/day) │
│  └─ Cron triggers (every 6 hours)    │
└─────────────────┬───────────────────┘
                  │
                  ▼
        ┌─────────────────┐
        │  Cloudflare D1  │
        │   (SQLite)      │
        └─────────────────┘
```

## Tech Stack

- **Runtime:** Cloudflare Workers (V8 isolates, edge deployment)
- **Framework:** [Hono](https://hono.dev/) 4.x
- **Database:** Cloudflare D1 (SQLite at the edge)
- **AI:** Workers AI (native binding), Claude Haiku 4.5 API
- **Auth:** Sign in with Apple + JWT (jose library)
- **Language:** TypeScript

## API Endpoints

### Public (no auth)
```
GET  /api/health                          # DB health + stats
GET  /api/search?q=<query>                # Unified search (topics + apps + pain points)
GET  /api/topics                          # Popular topics
GET  /api/topics/:topic/apps              # Apps for a topic
GET  /api/topics/:topic/pain-points       # Pain points for a topic
GET  /api/pain-points                     # Pain point list
GET  /api/pain-points/:id                 # Single pain point
GET  /api/apps                            # App list
GET  /api/apps/:id                        # Single app
GET  /api/apps/:id/pain-points            # Pain points for an app
GET  /api/categories                      # Category list
GET  /api/trends                          # Top trending pain points
```

### Authentication
```
POST /api/auth/apple                      # Validate Apple identity token → issue session JWT
```

### Authenticated (Bearer JWT)
```
GET    /api/pain-points/:id/deep-dive     # Run Claude Deep Dive (3/day limit)
GET    /api/user/saved                    # Saved ideas
POST   /api/user/saved                    # Save an idea
DELETE /api/user/saved/:id                # Delete saved idea
POST   /api/apps/request                  # Request a new app to be tracked
GET    /api/user/requests                 # User's app requests
```

### Debug (development only)
```
GET /api/debug/fetch-reviews              # Manual review fetch
GET /api/debug/analyze-sentiment          # Manual sentiment analysis
GET /api/debug/generate-pain-points       # Manual pain point generation
GET /api/debug/run-pipeline               # Full pipeline (cron equivalent)
GET /api/debug/dedup-pain-points          # Cleanup duplicate pain points
GET /api/debug/recalculate-severity       # Rule-based severity recalculation
GET /api/debug/stats                      # Detailed DB stats
GET /api/debug/deep-dive/:id              # Test Deep Dive (no auth)
```

## Setup

### Requirements
- Node.js 20+
- Cloudflare account (free tier works)
- Anthropic API key for Claude Deep Dive

### Install
```bash
git clone https://github.com/ai-autosite/gapspark-api.git
cd gapspark-api
npm install
```

### Create the D1 database
```bash
npx wrangler d1 create gapspark-db
# Copy the database_id into wrangler.jsonc
```

### Apply schema
```bash
npx wrangler d1 execute gapspark-db --remote --file=schema.sql
```

### Seed initial app list (optional)
```bash
node seed-apps.mjs
```

### Set secrets
```bash
npx wrangler secret put CLAUDE_API_KEY    # Anthropic API key
npx wrangler secret put JWT_SECRET        # Random 32+ char string
```

### Update wrangler.jsonc
Set `APPLE_BUNDLE_ID` to your iOS app's bundle ID.

### Deploy
```bash
npx wrangler deploy --minify
```

### Local development
```bash
npx wrangler dev                    # Local server on :8787
npx wrangler dev --test-scheduled   # Test cron triggers
```

## Pain Point Scoring

Severity is calculated using a rule-based formula (not AI):

```
severity_score = starPenalty × keywordSeverity × frequencyWeight × recencyBoost
```

- **starPenalty:** 1★ → 1.0, 2★ → 0.8, ..., 5★ → 0.2
- **keywordSeverity:** crash/data_loss → 1.0, bug/sync → 0.7, annoying → 0.5, wish → 0.3
- **frequencyWeight:** log(1 + matching_reviews) / log(1 + total_reviews)
- **recencyBoost:** ≤30 days → 1.2, ≤90 days → 1.0, older → 0.8

Final score is clamped to 0.05–1.0 for natural distribution.

## Cron Pipeline

Runs every 6 hours (`0 */6 * * *`):
1. **Fetch reviews** from Apple RSS API (20 apps per cycle)
2. **Analyze sentiment** with DistilBERT (up to 500 reviews)
3. **Generate pain points** with Llama 3.2 1B + rule-based scoring (up to 10 apps)

Stays within Workers AI free tier (10,000 neurons/day).

## Database Schema

See [schema.sql](schema.sql) for the full schema. Key tables:
- `tracked_apps` — app catalog with tags
- `reviews` — raw reviews (never exposed to users)
- `pain_points` — AI-analyzed user complaints (what users see)
- `deep_dives` — Claude API analysis cache
- `users` — Sign in with Apple users
- `saved_ideas` — user-saved app ideas
- `app_requests` — user requests for new apps to track

## Cost (Free Tier)

| Resource | Free Limit | Estimated Use |
|----------|-----------|---------------|
| Worker requests | 100K/day | ~5K/day |
| D1 reads | 5M/day | ~10K/day |
| D1 writes | 100K/day | ~2K/day |
| Workers AI | 10K neurons/day | ~5.8K/cycle |
| Claude API | Pay-as-you-go | ~$0.01/Deep Dive |

## License

MIT — see [LICENSE](LICENSE).

---

Built by [AI AutoSite](https://github.com/ai-autosite) with Claude.
