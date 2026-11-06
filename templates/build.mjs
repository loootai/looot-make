// Builds every templates/<slug>/blueprint.json and templates/README.md from the specs in this file.
//   node templates/build.mjs
// The blueprints use the scenario export format (Scenario > ... > Export blueprint). looot modules are
// written as app#looot:<module>. Make gives your copy of the custom app its own id; run
//   node templates/set-app-id.mjs <your app id>
// to rewrite them before you import. No blueprint carries a connection id, a spreadsheet id or a channel id.
import { writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = path.dirname(fileURLToPath(import.meta.url));
export const APP = 'app#looot';

// ---- module helpers -------------------------------------------------------------------------------
const looot = (id, fn, mapper, extra = {}) => ({ id, module: `${APP}:${fn}`, version: 1, parameters: {}, mapper, ...extra });
const run = (id, endpointId, input, maxCostUsd, extra = {}) =>
  looot(id, 'runOperation', { endpointId, inputMode: 'json', input, fallback: true, maxCostUsd, wait: 20 }, extra);
const webhook = (id) => ({ id, module: 'gateway:CustomWebHook', version: 1, parameters: { hook: null, maxResults: 1 }, mapper: {} });
const respond = (id, body) => ({ id, module: 'gateway:WebhookRespond', version: 1, parameters: {}, mapper: { status: '200', body, headers: [{ key: 'content-type', value: 'text/markdown; charset=utf-8' }] } });
const watchRows = (id, sheetId, limit = 10) => ({
  id, module: 'google-sheets:watchRows', version: 2,
  parameters: { from: 'drive', mode: 'select', spreadsheetId: 'YOUR_SPREADSHEET_ID', sheetId, includesHeaders: true, tableFirstRow: 'A1:Z1', limit },
  mapper: {},
});
const addRow = (id, sheetId, values, extra = {}) => ({
  id, module: 'google-sheets:addRow', version: 2, parameters: {},
  mapper: { from: 'drive', mode: 'select', spreadsheetId: 'YOUR_SPREADSHEET_ID', sheetId, includesHeaders: true, insertDataOption: 'INSERT_ROWS', valueInputOption: 'USER_ENTERED', values },
  ...extra,
});
const updateRow = (id, watchId, values, extra = {}) => ({
  id, module: 'google-sheets:updateRow', version: 2, parameters: {},
  mapper: {
    mode: 'map',
    spreadsheetId: `{{${watchId}.\`__SPREADSHEET_ID__\`}}`,
    sheetId: `{{${watchId}.\`__SHEET__\`}}`,
    rowNumber: `{{${watchId}.\`__ROW_NUMBER__\`}}`,
    tableFirstRow: 'A1:Z1',
    valueInputOption: 'USER_ENTERED',
    values,
  },
  ...extra,
});
const openai = (id, content, extra = {}, responseFormat = 'text') => ({
  id, module: 'openai-gpt-3:CreateCompletion', version: 1, parameters: {},
  mapper: { select: 'chat', model: 'gpt-4o-mini', messages: [{ role: 'user', content }], max_tokens: '1200', temperature: '0.2', n_completions: '1', response_format: responseFormat },
  ...extra,
});
const parseJson = (id, json) => ({ id, module: 'json:ParseJSON', version: 1, parameters: {}, mapper: { json } });
const iterator = (id, array) => ({ id, module: 'builtin:BasicFeeder', version: 1, parameters: {}, mapper: { array } });
const textAgg = (id, feeder, value) => ({ id, module: 'util:TextAggregator', version: 1, parameters: { feeder, rowSeparator: '\n' }, mapper: { value } });
const slack = (id, text, extra = {}) => ({ id, module: 'slack:CreateMessage', version: 4, parameters: {}, mapper: { channel: 'YOUR_CHANNEL_ID', text }, ...extra });
const hubspotContact = (id, mapper, extra = {}) => ({ id, module: 'hubspotcrm:createContact', version: 2, parameters: {}, mapper, ...extra });
const router = (id, routes) => ({ id, module: 'builtin:BasicRouter', version: 1, parameters: {}, mapper: null, routes: routes.map((flow) => ({ flow })) });
const filter = (name, ...conditions) => ({ filter: { name, conditions: [conditions] } });
const exists = (a) => ({ a, o: 'exist' });
const missing = (a) => ({ a, o: 'notexist' });
const domainOf = (email) => `{{last(split(${email}; "@"))}}`;
const col = (watchId, i) => `{{${watchId}.\`${i}\`}}`;

// ---- the templates ---------------------------------------------------------------------------------
// before: counts from the n8n template's own JSON (nodes without sticky notes, data API accounts),
// read on 2026-10-31, only where the Make scenario does the same job.
export const TEMPLATES = [
  {
    slug: 'google-maps-leads-to-sheets',
    title: 'Find local business leads on Google Maps and add them to Google Sheets with looot',
    scenarioDescription: 'Searches Google Maps through looot for each new row in Searches and adds one row per business to Leads.',
    description: 'Each new row in the Searches sheet (business type, place) runs one Google Maps search through looot. An OpenAI step turns the raw result into a list, and every business lands in the Leads sheet with name, address, phone, website, rating and what the search cost. One looot connection replaces the Apify and SerpAPI accounts this job usually needs. Cost: about $0.001 per search, capped at $0.01.',
    sheets: { Searches: ['business_type', 'place'], Leads: ['name', 'address', 'phone', 'website', 'rating', 'search', 'looot_cost_usd'] },
    trigger: 'Google Sheets, new rows in Searches',
    apps: ['Google Sheets', 'OpenAI', 'looot'],
    cost: '$0.001 per search',
    before: { label: 'n8n #3443 Scrape business leads from Google Maps (72,143 views)', url: 'https://n8n.io/workflows/3443', nodes: 14, dataAccounts: 2 },
    gaps: 'Does not read each website for an email like the n8n original. Add Find a work email after the iterator if you have a contact name.',
    flow: [
      watchRows(1, 'Searches'),
      run(2, 'job:maps.local.search', `{"query": "${col(1, 0)} in ${col(1, 1)}"}`, 0.01),
      openai(3, 'Turn this Google Maps search result into JSON of the form {"leads": [{"name": "", "address": "", "phone": "", "website": "", "rating": ""}]}. Use only data that is in the result and leave a field empty when it is missing.\n\n{{toString(2.result)}}', {}, 'json_object'),
      parseJson(4, '{{3.result}}'),
      iterator(5, '{{4.leads}}'),
      addRow(6, 'Leads', { 0: '{{5.name}}', 1: '{{5.address}}', 2: '{{5.phone}}', 3: '{{5.website}}', 4: '{{5.rating}}', 5: `${col(1, 0)} in ${col(1, 1)}`, 6: '{{2.actualCost}}' }),
    ],
  },
  {
    slug: 'deep-research-webhook',
    title: 'Answer a research question with Google results and page reads from looot and OpenAI',
    scenarioDescription: 'A webhook question runs one Google search through looot, reads the top 5 pages, and returns a sourced report.',
    description: 'Send a question to the webhook. looot runs a Google search, the iterator reads the top 5 result pages through looot, and OpenAI writes a short report with a sources list from what those pages say. The report comes back as the webhook response. One looot connection covers search and page reads, so there is no SerpAPI or Jina account. Cost: about $0.002 per question in data, capped at $0.06.',
    trigger: 'Webhook with {"question": "..."}',
    apps: ['Webhooks', 'OpenAI', 'looot'],
    cost: 'about $0.002 per question',
    before: { label: 'n8n #2883 Open Deep Research (38,892 views)', url: 'https://n8n.io/workflows/2883', nodes: 14, dataAccounts: 2 },
    gaps: 'One search round, not the iterative query plan of the original.',
    flow: [
      webhook(1),
      run(2, 'job:google.serp.organic', '{"query": "{{1.question}}"}', 0.01),
      iterator(3, '{{slice(2.result.organic; 0; 5)}}'),
      run(4, 'job:web.scrape.markdown', '{"url": "{{3.link}}"}', 0.01),
      textAgg(5, 3, 'SOURCE {{3.link}}\n{{substring(toString(4.result); 0; 6000)}}'),
      openai(6, 'Answer this question in markdown: a 3 line summary, findings, then a Sources list with every URL you used. Only state what the sources say.\n\nQuestion: {{1.question}}\n\n{{5.text}}'),
      respond(7, '{{6.result}}'),
    ],
  },
  {
    slug: 'competitor-cards-to-sheets',
    title: 'Research competitors from a Google Sheets list with looot company data, news and pricing pages',
    scenarioDescription: 'For each competitor domain added to the sheet, looot pulls company data, news and the pricing page, and OpenAI writes the card.',
    description: 'Add a competitor domain to the Competitors sheet. looot returns company data, recent Google News articles and the text of the pricing page, then OpenAI writes a short card with size, pricing, products and recent news. The card and the cost go back into the same row. One looot connection replaces the Exa, Firecrawl and SerpAPI accounts. Cost: about $0.003 per competitor, capped at $0.03.',
    sheets: { Competitors: ['domain', 'name', 'industry', 'size', 'card', 'looot_cost_usd'] },
    trigger: 'Google Sheets, new rows in Competitors',
    apps: ['Google Sheets', 'OpenAI', 'looot'],
    cost: 'about $0.003 per competitor',
    before: { label: 'n8n #2354 Competitor research with Exa.ai, Notion and AI agents (29,279 views)', url: 'https://n8n.io/workflows/2354', nodes: 30, dataAccounts: 3 },
    gaps: 'You list the competitors; it does not find them. Writes to Google Sheets, not Notion.',
    flow: [
      watchRows(1, 'Competitors'),
      looot(2, 'enrichCompany', { domain: col(1, 0), fallback: true, maxCostUsd: 0.01, wait: 20 }),
      run(3, 'job:news.search', `{"query": "{{ifempty(2.companyName; ${col(1, 0).slice(2, -2)})}}"}`, 0.01),
      run(4, 'job:web.scrape.markdown', `{"url": "https://${col(1, 0)}/pricing"}`, 0.01),
      openai(5, 'Write a competitor card under 200 words: overview, size and funding, pricing, products, recent news. Only use the data below and say when something is missing.\n\nCompany: {{toString(2.result)}}\n\nNews: {{substring(toString(3.result); 0; 4000)}}\n\nPricing page: {{substring(toString(4.result); 0; 6000)}}'),
      updateRow(6, 1, { 1: '{{2.companyName}}', 2: '{{2.industry}}', 3: '{{2.size}}', 4: '{{5.result}}', 5: '{{2.actualCost + 3.actualCost + 4.actualCost}}' }),
    ],
  },
  {
    slug: 'work-email-waterfall-sheets',
    title: 'Find and verify work emails for new Google Sheets rows with looot',
    scenarioDescription: 'Finds the work email for each new lead row, verifies it and writes email, status and cost back to the row.',
    description: 'Add a lead with first name, last name and company domain to the Leads sheet. looot looks for the work email and tries the next email finder when one misses, inside a $0.05 cap. A found address is verified, and the row gets the email, its status (valid, invalid, catch_all, risky, unknown) and the cost. Rows with no email found are marked not_found. A miss costs $0. Cost: about $0.005 for a found and verified email.',
    sheets: { Leads: ['first_name', 'last_name', 'domain', 'email', 'email_status', 'looot_cost_usd'] },
    trigger: 'Google Sheets, new rows in Leads',
    apps: ['Google Sheets', 'looot'],
    cost: 'about $0.005 per found email',
    flow: [
      watchRows(1, 'Leads', 50),
      looot(2, 'findWorkEmail', { first_name: col(1, 0), last_name: col(1, 1), domain: col(1, 2), fallback: true, maxCostUsd: 0.05, wait: 20 }, filter('No email yet', missing(col(1, 3)))),
      router(3, [
        [
          looot(4, 'verifyEmail', { email: '{{2.email}}', fallback: true, maxCostUsd: 0.01, wait: 20 }, filter('Email found', exists('{{2.email}}'))),
          updateRow(5, 1, { 3: '{{2.email}}', 4: '{{4.emailStatus}}', 5: '{{2.actualCost + 4.actualCost}}' }),
        ],
        [
          updateRow(6, 1, { 4: 'not_found', 5: '{{2.actualCost}}' }, filter('No email found', missing('{{2.email}}'))),
        ],
      ]),
    ],
  },
  {
    slug: 'form-lead-to-hubspot',
    title: 'Verify and enrich new form leads with looot, then create HubSpot contacts',
    scenarioDescription: 'A form webhook lead is verified and enriched through looot; only deliverable leads become HubSpot contacts.',
    description: 'Point your form at the webhook. looot verifies the email and stops leads whose address is not valid. Valid leads get company data from the email domain, and a HubSpot contact is created with name, email, company and website. One looot connection replaces the Clearbit and Hunter accounts the classic version needs. Cost: about $0.0034 per lead.',
    trigger: 'Webhook with {"email", "first_name", "last_name"}',
    apps: ['Webhooks', 'HubSpot CRM', 'looot'],
    cost: 'about $0.0034 per lead',
    before: { label: 'n8n #2116 Verify emails and enrich new form leads into HubSpot (3,432 views)', url: 'https://n8n.io/workflows/2116', nodes: 7, dataAccounts: 2 },
    flow: [
      webhook(1),
      looot(2, 'verifyEmail', { email: '{{1.email}}', fallback: true, maxCostUsd: 0.01, wait: 20 }),
      looot(3, 'enrichCompany', { domain: domainOf('1.email'), fallback: true, maxCostUsd: 0.01, wait: 20 }, filter('Email is valid', { a: '{{2.emailStatus}}', o: 'text:equal', b: 'valid' })),
      hubspotContact(4, { email: '{{1.email}}', firstname: '{{1.first_name}}', lastname: '{{1.last_name}}', company: '{{3.companyName}}', website: '{{3.companyDomain}}' }),
    ],
  },
  {
    slug: 'verify-sheet-emails',
    title: 'Verify email addresses in Google Sheets with looot before you send',
    scenarioDescription: 'Verifies each new email in the sheet and writes the status, a deliverable flag and the cost back to the row.',
    description: 'Add email addresses to the Emails sheet. looot checks each one and writes back its status (valid, invalid, catch_all, risky, unknown), a deliverable yes or no and the cost, so you can filter the list before a campaign. A failed check costs $0. Cost: $0.00145 per address.',
    sheets: { Emails: ['email', 'email_status', 'deliverable', 'looot_cost_usd'] },
    trigger: 'Google Sheets, new rows in Emails',
    apps: ['Google Sheets', 'looot'],
    cost: '$0.00145 per address',
    flow: [
      watchRows(1, 'Emails', 100),
      looot(2, 'verifyEmail', { email: col(1, 0), fallback: true, maxCostUsd: 0.01, wait: 20 }),
      updateRow(3, 1, { 1: '{{2.emailStatus}}', 2: '{{2.deliverable}}', 3: '{{2.actualCost}}' }),
    ],
  },
  {
    slug: 'competitor-news-to-slack',
    title: 'Post a daily Slack digest of Google News articles about a competitor with looot',
    scenarioDescription: 'Once a day, searches Google News for one competitor through looot and posts up to 5 articles to Slack.',
    description: 'Set the competitor name and schedule the scenario daily. looot searches Google News, OpenAI keeps up to 5 relevant articles as Slack lines with title and link, and the digest goes to your channel. Days with no news post nothing. Clone the scenario for each competitor. Cost: $0.001 per day in data.',
    trigger: 'Schedule, every day',
    apps: ['OpenAI', 'Slack', 'looot'],
    cost: '$0.001 per competitor a day',
    flow: [
      run(1, 'job:news.search', '{"query": "YOUR_COMPETITOR"}', 0.01),
      openai(2, 'From this Google News result, list up to 5 articles about YOUR_COMPETITOR from the last 2 days as Slack lines: "- <url|title> (source)". Reply with NONE and nothing else when there is no such article.\n\n{{substring(toString(1.result); 0; 8000)}}'),
      slack(3, '*YOUR_COMPETITOR in the news*\n{{2.result}}\n_looot cost ${{1.actualCost}}_', filter('Has news', { a: '{{2.result}}', o: 'text:notequal', b: 'NONE' })),
    ],
  },
  {
    slug: 'hiring-signal-to-slack',
    title: 'Get a Slack alert when a target account posts sales or RevOps jobs, with looot',
    scenarioDescription: 'Once a day, searches job postings at one target account through looot and alerts Slack on sales or RevOps roles.',
    description: 'Set the target company and schedule the scenario daily. looot searches job postings for that company, OpenAI keeps the sales, SDR and RevOps roles, and a Slack message lists them with links. Hiring for those roles is a common buying signal for sales tools. Clone the scenario per account. Cost: about $0.0005 per account a day.',
    trigger: 'Schedule, every day',
    apps: ['OpenAI', 'Slack', 'looot'],
    cost: 'about $0.0005 per account a day',
    flow: [
      run(1, 'job:jobs.search', '{"query": "sales", "company": "YOUR_TARGET_COMPANY"}', 0.01),
      openai(2, 'From these job postings, keep roles at YOUR_TARGET_COMPANY whose title is about sales, SDR, BDR, account executive, RevOps or growth. List them as Slack lines "- <url|title> (location)". Reply NONE and nothing else when none match.\n\n{{substring(toString(1.result); 0; 8000)}}'),
      slack(3, '*YOUR_TARGET_COMPANY is hiring*\n{{2.result}}', filter('Has matches', { a: '{{2.result}}', o: 'text:notequal', b: 'NONE' })),
    ],
  },
  {
    slug: 'tech-stack-to-sheets',
    title: 'Add the tech stack of companies in Google Sheets with looot',
    scenarioDescription: 'Looks up the technologies a company website uses for each new domain and writes them to the row.',
    description: 'Add a company domain to the Accounts sheet. looot returns the technologies its website uses, OpenAI shortens the answer to a comma-separated list, and the row gets the list and the cost. Use it to sort accounts by the tools they run. Cost: under a cent per company.',
    sheets: { Accounts: ['domain', 'tech_stack', 'looot_cost_usd'] },
    trigger: 'Google Sheets, new rows in Accounts',
    apps: ['Google Sheets', 'OpenAI', 'looot'],
    cost: 'under $0.01 per company',
    flow: [
      watchRows(1, 'Accounts', 50),
      run(2, 'job:company.technographics', `{"domain": "${col(1, 0)}"}`, 0.02),
      openai(3, 'List the technology names in this result as one comma-separated line, most important first, at most 30. Reply with an empty line when there are none.\n\n{{substring(toString(2.result); 0; 8000)}}'),
      updateRow(4, 1, { 1: '{{3.result}}', 2: '{{2.actualCost}}' }),
    ],
  },
  {
    slug: 'signup-qualifier',
    title: 'Qualify new signups with looot and alert Slack on hot leads',
    scenarioDescription: 'Verifies a signup email, enriches the company, scores it with OpenAI, logs every signup and alerts Slack on hot ones.',
    description: 'Send each new signup to the webhook. looot verifies the email and, for work addresses, returns company data from the domain. OpenAI scores the signup hot, warm or cold against your ideal customer, every signup is logged in Google Sheets, and hot ones go to Slack. Free email addresses skip the company lookup. Cost: under a cent per signup.',
    sheets: { Signups: ['email', 'email_status', 'company', 'industry', 'size', 'score', 'looot_cost_usd'] },
    trigger: 'Webhook with {"email", "name"}',
    apps: ['Webhooks', 'OpenAI', 'Google Sheets', 'Slack', 'looot'],
    cost: 'under $0.01 per signup',
    flow: [
      webhook(1),
      looot(2, 'verifyEmail', { email: '{{1.email}}', fallback: true, maxCostUsd: 0.01, wait: 20 }),
      looot(3, 'enrichCompany', { domain: domainOf('1.email'), fallback: true, maxCostUsd: 0.01, wait: 20 }, filter('Work email',
        { a: '{{1.email}}', o: 'text:notcontain', b: '@gmail.' }, { a: '{{1.email}}', o: 'text:notcontain', b: '@yahoo.' },
        { a: '{{1.email}}', o: 'text:notcontain', b: '@hotmail.' }, { a: '{{1.email}}', o: 'text:notcontain', b: '@outlook.' })),
      openai(4, 'Score this signup for a B2B SaaS that sells to sales teams at companies with 20 to 500 employees. Reply with one word: hot, warm or cold.\n\nEmail status: {{2.emailStatus}}\nCompany: {{3.companyName}}, industry {{3.industry}}, size {{3.size}}'),
      router(5, [
        [addRow(6, 'Signups', { 0: '{{1.email}}', 1: '{{2.emailStatus}}', 2: '{{3.companyName}}', 3: '{{3.industry}}', 4: '{{3.size}}', 5: '{{lower(trim(4.result))}}', 6: '{{2.actualCost + 3.actualCost}}' })],
        [slack(7, 'Hot signup: {{1.name}} <{{1.email}}> at {{3.companyName}} ({{3.size}}, {{3.industry}})', filter('Hot', { a: '{{lower(4.result)}}', o: 'text:contain', b: 'hot' }))],
      ]),
    ],
  },
  {
    slug: 'pre-call-brief-to-slack',
    title: 'Send a pre-call company brief to Slack with looot company data, news and LinkedIn posts',
    scenarioDescription: 'For a company domain and LinkedIn page, looot pulls company data, news and recent posts, and OpenAI writes a 150 word brief.',
    description: 'Before a sales call, send the company domain and its LinkedIn company page to the webhook. looot returns company data, recent Google News articles and the latest LinkedIn company posts, and OpenAI writes a brief under 150 words with two talking points. The brief goes to Slack. One looot connection replaces the Clearbit and RapidAPI accounts. Cost: about $0.01 per company, capped at $0.03.',
    trigger: 'Webhook with {"domain", "linkedin_url", "meeting"}',
    apps: ['Webhooks', 'OpenAI', 'Slack', 'looot'],
    cost: 'about $0.01 per company',
    before: { label: 'n8n #2125 Summarize social media activity of a company before a call (10,796 views)', url: 'https://n8n.io/workflows/2125', nodes: 18, dataAccounts: 2 },
    gaps: 'Starts from a webhook instead of Google Calendar and leaves out X posts. Replace the webhook with Google Calendar Watch events if you want it on every meeting.',
    flow: [
      webhook(1),
      looot(2, 'enrichCompany', { domain: '{{1.domain}}', fallback: true, maxCostUsd: 0.01, wait: 20 }),
      run(3, 'job:news.search', '{"query": "{{ifempty(2.companyName; 1.domain)}}"}', 0.01),
      run(4, 'job:linkedin.company.posts', '{"url": "{{1.linkedin_url}}"}', 0.01),
      openai(5, 'Write a pre-call brief under 150 words: who they are in one line, what they posted or announced lately, and 2 talking points. Only use the data below.\n\nCompany: {{toString(2.result)}}\n\nNews: {{substring(toString(3.result); 0; 4000)}}\n\nLinkedIn posts: {{substring(toString(4.result); 0; 4000)}}'),
      slack(6, '*Brief for {{1.meeting}}: {{ifempty(2.companyName; 1.domain)}}*\n{{5.result}}'),
    ],
  },
  {
    slug: 'linkedin-urls-to-emails',
    title: 'Find and verify work emails from LinkedIn profile URLs in Google Sheets with looot',
    scenarioDescription: 'For each new LinkedIn profile URL, looot finds the work email, verifies it and writes both to the row.',
    description: 'Paste LinkedIn profile URLs into the Profiles sheet. looot finds the work email from the profile, trying the next email finder when one misses, verifies the address and writes the email, its status and the cost back to the row. A miss costs $0. Cost: about $0.005 per found and verified email, capped at $0.06.',
    sheets: { Profiles: ['linkedin_url', 'email', 'email_status', 'looot_cost_usd'] },
    trigger: 'Google Sheets, new rows in Profiles',
    apps: ['Google Sheets', 'looot'],
    cost: 'about $0.005 per found email',
    flow: [
      watchRows(1, 'Profiles', 50),
      looot(2, 'findWorkEmail', { linkedin_url: col(1, 0), fallback: true, maxCostUsd: 0.05, wait: 20 }),
      looot(3, 'verifyEmail', { email: '{{2.email}}', fallback: true, maxCostUsd: 0.01, wait: 20 }, filter('Email found', exists('{{2.email}}'))),
      updateRow(4, 1, { 1: '{{2.email}}', 2: '{{3.emailStatus}}', 3: '{{2.actualCost + 3.actualCost}}' }),
    ],
  },
  {
    slug: 'run-spend-log',
    title: 'Log every finished looot run and its cost in Google Sheets',
    scenarioDescription: 'Adds a row per finished looot run with the endpoint, provider, status and cost, so spend is visible in one sheet.',
    description: 'Watches your looot workspace for runs that reach a final status and adds one row per run to the Runs sheet: run id, endpoint, provider, status, cost and time. It covers runs from every tool that uses your looot token, not only Make. The trigger itself is free.',
    sheets: { Runs: ['run_id', 'endpoint_id', 'provider_id', 'status', 'cost_usd', 'completed_at'] },
    trigger: 'looot, Watch finished runs',
    apps: ['looot', 'Google Sheets'],
    cost: 'free',
    flow: [
      { ...looot(1, 'watchFinishedRuns', {}), parameters: { limit: 50 } },
      addRow(2, 'Runs', { 0: '{{1.runId}}', 1: '{{1.endpointId}}', 2: '{{1.providerId}}', 3: '{{1.status}}', 4: '{{1.actualCost}}', 5: '{{1.completedAt}}' }),
    ],
  },
];

// ---- blueprint shape ---------------------------------------------------------------------------------
const place = (flow, x0, y) => {
  let x = x0;
  for (const m of flow) {
    m.metadata = { designer: { x, y } };
    if (m.routes) m.routes.forEach((r, i) => place(r.flow, x + 300, y + i * 300));
    x += 300;
  }
  return flow;
};

export const countModules = (flow) => flow.reduce((n, m) => n + 1 + (m.routes ? m.routes.reduce((k, r) => k + countModules(r.flow), 0) : 0), 0);

export const blueprintOf = (t) => ({
  name: t.title,
  flow: place(structuredClone(t.flow), 0, 0),
  metadata: {
    instant: t.flow[0].module === 'gateway:CustomWebHook',
    version: 1,
    scenario: { roundtrips: 1, maxErrors: 3, autoCommit: true, autoCommitTriggerLast: true, sequential: false, confidential: false, dataloss: false, dlq: false, freshVariables: false },
    designer: { orphans: [] },
  },
});

const usesLooot = (flow) => flow.some((m) => m.module.startsWith(APP) || (m.routes && m.routes.some((r) => usesLooot(r.flow))));

const readme = () => {
  const rows = TEMPLATES.map((t) => {
    const n = countModules(t.flow);
    const before = t.before ? `[${t.before.label}](${t.before.url}): ${t.before.nodes} nodes / ${n} modules, ${t.before.dataAccounts} data accounts / 1` : 'new, no original to count';
    return `| [${t.slug}](${t.slug}/blueprint.json) | ${t.title} | ${t.trigger} | ${n} | ${t.cost} | ${before} |`;
  });
  const sheetNotes = TEMPLATES.filter((t) => t.sheets || t.gaps).map((t) => {
    const parts = [];
    if (t.sheets) parts.push(...Object.entries(t.sheets).map(([s, h]) => `sheet \`${s}\` with headers ${h.map((x) => `\`${x}\``).join(', ')}`));
    if (t.gaps) parts.push(`Leaves out: ${t.gaps}`);
    return `- **${t.slug}**. ${parts.join('. ')}.`;
  });
  return `# Make scenario templates for looot

${TEMPLATES.length} scenario blueprints for sales and marketing data jobs, built on the [looot custom app](../README.md). Each one is a \`blueprint.json\` you import with Scenarios > Create a new scenario > ... > Import blueprint. Every data call goes to looot: one connection and one prepaid balance, with a cost cap on each call and $0 for a miss.

Status: built from the module files in \`src/\` and checked by \`test/templates.test.mjs\`. None of them has run in Make yet, because the looot app is not in a Make account yet. Read "Not checked yet" before you rely on one.

| Template | What it does | Starts from | Modules | Usual cost | Before / after |
|---|---|---|---|---|---|
${rows.join('\n')}

Before and after counts only appear where an n8n gallery template does the same job. The n8n numbers come from that template's JSON on 2026-10-31, sticky notes not counted. A Make module and an n8n node are not the same unit, so read the column as "how many steps you wire up". Prices are the cheapest provider in looot's public catalog (\`https://api.looot.ai/v1/catalog/overview?depth=jobs\`) on 2026-10-31.

## Import one

1. Install the looot app in your Make organization (invite link, or \`node scripts/import.mjs --apply\`, see the main README).
2. Make gives the app its own id, shown in the app's URL and in any blueprint you export from it. Rewrite the blueprints to that id:
   \`\`\`bash
   node templates/set-app-id.mjs looot-abc123      # your id; rewrites app#looot: in every blueprint
   \`\`\`
3. In Make: Scenarios > Create a new scenario > ... (bottom bar) > Import blueprint, pick the file.
4. Open each module and pick or create the connection (looot, Google, OpenAI, Slack, HubSpot). Replace every \`YOUR_...\` value: spreadsheet, channel, competitor or company name.
5. Run once, check the destination, then set the schedule. Webhook scenarios run on each request; the others need a schedule (every 15 minutes for sheets, daily for the news and hiring ones).

Sheets and what each template leaves out:

${sheetNotes.join('\n')}

## Not checked yet

- No blueprint has been imported or run in Make. Module names and versions for Google Sheets, Slack, HubSpot, OpenAI, Webhooks, JSON, the iterator, the router and the text aggregator come from Make's own examples in \`integromat/make-skills\` (read 2026-10-31). Make may ask you to re-pick a field after import.
- The \`app#looot\` prefix is how Make writes custom app modules in a blueprint. Whether an approved, public looot app keeps that prefix is not known yet.
- The run module's Input is JSON text, which the module parses and sends as an object. A mapped value that contains a double quote breaks that JSON. Clean such values with \`replace()\` first.
- Paths such as \`{{2.result.organic}}\` depend on the provider that answered. The templates pass \`toString(result)\` to OpenAI where the shape varies.
- The HubSpot \`company\` and \`website\` fields and OpenAI's \`json_object\` response format are taken from the apps' usual field names, not read from Make.

## Rebuild

\`\`\`bash
node templates/build.mjs     # writes every blueprint.json and this README
npm test                     # includes test/templates.test.mjs
\`\`\`
`;
};

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  for (const t of TEMPLATES) {
    if (!usesLooot(t.flow)) throw new Error(`${t.slug} has no looot module`);
    await mkdir(path.join(DIR, t.slug), { recursive: true });
    await writeFile(path.join(DIR, t.slug, 'blueprint.json'), JSON.stringify(blueprintOf(t), null, 2) + '\n');
  }
  await writeFile(path.join(DIR, 'README.md'), readme());
  console.log(`wrote ${TEMPLATES.length} blueprints`);
}
