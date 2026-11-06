# Make scenario templates for looot

13 scenario blueprints for sales and marketing data jobs, built on the [looot custom app](../README.md). Each one is a `blueprint.json` you import with Scenarios > Create a new scenario > ... > Import blueprint. Every data call goes to looot: one connection and one prepaid balance, with a cost cap on each call and $0 for a miss.

Status: built from the module files in `src/` and checked by `test/templates.test.mjs`. None of them has run in Make yet, because the looot app is not in a Make account yet. Read "Not checked yet" before you rely on one.

| Template | What it does | Starts from | Modules | Usual cost | Before / after |
|---|---|---|---|---|---|
| [google-maps-leads-to-sheets](google-maps-leads-to-sheets/blueprint.json) | Find local business leads on Google Maps and add them to Google Sheets with looot | Google Sheets, new rows in Searches | 6 | $0.001 per search | [n8n #3443 Scrape business leads from Google Maps (72,143 views)](https://n8n.io/workflows/3443): 14 nodes / 6 modules, 2 data accounts / 1 |
| [deep-research-webhook](deep-research-webhook/blueprint.json) | Answer a research question with Google results and page reads from looot and OpenAI | Webhook with {"question": "..."} | 7 | about $0.002 per question | [n8n #2883 Open Deep Research (38,892 views)](https://n8n.io/workflows/2883): 14 nodes / 7 modules, 2 data accounts / 1 |
| [competitor-cards-to-sheets](competitor-cards-to-sheets/blueprint.json) | Research competitors from a Google Sheets list with looot company data, news and pricing pages | Google Sheets, new rows in Competitors | 6 | about $0.003 per competitor | [n8n #2354 Competitor research with Exa.ai, Notion and AI agents (29,279 views)](https://n8n.io/workflows/2354): 30 nodes / 6 modules, 3 data accounts / 1 |
| [work-email-waterfall-sheets](work-email-waterfall-sheets/blueprint.json) | Find and verify work emails for new Google Sheets rows with looot | Google Sheets, new rows in Leads | 6 | about $0.005 per found email | new, no original to count |
| [form-lead-to-hubspot](form-lead-to-hubspot/blueprint.json) | Verify and enrich new form leads with looot, then create HubSpot contacts | Webhook with {"email", "first_name", "last_name"} | 4 | about $0.0034 per lead | [n8n #2116 Verify emails and enrich new form leads into HubSpot (3,432 views)](https://n8n.io/workflows/2116): 7 nodes / 4 modules, 2 data accounts / 1 |
| [verify-sheet-emails](verify-sheet-emails/blueprint.json) | Verify email addresses in Google Sheets with looot before you send | Google Sheets, new rows in Emails | 3 | $0.00145 per address | new, no original to count |
| [competitor-news-to-slack](competitor-news-to-slack/blueprint.json) | Post a daily Slack digest of Google News articles about a competitor with looot | Schedule, every day | 3 | $0.001 per competitor a day | new, no original to count |
| [hiring-signal-to-slack](hiring-signal-to-slack/blueprint.json) | Get a Slack alert when a target account posts sales or RevOps jobs, with looot | Schedule, every day | 3 | about $0.0005 per account a day | new, no original to count |
| [tech-stack-to-sheets](tech-stack-to-sheets/blueprint.json) | Add the tech stack of companies in Google Sheets with looot | Google Sheets, new rows in Accounts | 4 | under $0.01 per company | new, no original to count |
| [signup-qualifier](signup-qualifier/blueprint.json) | Qualify new signups with looot and alert Slack on hot leads | Webhook with {"email", "name"} | 7 | under $0.01 per signup | new, no original to count |
| [pre-call-brief-to-slack](pre-call-brief-to-slack/blueprint.json) | Send a pre-call company brief to Slack with looot company data, news and LinkedIn posts | Webhook with {"domain", "linkedin_url", "meeting"} | 6 | about $0.01 per company | [n8n #2125 Summarize social media activity of a company before a call (10,796 views)](https://n8n.io/workflows/2125): 18 nodes / 6 modules, 2 data accounts / 1 |
| [linkedin-urls-to-emails](linkedin-urls-to-emails/blueprint.json) | Find and verify work emails from LinkedIn profile URLs in Google Sheets with looot | Google Sheets, new rows in Profiles | 4 | about $0.005 per found email | new, no original to count |
| [run-spend-log](run-spend-log/blueprint.json) | Log every finished looot run and its cost in Google Sheets | looot, Watch finished runs | 2 | free | new, no original to count |

Before and after counts only appear where an n8n gallery template does the same job. The n8n numbers come from that template's JSON on 2026-10-31, sticky notes not counted. A Make module and an n8n node are not the same unit, so read the column as "how many steps you wire up". Prices are the cheapest provider in looot's public catalog (`https://api.looot.ai/v1/catalog/overview?depth=jobs`) on 2026-10-31.

## Import one

1. Install the looot app in your Make organization (invite link, or `node scripts/import.mjs --apply`, see the main README).
2. Make gives the app its own id, shown in the app's URL and in any blueprint you export from it. Rewrite the blueprints to that id:
   ```bash
   node templates/set-app-id.mjs looot-abc123      # your id; rewrites app#looot: in every blueprint
   ```
3. In Make: Scenarios > Create a new scenario > ... (bottom bar) > Import blueprint, pick the file.
4. Open each module and pick or create the connection (looot, Google, OpenAI, Slack, HubSpot). Replace every `YOUR_...` value: spreadsheet, channel, competitor or company name.
5. Run once, check the destination, then set the schedule. Webhook scenarios run on each request; the others need a schedule (every 15 minutes for sheets, daily for the news and hiring ones).

Sheets and what each template leaves out:

- **google-maps-leads-to-sheets**. sheet `Searches` with headers `business_type`, `place`. sheet `Leads` with headers `name`, `address`, `phone`, `website`, `rating`, `search`, `looot_cost_usd`. Leaves out: Does not read each website for an email like the n8n original. Add Find a work email after the iterator if you have a contact name..
- **deep-research-webhook**. Leaves out: One search round, not the iterative query plan of the original..
- **competitor-cards-to-sheets**. sheet `Competitors` with headers `domain`, `name`, `industry`, `size`, `card`, `looot_cost_usd`. Leaves out: You list the competitors; it does not find them. Writes to Google Sheets, not Notion..
- **work-email-waterfall-sheets**. sheet `Leads` with headers `first_name`, `last_name`, `domain`, `email`, `email_status`, `looot_cost_usd`.
- **verify-sheet-emails**. sheet `Emails` with headers `email`, `email_status`, `deliverable`, `looot_cost_usd`.
- **tech-stack-to-sheets**. sheet `Accounts` with headers `domain`, `tech_stack`, `looot_cost_usd`.
- **signup-qualifier**. sheet `Signups` with headers `email`, `email_status`, `company`, `industry`, `size`, `score`, `looot_cost_usd`.
- **pre-call-brief-to-slack**. Leaves out: Starts from a webhook instead of Google Calendar and leaves out X posts. Replace the webhook with Google Calendar Watch events if you want it on every meeting..
- **linkedin-urls-to-emails**. sheet `Profiles` with headers `linkedin_url`, `email`, `email_status`, `looot_cost_usd`.
- **run-spend-log**. sheet `Runs` with headers `run_id`, `endpoint_id`, `provider_id`, `status`, `cost_usd`, `completed_at`.

## Not checked yet

- No blueprint has been imported or run in Make. Module names and versions for Google Sheets, Slack, HubSpot, OpenAI, Webhooks, JSON, the iterator, the router and the text aggregator come from Make's own examples in `integromat/make-skills` (read 2026-10-31). Make may ask you to re-pick a field after import.
- The `app#looot` prefix is how Make writes custom app modules in a blueprint. Whether an approved, public looot app keeps that prefix is not known yet.
- The run module's Input is JSON text, which the module parses and sends as an object. A mapped value that contains a double quote breaks that JSON. Clean such values with `replace()` first.
- Paths such as `{{2.result.organic}}` depend on the provider that answered. The templates pass `toString(result)` to OpenAI where the shape varies.
- The HubSpot `company` and `website` fields and OpenAI's `json_object` response format are taken from the apps' usual field names, not read from Make.

## Rebuild

```bash
node templates/build.mjs     # writes every blueprint.json and this README
npm test                     # includes test/templates.test.mjs
```
